// ipc_ring.go — consumer side of the lossless capture ring.
//
// The PLC runtime (producer) appends every kept scan of a task's addressed
// variables into a second shared-memory segment (<shm-name>_ring). This reader
// drains those records in sequence, detects overwrite (lap) losses, and writes
// the decimation stride back into the header so the producer thins its output to
// whatever the delivery link can sustain.
//
// ⚠️ The byte layout is the contract in server/RING_FORMAT.md — it MUST stay in
// sync with the C codegen in src/services/CTranspilerService.js. Change all three
// together.
package main

import (
	"encoding/binary"
	"fmt"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	ringMagic       = 0x4B524E47 // "KRNG"
	ringHeaderBytes = 256
	ringMaxTasks    = (ringHeaderBytes - offTaskTable) / taskEntryBytes // 24

	// header field offsets
	offMagic        = 0
	offVersion      = 4
	offHeaderBytes  = 8
	offRecordStride = 12
	offNslots       = 16
	offTotalBytes   = 20
	offNtasks       = 24
	offFlags        = 28
	offWriteSeq     = 32
	offStrideN      = 40
	offEpoch        = 48
	offTaskTable    = 64
	taskEntryBytes  = 8

	// record field offsets (within a slot)
	recOffSeq        = 0
	recOffTaskID     = 8
	recOffPayloadLen = 10
	recOffScan       = 12 // v2: producer's per-task scan counter (low 32 bits); v1: reserved 0
	recOffPayload    = 16

	ringSeqEmpty = ^uint64(0) // 0xFFFF...  slot never written

	// wireRecordHeaderBytes is the per-record header the stream handler emits
	// (frame v2): u64 seq + u16 task_id + u16 payload_len + u32 scan. It equals
	// recOffPayload only by coincidence — the slot header is a ring layout, the
	// wire header a stream layout; keep them separate constants.
	wireRecordHeaderBytes = 16

	// ringStuckTimeout bounds how long a drain waits on ONE unpublished slot
	// while LATER sequences are already claimed. A producer killed between its
	// fetch_add and its seq store, or a slot punched by Reclaim (reads back 0),
	// never publishes — without this the stream stalls on it for ever.
	ringStuckTimeout = 100 * time.Millisecond
)

// ringTask mirrors one task_table entry.
type ringTask struct {
	PeriodUs   uint32
	PayloadLen uint16
	TaskID     uint16
}

// RingConsumer maps the ring segment and drains it. Safe for one draining
// goroutine per instance plus concurrent SetStrideN; open one per stream client.
type RingConsumer struct {
	mu   sync.Mutex
	path string
	fd   int
	mem  []byte

	// Header-derived layout, guarded by mu. It is RE-PARSED when the runtime
	// restarts (epoch bump) and rewrites the header with a different
	// record_stride/nslots/tasks — e.g. after a Build & Send that changed the
	// addressed-variable set. Without this, the agent would keep decoding the
	// new records with the old stride and every value past the first would be
	// garbage. parsedEpoch is the epoch the current layout was parsed under.
	recordStride int
	nslots       int
	tasks        []ringTask
	parsedEpoch  uint64

	// freedSeq is the sequence up to which consumed record pages have been
	// punched out of the tmpfs segment (Reclaim). It advances as ALL clients
	// drain, so the ring's resident memory tracks the live backlog instead of
	// pinning the whole segment — a fixed circular ring otherwise touches every
	// page within one lap and stays fully resident forever.
	freedSeq uint64
}

// fallocate modes (Linux) — punch a hole to release tmpfs pages without
// changing the file size.
const (
	fallocPunchHole = 0x02
	fallocKeepSize  = 0x01
)

