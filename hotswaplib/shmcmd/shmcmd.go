// Package shmcmd is the WRITER side of the force-write command mailbox in the
// PLC variable segment (SHM layout v2). KronServer (target) and the host agent
// (local hot-swap simulation) both use it, so the two can never disagree on the
// protocol. The consumer is generated C (CTranspilerService.js,
// generateShmMailbox); the byte contract is server/RING_FORMAT.md §
// "Variable segment" and § "Force-write mailbox".
//
// Why a mailbox: writers used to store the value into the data slot and then set
// the force-flag byte. A plc_shm_sync landing between the two stores overwrote
// the new value, the flag then pinned the OLD one, and the request still
// returned 200. Now a writer never touches a slot or a flag: it posts a command,
// the runtime applies it at a scan boundary and acknowledges it, and only the
// ack turns into a success.
//
// Segment layout (all integers little-endian):
//
//	[0, 32768)          data slots, naturally aligned (offsets from the table)
//	[32768, 61440)      one flag byte per variable index — RUNTIME-OWNED
//	[61440, 65536)      mailbox: 64-byte header + Capacity × 32-byte entries
//
// Header (at MailboxBase):
//
//	+0  u32 magic "KRMB"     runtime, published LAST at init (release)
//	+4  u16 version (2)      runtime
//	+6  u16 header bytes     runtime (64)
//	+8  u32 capacity         runtime (64)
//	+12 u32 entry bytes      runtime (32)
//	+16 u32 nvars            runtime — valid indices are [0, nvars)
//	+20 u32 consumer lock    runtime-private try-lock (task threads)
//	+24 u64 head             WRITER — last posted seq
//	+32 u64 ack              runtime — last consumed seq (release)
//	+40 u32 reserved
//	+44 u32 foreign flags    runtime — count of flag bytes an outdated writer set
//
// Entry (at MailboxBase + 64 + (seq % capacity) × 32):
//
//	+0  u64 seq      writer, published LAST (release); == seq ⇔ entry valid
//	+8  u32 index    variable index = force_flag_offset - ForceFlagsBase
//	+12 u32 status   0 pending → runtime CAS 1 (claimed) → final status;
//	                 a writer that times out CASes 0 → Cancelled instead
//	+16 u8  op       Force / Pulse / Unforce / ClearAll
//	+17 u8  size     value bytes (must equal the variable's size)
//	+18 u8  has      Unforce only: 1 = also write the value once
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
	LayoutVersion  = 2
	SegmentSize    = 65536
	ForceFlagsBase = 32768
	MailboxBase    = 61440
	HeaderBytes    = 64
	Capacity       = 64
	EntryBytes     = 32
	Magic          = 0x424D524B // "KRMB"
	// FlagForced is the only non-zero flag value a v2 runtime writes. Any
	// other non-zero byte was set by an outdated (v1) writer.
	FlagForced = 0x81

	offMagic   = 0
	offVersion = 4
	offHdrLen  = 6
	offCap     = 8
	offEntry   = 12
	offNvars   = 16
	offHead    = 24
	offAck     = 32
	offForeign = 44

	entSeq    = 0
	entIndex  = 8
	entStatus = 12
	entOp     = 16
	entSize   = 17
	entHas    = 18
	entValue  = 24

	// ClearAllIndex is the index carried by an OpClearAll command (ignored).
	ClearAllIndex = 0xFFFFFFFF
)

// Op is a mailbox command.
type Op uint8

const (
	OpForce    Op = 1 // write once AND hold (re-injected every scan)
	OpPulse    Op = 2 // write once, logic owns the value from the same scan
	OpUnforce  Op = 3 // release the hold; with a value, also write it once
	OpClearAll Op = 4 // release every hold
)

