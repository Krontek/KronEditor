// Package shmcmd is the WRITER side of the write-command mailbox in the PLC
// variable segment (SHM layout v3). KronServer (target) and the host agent
// (local hot-swap simulation) both use it, so the two can never disagree on the
// protocol. The consumer is generated C (CTranspilerService.js,
// generateShmMailbox); the byte contract is server/RING_FORMAT.md §
// "Variable segment" and § "Write mailbox".
//
// Why a mailbox: a writer storing straight into the data slot races the
// runtime's plc_shm_sync, which overwrites the slot from PlcState every scan —
// the write was lost while the request returned 200. Now a writer never touches
// a slot: it posts a command, the runtime writes PlcState (and the slot) at a
// scan boundary and acknowledges it, and only the ack turns into a success.
// There is exactly ONE command, a one-shot write: the logic owns the value
// again from that same scan. (Forcing — holding a value against the logic —
// was removed in v3.)
//
// Segment layout (all integers little-endian):
//
//	[0, 61440)          data slots, naturally aligned (offsets from the table)
//	[61440, 65536)      mailbox: 64-byte header + Capacity × 32-byte entries
//
// Header (at MailboxBase):
//
//	+0  u32 magic "KRMB"     runtime, published LAST at init (release)
//	+4  u16 version (3)      runtime
//	+6  u16 header bytes     runtime (64)
//	+8  u32 capacity         runtime (64)
//	+12 u32 entry bytes      runtime (32)
//	+16 u32 nvars            runtime — valid indices are [0, nvars)
//	+20 u32 consumer lock    runtime-private try-lock (task threads)
//	+24 u64 head             WRITER — last posted seq
//	+32 u64 ack              runtime — last consumed seq (release)
//	+40 u64 reserved
//
// Entry (at MailboxBase + 64 + (seq % capacity) × 32):
//
//	+0  u64 seq      writer, published LAST (release); == seq ⇔ entry valid
//	+8  u32 index    variable index = the table's mb_index
//	+12 u32 status   0 pending → runtime CAS 1 (claimed) → final status;
//	                 a writer that times out CASes 0 → Cancelled instead
//	+16 u8  op       OpWrite (the only one)
//	+17 u8  size     value bytes (must equal the variable's size)
//	+18 u8  reserved (0)
//	+24 u8[8] value  little-endian scalar
package shmcmd

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// Layout constants — must match CTranspilerService.js (SHM_* constants).
const (
	LayoutVersion = 3
	SegmentSize   = 65536
	MailboxBase   = 61440
	// DataEnd bounds the data slots: [0, DataEnd). The v2 force-flag region
	// [32768, 61440) is data space since v3.
	DataEnd     = MailboxBase
	HeaderBytes = 64
	Capacity    = 64
	EntryBytes  = 32
	Magic       = 0x424D524B // "KRMB"

	offMagic   = 0
	offVersion = 4
	offHdrLen  = 6
	offCap     = 8
	offEntry   = 12
	offNvars   = 16
	offHead    = 24
	offAck     = 32

	entSeq    = 0
	entIndex  = 8
	entStatus = 12
	entOp     = 16
	entSize   = 17
	entValue  = 24

	// OpWrite is the mailbox's only command: write the value once; the logic
	// owns it again from the same scan. Code 2 = v2's PULSE, the same meaning.
	OpWrite = 2
)

// CheckWriteMode refuses the v2 force API's "mode" field (force / pulse /
// unforce): forcing was removed, and silently degrading a FORCE request to a
// one-shot write would report success for something that did not happen.
// Empty and "write" are accepted.
func CheckWriteMode(mode string) error {
	switch mode {
	case "", "write":
		return nil
	}
	return fmt.Errorf("write mode %q is not supported: forcing was removed — every write is a one-shot write (omit \"mode\")", mode)
}

// Entry status words.
const (
	stPending   = 0
	stClaimed   = 1
	stApplied   = 2
	stBadIndex  = 3
	stBadSize   = 4
	stReadOnly  = 5
	stBadOp     = 6
	stCancelled = 0xFFFFFFFF
)

// Kind classifies a failed post, so each transport can map it to its own code.
type Kind int

const (
	KindNotRunning Kind = iota + 1 // runtime process not running
	KindNotReady                   // mailbox not initialised (starting, or a v1 runtime)
	KindMismatch                   // protocol/layout version differs
	KindFull                       // too many commands pending
	KindTimeout                    // runtime did not acknowledge in time
	KindRejected                   // runtime refused the command (bad index/size/read-only)
	KindInvalid                    // the caller's command is malformed
)

// Error is every failure Post returns.
type Error struct {
	Kind Kind
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// KindOf returns the Kind of err, or 0 when err is not a *Error.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return 0
}