// OpenRing maps /dev/shm/<shmName>_ring read-write and validates the header.
// Returns an error (not a panic) when the segment is absent or not yet
// initialised by the producer, so callers can report "capture not available".
func OpenRing(shmName string) (*RingConsumer, error) {
	path := "/dev/shm/" + shmName + "_ring"
	fd, err := syscall.Open(path, syscall.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("capture ring not available (%s): %w", path, err)
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("fstat ring: %w", err)
	}
	size := int(st.Size)
	if size < ringHeaderBytes {
		syscall.Close(fd)
		return nil, fmt.Errorf("capture ring too small (%d bytes) — producer not started yet", size)
	}
	mem, err := syscall.Mmap(fd, 0, size, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("mmap ring: %w", err)
	}
	rc := &RingConsumer{path: path, fd: fd, mem: mem}
	if err := rc.parseHeader(); err != nil {
		rc.Close()
		return nil, err
	}
	rc.parsedEpoch = rc.loadU64(offEpoch)
	return rc, nil
}

// syncLocked re-reads the header when the runtime restarted (epoch changed) and
// possibly re-mmaps if the segment was resized (a new KronServer pre-size). Must
// be called with rc.mu held; all other rc.mem access is under the same lock, so
// munmap here can never pull the map from under a concurrent reader.
func (rc *RingConsumer) syncLocked() {
	if rc.mem == nil {
		return
	}
	ep := rc.loadU64(offEpoch)
	if ep == rc.parsedEpoch {
		return
	}
	// segment may have grown/shrunk (runtime adopted a new pre-sized ring)
	var st syscall.Stat_t
	if err := syscall.Fstat(rc.fd, &st); err == nil {
		newSize := int(st.Size)
		if newSize >= ringHeaderBytes && newSize != len(rc.mem) {
			if nm, err := syscall.Mmap(rc.fd, 0, newSize,
				syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED); err == nil {
				syscall.Munmap(rc.mem)
				rc.mem = nm
			}
		}
	}
	if err := rc.parseHeader(); err == nil {
		rc.parsedEpoch = ep
		// New generation: forget the reclaim cursor. write_seq does NOT restart
		// (it continues monotonically across restarts, see RING_FORMAT.md);
		// Reclaim re-derives its lower bound from write_seq - nslots anyway.
		rc.freedSeq = 0
	}
}

// Resize (re)sizes the ring segment to `bytes` while this consumer has it
// mapped. KronServer pre-sizes the segment before every runtime start
// (createRingSegment via the pre-start hook) and the shared consumer stays
// mapped across restarts.
//
// ⚠️ A SHRINK under a live mapping is a SIGBUS: every page past the new EOF
// faults on the next touch, and a fault inside the Go runtime kills the whole
// agent. So the truncate happens under rc.mu (no drain can be mid-read), the
// mapping is cut down to the new size, and the parsed layout is INVALIDATED
// (nslots = 0) — the header still describes the old, larger segment until the
// new runtime rewrites it and bumps epoch, at which point syncLocked re-parses
// and validates it against the new mapping. A grow (or no change) leaves the
// mapping alone: the old layout stays fully inside it, and the epoch bump
// remaps to the new size as usual.
func (rc *RingConsumer) Resize(bytes uint64) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if err := createRingSegment(rc.shmName(), bytes); err != nil {
		return err
	}
	if rc.mem == nil || bytes >= uint64(len(rc.mem)) {
		return nil
	}
	// bytes < len(rc.mem) from here, so it fits an int even on 32-bit ARM.
	// Our fd may name an older inode than the path (a producer that unlinked and
	// recreated the segment): truncate it too, so the remap below is sized
	// against the file actually mapped.
	var st syscall.Stat_t
	if err := syscall.Fstat(rc.fd, &st); err == nil && int64(bytes) < st.Size {
		_ = syscall.Ftruncate(rc.fd, int64(bytes))
	}
	_ = syscall.Munmap(rc.mem)
	rc.mem = nil
	rc.invalidateLocked()
	nm, err := syscall.Mmap(rc.fd, 0, int(bytes), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		return fmt.Errorf("remap ring after resize: %w", err)
	}
	rc.mem = nm
	return nil
}

