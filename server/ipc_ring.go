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
	recOffPayload    = 16

	ringSeqEmpty = ^uint64(0) // 0xFFFF...  slot never written
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

	recordStride int
	nslots       int
	tasks        []ringTask
}

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
	return rc, nil
}

func (rc *RingConsumer) u32(off int) uint32 { return binary.LittleEndian.Uint32(rc.mem[off:]) }
func (rc *RingConsumer) u16(off int) uint16 { return binary.LittleEndian.Uint16(rc.mem[off:]) }

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
	return atomic.LoadUint64((*uint64)(unsafe.Pointer(&rc.mem[off])))
}
func (rc *RingConsumer) loadU32(off int) uint32 {
	return atomic.LoadUint32((*uint32)(unsafe.Pointer(&rc.mem[off])))
}
func (rc *RingConsumer) storeU32(off int, v uint32) {
	atomic.StoreUint32((*uint32)(unsafe.Pointer(&rc.mem[off])), v)
}

func (rc *RingConsumer) WriteSeq() uint64  { return rc.loadU64(offWriteSeq) }
func (rc *RingConsumer) Epoch() uint64     { return rc.loadU64(offEpoch) }
func (rc *RingConsumer) StrideN() uint32   { return rc.loadU32(offStrideN) }
func (rc *RingConsumer) Nslots() int       { return rc.nslots }
func (rc *RingConsumer) RecordStride() int { return rc.recordStride }
func (rc *RingConsumer) Tasks() []ringTask { return rc.tasks }

// SetStrideN publishes the global decimation stride to the producer.
func (rc *RingConsumer) SetStrideN(n uint32) {
	if n == 0 {
		n = 1
	}
	rc.storeU32(offStrideN, n)
}

// ProducedBytesPerSec is Σ_g(payload_len_g / period_us_g) × 1e6 — the RAW
// production rate before decimation, from the task table.
func (rc *RingConsumer) ProducedBytesPerSec() float64 {
	var bps float64
	for _, t := range rc.tasks {
		if t.PeriodUs > 0 {
			bps += float64(t.PayloadLen) / float64(t.PeriodUs) * 1e6
		}
	}
	return bps
}

// RingRecord is one drained sample. Payload aliases the ring; copy if retained.
type RingRecord struct {
	Seq     uint64
	TaskID  uint16
	Payload []byte
}

// Drain reads records with sequence in [readSeq, write_seq). It returns the new
// readSeq to pass next time, how many records were lost to overwrite (lapping),
// and appends up to maxRecords freshly-read records to dst.
//
// A record whose slot.seq != expected is treated as "producer mid-write" and
// stops the drain (retry next tick); this never blocks.
func (rc *RingConsumer) Drain(readSeq uint64, dst []RingRecord, maxRecords int) (uint64, uint64, []RingRecord) {
	w := rc.WriteSeq()
	if w <= readSeq {
		return readSeq, 0, dst
	}
	var dropped uint64
	nslots := uint64(rc.nslots)
	if w-readSeq > nslots {
		dropped = (w - readSeq) - nslots
		readSeq = w - nslots // catch up to the oldest slot still present
	}
	got := 0
	for s := readSeq; s < w; s++ {
		if maxRecords > 0 && got >= maxRecords {
			break
		}
		base := ringHeaderBytes + int(s%nslots)*rc.recordStride
		ss := rc.loadU64(base + recOffSeq)
		if ss != s {
			// ss < s: not yet written (producer mid-write) → stop and retry.
			// ss > s: already overwritten → this position lapped; skip forward.
			if ss > s {
				readSeq = s + 1
				continue
			}
			break
		}
		taskID := rc.u16(base + recOffTaskID)
		plen := int(rc.u16(base + recOffPayloadLen))
		if plen > rc.recordStride-recOffPayload {
			plen = rc.recordStride - recOffPayload
		}
		payload := make([]byte, plen)
		copy(payload, rc.mem[base+recOffPayload:base+recOffPayload+plen])
		dst = append(dst, RingRecord{Seq: s, TaskID: taskID, Payload: payload})
		got++
		readSeq = s + 1
	}
	return readSeq, dropped, dst
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