// HTTPStatus maps an error to the status an HTTP endpoint should return.
func HTTPStatus(err error) int {
	switch KindOf(err) {
	case KindNotRunning, KindNotReady, KindMismatch:
		return 409
	case KindFull:
		return 503
	case KindTimeout:
		return 504
	case KindRejected, KindInvalid:
		return 400
	}
	return 500
}

func errf(k Kind, format string, a ...any) error {
	return &Error{Kind: k, Msg: fmt.Sprintf(format, a...)}
}

// Command is one write request.
type Command struct {
	Index uint32 // variable index (the table's mb_index)
	Value []byte // little-endian scalar, 1/2/4/8 bytes
}

// WaitOptions bounds the wait for the runtime's ack.
type WaitOptions struct {
	Timeout time.Duration // 0 → DefaultTimeout
	// Alive reports whether the runtime process still runs. Polled while
	// waiting, so a stop turns into a clear error instead of a full timeout.
	// Must not take any lock the caller holds across Post.
	Alive func() bool
}

const (
	DefaultTimeout = 1 * time.Second
	minTimeout     = 250 * time.Millisecond
	maxTimeout     = 2 * time.Second
)

// TimeoutFor is the ack timeout for a project whose slowest task runs every
// maxIntervalUs: two scans plus margin, clamped to [250 ms, 2 s]. Every task
// drains the mailbox, so this is generous; the cap keeps an HTTP request from
// hanging on a project with a multi-second task.
func TimeoutFor(maxIntervalUs int64) time.Duration {
	if maxIntervalUs <= 0 {
		return DefaultTimeout
	}
	d := 2*time.Duration(maxIntervalUs)*time.Microsecond + 100*time.Millisecond
	if d < minTimeout {
		d = minTimeout
	}
	if d > maxTimeout {
		d = maxTimeout
	}
	return d
}

// Mailbox is a writer handle over a mapped variable segment. All writers in
// one process must share ONE Mailbox (the mutex serialises them); there is
// exactly one writer process per segment (KronServer on target, the host agent
// for the local simulation).
type Mailbox struct {
	mu  sync.Mutex
	mem []byte
}

// New wraps a mapped segment of at least SegmentSize bytes whose base is
// 8-byte aligned (mmap and MapViewOfFile return page-aligned memory).
func New(mem []byte) (*Mailbox, error) {
	if len(mem) < SegmentSize {
		return nil, fmt.Errorf("variable segment is %d bytes, need %d", len(mem), SegmentSize)
	}
	if uintptr(unsafe.Pointer(&mem[0]))%8 != 0 {
		return nil, fmt.Errorf("variable segment base is not 8-byte aligned")
	}
	return &Mailbox{mem: mem}, nil
}

func (m *Mailbox) u32p(off int) *uint32 { return (*uint32)(unsafe.Pointer(&m.mem[off])) }
func (m *Mailbox) u64p(off int) *uint64 { return (*uint64)(unsafe.Pointer(&m.mem[off])) }
func (m *Mailbox) u16(off int) uint16 {
	// Single aligned 16-bit load; written once at init before the magic.
	return *(*uint16)(unsafe.Pointer(&m.mem[off]))
}

// Probe checks that a v3 runtime has initialised the mailbox.
func (m *Mailbox) Probe() error {
	return m.probe()
}

func (m *Mailbox) probe() error {
	mag := atomic.LoadUint32(m.u32p(MailboxBase + offMagic))
	if mag == 0 {
		return errf(KindNotReady, "the PLC runtime has not initialised the write mailbox: it is still starting, or it predates SHM layout v%d (rebuild it: Build & Send, or restart the simulation)", LayoutVersion)
	}
	if mag != Magic {
		return errf(KindMismatch, "runtime/server protocol mismatch: no write mailbox at 0x%x (found 0x%08x) — redeploy KronServer (server/build.sh + Deploy Server to Target) and Build & Send so both are current", MailboxBase, mag)
	}
	if v := m.u16(MailboxBase + offVersion); v != LayoutVersion {
		return errf(KindMismatch, "runtime/server protocol mismatch: the runtime speaks SHM layout v%d, this writer v%d — redeploy KronServer (server/build.sh + Deploy Server to Target) and Build & Send so both match", v, LayoutVersion)
	}
	if c := atomic.LoadUint32(m.u32p(MailboxBase + offCap)); c != Capacity {
		return errf(KindMismatch, "runtime/server protocol mismatch: mailbox capacity %d, expected %d — redeploy KronServer and Build & Send", c, Capacity)
	}
	if e := atomic.LoadUint32(m.u32p(MailboxBase + offEntry)); e != EntryBytes {
		return errf(KindMismatch, "runtime/server protocol mismatch: mailbox entry size %d, expected %d — redeploy KronServer and Build & Send", e, EntryBytes)
	}
	return nil
}