// invalidateLocked drops the parsed layout so Drain/Reclaim touch no slot until
// the next epoch re-parses a header that fits the mapping. parsedEpoch is kept:
// the runtime's epoch bump is exactly the signal to re-parse.
func (rc *RingConsumer) invalidateLocked() {
	rc.nslots = 0
	rc.recordStride = 0
	rc.tasks = nil
	rc.freedSeq = 0
}

// shmName recovers the base shm name from the segment path.
func (rc *RingConsumer) shmName() string {
	const prefix, suffix = "/dev/shm/", "_ring"
	name := rc.path
	if len(name) > len(prefix) && name[:len(prefix)] == prefix {
		name = name[len(prefix):]
	}
	if len(name) > len(suffix) && name[len(name)-len(suffix):] == suffix {
		name = name[:len(name)-len(suffix)]
	}
	return name
}

// Reclaim releases (punches holes in) the tmpfs pages of records already consumed
// by ALL clients (seq < minReadSeq), so the ring's resident memory tracks the
// live backlog. Safe against the wait-free producer: it only frees slots whose
// current content is both already-read (seq < minReadSeq) AND not yet overwritten
// (seq > write_seq - nslots); the producer re-faults a punched page when it laps
// back to write there. Call off the real-time path (~100 ms controller tick).
//
// ⚠️ `w` is a SNAPSHOT taken before a punch that can take a while on a large
// ring, and the producer keeps advancing meanwhile. A slot that was "oldest but
// still ours" at the snapshot may be rewritten with fresh data while we punch
// it, and a punched fresh record reads back as a hole (lost). reclaimMargin
// keeps a quarter of the ring between the punch range and the write cursor.
func (rc *RingConsumer) Reclaim(minReadSeq uint64) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.mem == nil || rc.nslots == 0 || rc.recordStride <= 0 {
		return
	}
	nslots := uint64(rc.nslots)
	w := rc.loadU64(offWriteSeq)
	lo := rc.freedSeq
	// never punch a slot the producer may have already overwritten with fresh
	// data, nor one it can reach before the punch completes
	if minSafe := w + nslots/4 + 1; minSafe > nslots {
		if minSafe -= nslots; lo < minSafe {
			lo = minSafe
		}
	}
	hi := minReadSeq
	if hi <= lo {
		return
	}
	count := hi - lo
	if count > nslots {
		count = nslots
	}
	startSlot := int(lo % nslots)
	stride := rc.recordStride
	if startSlot+int(count) <= rc.nslots {
		rc.punchRange(ringHeaderBytes+startSlot*stride, int(count)*stride)
	} else { // wraps once
		first := rc.nslots - startSlot
		rc.punchRange(ringHeaderBytes+startSlot*stride, first*stride)
		rc.punchRange(ringHeaderBytes, (int(count)-first)*stride)
	}
	rc.freedSeq = hi
}

// punchRange frees the tmpfs pages FULLY covered by [off, off+length), rounding
// INWARD to page boundaries so a page shared with a still-live slot is untouched.
func (rc *RingConsumer) punchRange(off, length int) {
	const page = 4096
	start := (off + page - 1) &^ (page - 1) // round up
	end := (off + length) &^ (page - 1)     // round down
	if end <= start {
		return
	}
	_ = syscall.Fallocate(rc.fd, fallocPunchHole|fallocKeepSize, int64(start), int64(end-start))
}

// ReclaimAll frees the entire records area — used on PAUSE, when the producer is
// stopped and nobody is reading, so the ring's RSS drops to ~0 while idle.
func (rc *RingConsumer) ReclaimAll() {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.mem == nil || rc.nslots == 0 || rc.recordStride <= 0 {
		return
	}
	_ = syscall.Fallocate(rc.fd, fallocPunchHole|fallocKeepSize,
		int64(ringHeaderBytes), int64(rc.nslots*rc.recordStride))
	rc.freedSeq = rc.loadU64(offWriteSeq)
}

func (rc *RingConsumer) u32(off int) uint32 { return binary.LittleEndian.Uint32(rc.mem[off:]) }
func (rc *RingConsumer) u16(off int) uint16 { return binary.LittleEndian.Uint16(rc.mem[off:]) }