// ParseOp maps the API spelling ("force", "pulse", "unforce"; "" = force).
func ParseOp(s string) (Op, error) {
	switch s {
	case "", "force":
		return OpForce, nil
	case "pulse":
		return OpPulse, nil
	case "unforce", "release":
		return OpUnforce, nil
	}
	return 0, fmt.Errorf("unknown write mode %q (want force, pulse or unforce)", s)
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

// Command is one request.
type Command struct {
	Index uint32 // variable index (force_flag_offset - ForceFlagsBase)
	Op    Op
	Value []byte // little-endian scalar, 1/2/4/8 bytes; empty for OpClearAll / a bare OpUnforce
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

// Probe checks that a v2 runtime has initialised the mailbox.
func (m *Mailbox) Probe() error {
	return m.probe()
}

func (m *Mailbox) probe() error {
	mag := atomic.LoadUint32(m.u32p(MailboxBase + offMagic))
	if mag == 0 {
		return errf(KindNotReady, "the PLC runtime has not initialised the force-write mailbox: it is still starting, or it predates SHM layout v%d (rebuild it: Build & Send, or restart the simulation)", LayoutVersion)
	}
	if mag != Magic {
		return errf(KindMismatch, "runtime/server protocol mismatch: no force-write mailbox at 0x%x (found 0x%08x) — redeploy KronServer (server/build.sh + Deploy Server to Target) and Build & Send so both are current", MailboxBase, mag)
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

// ForeignFlagWrites is how many flag bytes an outdated writer set directly
// (the runtime ignored and cleared each one).
func (m *Mailbox) ForeignFlagWrites() uint32 {
	return atomic.LoadUint32(m.u32p(MailboxBase + offForeign))
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
	switch cmd.Op {
	case OpForce, OpPulse:
		if n := len(cmd.Value); n != 1 && n != 2 && n != 4 && n != 8 {
			return errf(KindInvalid, "value must be 1, 2, 4 or 8 bytes (got %d)", n)
		}
	case OpUnforce:
		if n := len(cmd.Value); n != 0 && n != 1 && n != 2 && n != 4 && n != 8 {
			return errf(KindInvalid, "value must be empty or 1, 2, 4 or 8 bytes (got %d)", n)
		}
	case OpClearAll:
		cmd.Index = ClearAllIndex
		cmd.Value = nil
	default:
		return errf(KindInvalid, "unknown op %d", cmd.Op)
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	// A runtime that was JUST started publishes the mailbox from its init a
	// few ms later (the editor force-writes pin defaults right after Start),
	// so "not initialised" is waited out while the process is alive — and
	// only then reported, as a runtime that predates layout v2.
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
	if cmd.Op != OpClearAll {
		if nv := atomic.LoadUint32(m.u32p(MailboxBase + offNvars)); cmd.Index >= nv {
			return 0, errf(KindInvalid, "variable index %d outside the runtime's %d variables — the deployed variable table does not match the running program (Build & Send)", cmd.Index, nv)
		}
	}
	headP, ackP := m.u64p(MailboxBase+offHead), m.u64p(MailboxBase+offAck)
	head, ack := atomic.LoadUint64(headP), atomic.LoadUint64(ackP)
	if head < ack { // a runtime (re)init caught up past us — resume from its cursor
		head = ack
	}
	if head-ack >= Capacity {
		return 0, errf(KindFull, "force-write mailbox full (%d commands pending): the runtime is not consuming fast enough", head-ack)
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
	has := byte(0)
	if len(cmd.Value) > 0 {
		has = 1
	}
	// op/size/has share one aligned word (+16..+19), stored atomically.
	atomic.StoreUint32(m.u32p(e+entOp), uint32(cmd.Op)|uint32(len(cmd.Value))<<8|uint32(has)<<16)
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
				return errf(KindTimeout, "runtime not consuming: the force-write was not acknowledged within %v (stalled runtime, or no task is scanning) — not applied", timeout)
			}
			// The runtime CLAIMED it just now: it is mid-apply, the ack follows.
			grace := time.Now().Add(250 * time.Millisecond)
			for atomic.LoadUint64(ackP) < seq {
				if time.Now().After(grace) {
					return errf(KindTimeout, "runtime claimed the force-write but did not acknowledge it within %v — outcome unknown", timeout+250*time.Millisecond)
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
		return errf(KindTimeout, "force-write was cancelled")
	case stPending, stClaimed:
		// ack published before the status — impossible with a v2 runtime.
		return errf(KindMismatch, "runtime acknowledged without a status — runtime/server protocol mismatch, redeploy KronServer and Build & Send")
	}
	return errf(KindRejected, "runtime returned unknown status %d", st)
}

// ClearFlags zeroes every force-flag byte below the mailbox. ONLY valid while
// no runtime runs (the runtime owns the flags) — KronServer's pre-start hook
// and a ClearAllForces on a stopped runtime.
func ClearFlags(mem []byte, keep func(off int) bool) int {
	end := MailboxBase
	if end > len(mem) {
		end = len(mem)
	}
	n := 0
	for i := ForceFlagsBase; i < end; i++ {
		if keep != nil && keep(i) {
			continue
		}
		if mem[i] != 0 {
			mem[i] = 0
			n++
		}
	}
	return n
}

// FlagIsForced reports whether a force-flag byte marks a HELD value: the v2
// runtime's FlagForced, or 1 — the FORCE value an outdated (v1) runtime still
// stores. v1's PULSE (2) is a one-scan transient and not a force.
func FlagIsForced(b byte) bool { return b == FlagForced || b == 1 }

// IsForced reads the flag byte at off (a single byte load — never torn) and
// reports whether that variable is forced. Out-of-range or non-flag offsets
// (0 = the table carries no flag) report false.
func IsForced(mem []byte, off int) bool {
	if off < ForceFlagsBase || off >= MailboxBase || off >= len(mem) {
		return false
	}
	return FlagIsForced(mem[off])
}

func leU64(b []byte) uint64 {
	return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
}

// LoadScalar copies an n-byte little-endian scalar out of a mapped segment with
// ONE atomic access when n is 4 or 8 and off is n-aligned (SHM layout v2
// guarantees both for every slot). A 1- or 2-byte aligned load is a single
// access on every supported CPU. An unaligned slot (a v1 table) falls back to a
// byte copy — which is exactly as torn as v1 always was.
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