// Pending is the number of posted-but-unacknowledged commands.
func (m *Mailbox) Pending() uint64 {
	h := atomic.LoadUint64(m.u64p(MailboxBase + offHead))
	a := atomic.LoadUint64(m.u64p(MailboxBase + offAck))
	if h <= a {
		return 0
	}
	return h - a
}

// Reset unpublishes the mailbox and drops everything pending. Only for a
// moment when NO runtime runs (KronServer's pre-start hook): the next runtime
// re-initialises the header and publishes the magic itself, and a command
// posted against the previous table must never reach it.
func (m *Mailbox) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	atomic.StoreUint32(m.u32p(MailboxBase+offMagic), 0)
	h := atomic.LoadUint64(m.u64p(MailboxBase + offHead))
	atomic.StoreUint64(m.u64p(MailboxBase+offAck), h)
	atomic.StoreUint32(m.u32p(MailboxBase+20), 0)
}

// Post sends cmd and waits until the runtime has applied it. nil means the
// runtime acknowledged AND applied it; every failure is an *Error.
func (m *Mailbox) Post(cmd Command, opt WaitOptions) error {
	if opt.Alive != nil && !opt.Alive() {
		return errf(KindNotRunning, "PLC runtime is not running")
	}
	if n := len(cmd.Value); n != 1 && n != 2 && n != 4 && n != 8 {
		return errf(KindInvalid, "value must be 1, 2, 4 or 8 bytes (got %d)", n)
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	// A runtime that was JUST started publishes the mailbox from its init a
	// few ms later (the editor writes pin defaults right after Start), so
	// "not initialised" is waited out while the process is alive — and only
	// then reported, as a runtime that predates layout v3.
	deadline := time.Now().Add(timeout)
	for {
		seq, err := m.post(cmd)
		if err == nil {
			return m.wait(seq, deadline, timeout, opt.Alive)
		}
		if KindOf(err) != KindNotReady || opt.Alive == nil || time.Now().After(deadline) {
			return err
		}
		if !opt.Alive() {
			return errf(KindNotRunning, "PLC runtime is not running")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (m *Mailbox) post(cmd Command) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.probe(); err != nil {
		return 0, err
	}
	if nv := atomic.LoadUint32(m.u32p(MailboxBase + offNvars)); cmd.Index >= nv {
		return 0, errf(KindInvalid, "variable index %d outside the runtime's %d variables — the deployed variable table does not match the running program (Build & Send)", cmd.Index, nv)
	}
	headP, ackP := m.u64p(MailboxBase+offHead), m.u64p(MailboxBase+offAck)
	head, ack := atomic.LoadUint64(headP), atomic.LoadUint64(ackP)
	if head < ack { // a runtime (re)init caught up past us — resume from its cursor
		head = ack
	}
	if head-ack >= Capacity {
		return 0, errf(KindFull, "write mailbox full (%d commands pending): the runtime is not consuming fast enough", head-ack)
	}
	seq := head + 1
	e := MailboxBase + HeaderBytes + int(seq%Capacity)*EntryBytes
	// Unpublish first: the slot still carries seq-Capacity, which the
	// consumer can no longer match, but make the intent explicit.
	atomic.StoreUint64(m.u64p(e+entSeq), 0)
	atomic.StoreUint32(m.u32p(e+entIndex), cmd.Index)
	atomic.StoreUint32(m.u32p(e+entStatus), stPending)
	var v [8]byte
	copy(v[:], cmd.Value)
	// op/size/reserved share one aligned word (+16..+19), stored atomically.
	atomic.StoreUint32(m.u32p(e+entOp), uint32(OpWrite)|uint32(len(cmd.Value))<<8)
	atomic.StoreUint64(m.u64p(e+entValue), leU64(v[:]))
	// ⚠️ seq is published LAST: Go atomics are sequentially consistent, so
	// the consumer's acquire load of seq sees every field above.
	atomic.StoreUint64(m.u64p(e+entSeq), seq)
	atomic.StoreUint64(headP, seq)
	return seq, nil
}

func (m *Mailbox) wait(seq uint64, deadline time.Time, timeout time.Duration, alive func() bool) error {
	e := MailboxBase + HeaderBytes + int(seq%Capacity)*EntryBytes
	ackP := m.u64p(MailboxBase + offAck)
	nextAlive := time.Now().Add(20 * time.Millisecond)
	sleep := 100 * time.Microsecond
	for {
		if atomic.LoadUint64(ackP) >= seq {
			return m.result(e, seq)
		}
		now := time.Now()
		if atomic.LoadUint32(m.u32p(MailboxBase+offMagic)) != Magic {
			// The runtime re-initialised (restart) and dropped everything pending.
			if m.cancel(e) {
				return errf(KindNotRunning, "the PLC runtime restarted before applying the write — not applied")
			}
		}
		if alive != nil && now.After(nextAlive) {
			nextAlive = now.Add(20 * time.Millisecond)
			if !alive() {
				if m.cancel(e) {
					return errf(KindNotRunning, "PLC runtime stopped before applying the write — not applied")
				}
			}
		}
		if now.After(deadline) {
			if m.cancel(e) {
				return errf(KindTimeout, "runtime not consuming: the write was not acknowledged within %v (stalled runtime, or no task is scanning) — not applied", timeout)
			}
			// The runtime CLAIMED it just now: it is mid-apply, the ack follows.
			grace := time.Now().Add(250 * time.Millisecond)
			for atomic.LoadUint64(ackP) < seq {
				if time.Now().After(grace) {
					return errf(KindTimeout, "runtime claimed the write but did not acknowledge it within %v — outcome unknown", timeout+250*time.Millisecond)
				}
				time.Sleep(200 * time.Microsecond)
			}
			return m.result(e, seq)
		}
		time.Sleep(sleep)
		if sleep < 2*time.Millisecond {
			sleep *= 2
		}
	}
}

// cancel withdraws a still-pending entry. false = the runtime claimed it first.
func (m *Mailbox) cancel(e int) bool {
	return atomic.CompareAndSwapUint32(m.u32p(e+entStatus), stPending, stCancelled)
}

func (m *Mailbox) result(e int, seq uint64) error {
	st := atomic.LoadUint32(m.u32p(e + entStatus))
	if atomic.LoadUint64(m.u64p(e+entSeq)) != seq {
		// Reused by a later lap after our ack — it was consumed; the outcome
		// word is gone, and a consumed command is an applied one unless the
		// runtime rejected it, which only a malformed table can cause.
		return nil
	}
	switch st {
	case stApplied:
		return nil
	case stBadIndex:
		return errf(KindRejected, "runtime rejected the write: unknown variable index (variable table and running program differ — Build & Send)")
	case stBadSize:
		return errf(KindRejected, "runtime rejected the write: value size does not match the variable (variable table and running program differ — Build & Send)")
	case stReadOnly:
		return errf(KindRejected, "runtime rejected the write: the variable is read-only (STRING)")
	case stBadOp:
		return errf(KindRejected, "runtime rejected the write: unknown command")
	case stCancelled:
		return errf(KindTimeout, "write was cancelled")
	case stPending, stClaimed:
		// ack published before the status — impossible with a v3 runtime.
		return errf(KindMismatch, "runtime acknowledged without a status — runtime/server protocol mismatch, redeploy KronServer and Build & Send")
	}
	return errf(KindRejected, "runtime returned unknown status %d", st)
}

func leU64(b []byte) uint64 {
	return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
}

// LoadScalar copies an n-byte little-endian scalar out of a mapped segment with
// ONE atomic access when n is 4 or 8 and off is n-aligned (SHM layout v2+
// guarantees both for every slot). A 1- or 2-byte aligned load is a single
// access on every supported CPU. An unaligned slot (a v1 table) falls back to a
// byte copy.
func LoadScalar(mem []byte, off, n int, dst []byte) {
	p := unsafe.Pointer(&mem[off])
	switch {
	case n == 8 && uintptr(p)%8 == 0:
		v := atomic.LoadUint64((*uint64)(p))
		for i := 0; i < 8; i++ {
			dst[i] = byte(v >> (8 * i))
		}
	case n == 4 && uintptr(p)%4 == 0:
		v := atomic.LoadUint32((*uint32)(p))
		for i := 0; i < 4; i++ {
			dst[i] = byte(v >> (8 * i))
		}
	case n == 2 && uintptr(p)%2 == 0:
		v := *(*uint16)(p)
		dst[0], dst[1] = byte(v), byte(v>>8)
	default:
		copy(dst[:n], mem[off:off+n])
	}
}

// StoreScalar is LoadScalar's counterpart, for the few places that still seed
// a slot directly (initial values while no runtime runs).
func StoreScalar(mem []byte, off int, src []byte) {
	n := len(src)
	p := unsafe.Pointer(&mem[off])
	switch {
	case n == 8 && uintptr(p)%8 == 0:
		atomic.StoreUint64((*uint64)(p), leU64(src))
	case n == 4 && uintptr(p)%4 == 0:
		atomic.StoreUint32((*uint32)(p), uint32(src[0])|uint32(src[1])<<8|uint32(src[2])<<16|uint32(src[3])<<24)
	default:
		copy(mem[off:off+n], src)
	}
}