// mapped reports whether [off, off+n) lies inside the current mapping. The
// header accessors are reachable while the mapping is being replaced (Resize),
// and an out-of-range read must answer 0, not panic the handler.
func (rc *RingConsumer) mapped(off, n int) bool { return off >= 0 && off+n <= len(rc.mem) }

func (rc *RingConsumer) parseHeader() error {
	if len(rc.mem) < ringHeaderBytes {
		return fmt.Errorf("ring smaller than header")
	}
	if m := rc.u32(offMagic); m != ringMagic {
		return fmt.Errorf("capture ring not initialised (magic 0x%08x) — producer not started yet", m)
	}
	rc.recordStride = int(rc.u32(offRecordStride))
	rc.nslots = int(rc.u32(offNslots))
	ntasks := int(rc.u32(offNtasks))
	total := int(rc.u32(offTotalBytes))
	if rc.recordStride < recOffPayload || rc.nslots <= 0 || ntasks < 0 || ntasks > ringMaxTasks {
		return fmt.Errorf("ring header invalid (stride=%d nslots=%d ntasks=%d)", rc.recordStride, rc.nslots, ntasks)
	}
	if ringHeaderBytes+rc.nslots*rc.recordStride > total || total > len(rc.mem) {
		return fmt.Errorf("ring header sizes exceed segment (total=%d mapped=%d)", total, len(rc.mem))
	}
	rc.tasks = rc.tasks[:0]
	for i := 0; i < ntasks; i++ {
		off := offTaskTable + i*taskEntryBytes
		rc.tasks = append(rc.tasks, ringTask{
			PeriodUs:   rc.u32(off),
			PayloadLen: rc.u16(off + 4),
			TaskID:     rc.u16(off + 6),
		})
	}
	return nil
}

// atomic accessors into the mmap. Header fields are 8-aligned by layout.
func (rc *RingConsumer) loadU64(off int) uint64 {
	if !rc.mapped(off, 8) {
		return 0
	}
	return atomic.LoadUint64((*uint64)(unsafe.Pointer(&rc.mem[off])))
}
func (rc *RingConsumer) loadU32(off int) uint32 {
	if !rc.mapped(off, 4) {
		return 0
	}
	return atomic.LoadUint32((*uint32)(unsafe.Pointer(&rc.mem[off])))
}
func (rc *RingConsumer) storeU32(off int, v uint32) {
	if !rc.mapped(off, 4) {
		return
	}
	atomic.StoreUint32((*uint32)(unsafe.Pointer(&rc.mem[off])), v)
}

// copyPayload copies a slot payload with 8-byte ATOMIC loads when the payload
// is 8-aligned (RING_FORMAT.md: header 256, record_stride = align8(...), payload
// at +16 — so it always is for a real producer). A plain copy may be split into
// arbitrary byte accesses racing the producer's stores; whole-word atomic loads
// at least never tear a naturally aligned 8-byte value, and the write_seq
// re-check in Drain discards a record whose slot was reclaimed meanwhile. The
// last word may read past payload_len, which stays inside the slot because
// record_stride is a multiple of 8. Unaligned layouts (test producers only)
// fall back to copy().
func (rc *RingConsumer) copyPayload(dst []byte, off, slotEnd int) {
	n := len(dst)
	if off%8 != 0 || off+(n+7)/8*8 > slotEnd {
		copy(dst, rc.mem[off:off+n])
		return
	}
	var w [8]byte
	for i := 0; i < n; i += 8 {
		v := atomic.LoadUint64((*uint64)(unsafe.Pointer(&rc.mem[off+i])))
		binary.LittleEndian.PutUint64(w[:], v)
		copy(dst[i:], w[:])
	}
}

// All accessors below lock rc.mu because syncLocked may re-mmap rc.mem when the
// runtime restarts; every mmap read must be serialized against that.
func (rc *RingConsumer) WriteSeq() uint64 {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.loadU64(offWriteSeq)
}

// Version is the producer's ring header version (1, or 2 = scan counter in
// every record). 0 while the layout is invalid.
func (rc *RingConsumer) Version() uint32 {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	if rc.nslots == 0 || !rc.mapped(offVersion, 4) {
		return 0
	}
	return rc.u32(offVersion)
}

func (rc *RingConsumer) Epoch() uint64 {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.loadU64(offEpoch)
}
func (rc *RingConsumer) StrideN() uint32 {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.loadU32(offStrideN)
}
func (rc *RingConsumer) Nslots() int {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	return rc.nslots
}
func (rc *RingConsumer) RecordStride() int {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	return rc.recordStride
}
func (rc *RingConsumer) Tasks() []ringTask {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	return rc.tasks
}

// SetStrideN publishes the global decimation stride to the producer.
// n == 0 is a valid value meaning PAUSED (the producer stops writing to the ring
// entirely — used when no consumer is connected); n >= 1 is the decimation stride.
func (rc *RingConsumer) SetStrideN(n uint32) {
	rc.mu.Lock()
	rc.storeU32(offStrideN, n)
	rc.mu.Unlock()
}

// ProducedBytesPerSec is Σ_g(payload_len_g / period_us_g) × 1e6 — the RAW
// production rate before decimation, from the task table.
func (rc *RingConsumer) ProducedBytesPerSec() float64 {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	var bps float64
	for _, t := range rc.tasks {
		if t.PeriodUs > 0 {
			bps += float64(t.PayloadLen) / float64(t.PeriodUs) * 1e6
		}
	}
	return bps
}

// WireBytesPerSec is the rate the ring's records would occupy ON THE WIRE:
// the 12-byte per-record stream header (seq + task_id + payload_len) plus the
// payload, summed over the tasks.
//
// ⚠️ This — not ProducedBytesPerSec — is what the decimation controller must
// compare against `D`, its measurement of delivered bytes/s, because D counts
// whole frames. Feeding it the payload-only rate understated production by
// (12+payload)/payload — 2.5x for a single 8-byte variable — so the analytic
// floor ceil(P/(alpha*D)) came out that much too low, the stride under-decimated,
// the backlog grew and the fill watermark then doubled the stride instead.
func (rc *RingConsumer) WireBytesPerSec() float64 {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	var bps float64
	for _, t := range rc.tasks {
		if t.PeriodUs > 0 {
			bps += float64(int(t.PayloadLen)+wireRecordHeaderBytes) / float64(t.PeriodUs) * 1e6
		}
	}
	return bps
}

// RingRecord is one drained sample. Payload is a private copy. Scan is the
// producer's scan counter for that task (0 from a v1 producer).
type RingRecord struct {
	Scan    uint32
	Seq     uint64
	TaskID  uint16
	Payload []byte
}

// RingCursor is one stream client's position in the ring plus the state the
// stuck-slot guard needs across drains. The zero value starts at seq 0.
type RingCursor struct {
	ReadSeq uint64

	stuckSeq   uint64    // the unpublished slot we are waiting on
	stuckSince time.Time // when we first saw stuckSeq unpublished (zero = none)
}

// Reset repositions the cursor (connect, epoch change) and forgets any wait.
func (c *RingCursor) Reset(seq uint64) {
	*c = RingCursor{ReadSeq: seq}
}

// Drain reads records with sequence in [readSeq, write_seq). It returns the new
// readSeq to pass next time, how many records were lost, and appends up to
// maxRecords freshly-read records to dst. It keeps no state between calls, so
// the stuck-slot guard is inactive — stream handlers use DrainCursor.
func (rc *RingConsumer) Drain(readSeq uint64, dst []RingRecord, maxRecords int) (uint64, uint64, []RingRecord) {
	cur := RingCursor{ReadSeq: readSeq}
	dropped, dst := rc.DrainCursor(&cur, dst, maxRecords, time.Now())
	return cur.ReadSeq, dropped, dst
}

// DrainCursor drains from cur.ReadSeq, advancing it, and returns how many
// records were LOST (never delivered) plus dst with up to maxRecords records
// appended. Every way a record can be lost is counted — `dropped` is the
// client's only honest signal that the stream has a hole:
//   - lapped before we got there (write_seq - readSeq > nslots);
//   - overwritten under us (slot.seq > s: the slot already holds a later lap);
//   - torn: the slot's next occupant (s + nslots) was CLAIMED while we copied
//     it, so the bytes may mix two records — discarded;
//   - stuck: slot s stayed unpublished for ringStuckTimeout while later
//     sequences were already claimed (crashed producer, punched slot).
//
// An unpublished slot that is the NEWEST claimed one is a producer mid-write:
// the drain stops there and retries next tick. Never blocks.
func (rc *RingConsumer) DrainCursor(cur *RingCursor, dst []RingRecord, maxRecords int, now time.Time) (uint64, []RingRecord) {
	// Hold the lock for the whole drain: syncLocked may re-mmap rc.mem (runtime
	// restart / resize), and the record loop reads rc.mem directly. ≤5 clients at
	// a 5 ms cadence, so the contention is negligible.
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.syncLocked()
	stride := rc.recordStride
	nslots := uint64(rc.nslots)
	if stride <= recOffPayload || nslots == 0 {
		return 0, dst
	}
	readSeq := cur.ReadSeq
	w := rc.loadU64(offWriteSeq)
	if w <= readSeq {
		return 0, dst
	}
	var dropped uint64
	if w-readSeq > nslots {
		dropped = (w - readSeq) - nslots
		readSeq = w - nslots // catch up to the oldest slot still present
	}
	got := 0
	for s := readSeq; s < w; s++ {
		if maxRecords > 0 && got >= maxRecords {
			break
		}
		base := ringHeaderBytes + int(s%nslots)*stride
		ss := rc.loadU64(base + recOffSeq)
		if ss != s {
			if ss > s && ss != ringSeqEmpty {
				// Already overwritten by a later lap: this record is gone.
				dropped++
				readSeq = s + 1
				continue
			}
			// Unpublished (ss < s, a hole reading 0, or a legacy 0xFF.. fill).
			if w > s+1 {
				if cur.stuckSince.IsZero() || cur.stuckSeq != s {
					cur.stuckSeq, cur.stuckSince = s, now
				} else if now.Sub(cur.stuckSince) >= ringStuckTimeout {
					dropped++
					readSeq = s + 1
					cur.stuckSince = time.Time{}
					continue
				}
			}
			break // producer mid-write → retry next tick
		}
		cur.stuckSince = time.Time{}
		taskID := rc.u16(base + recOffTaskID)
		scan := rc.u32(base + recOffScan) // read BEFORE the torn-read check, like the rest
		plen := int(rc.u16(base + recOffPayloadLen))
		if plen > stride-recOffPayload {
			plen = stride - recOffPayload
		}
		payload := make([]byte, plen)
		rc.copyPayload(payload, base+recOffPayload, base+stride)
		// ⚠️ Torn-read check, AFTER the copy: once seq s+nslots is claimed the
		// producer may be rewriting this very slot, so what we copied can be
		// half of each record. Discard it rather than deliver a plausible lie.
		if w2 := rc.loadU64(offWriteSeq); w2 > s+nslots {
			dropped++
			readSeq = s + 1
			continue
		}
		dst = append(dst, RingRecord{Seq: s, TaskID: taskID, Scan: scan, Payload: payload})
		got++
		readSeq = s + 1
	}
	cur.ReadSeq = readSeq
	return dropped, dst
}

// Close unmaps and closes the segment.
func (rc *RingConsumer) Close() error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	var err error
	if rc.mem != nil {
		err = syscall.Munmap(rc.mem)
		rc.mem = nil
	}
	if rc.fd >= 0 {
		syscall.Close(rc.fd)
		rc.fd = -1
	}
	return err
}
