package main

import (
	"encoding/binary"
	"os"
	"sync/atomic"
	"syscall"
	"testing"
	"unsafe"
)

// synthetic producer: a minimal C-runtime stand-in that creates the ring and
// appends records exactly as RING_FORMAT.md specifies, so ipc_ring.go is
// exercised against the real byte layout.
type ringProducer struct {
	mem          []byte
	fd           int
	path         string
	recordStride int
	nslots       int
}

func newRingProducer(t *testing.T, shmName string, recordStride, nslots int, tasks []ringTask) *ringProducer {
	t.Helper()
	path := "/dev/shm/" + shmName + "_ring"
	_ = os.Remove(path)
	total := ringHeaderBytes + nslots*recordStride
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_TRUNC, 0660)
	if err != nil {
		t.Fatalf("create ring: %v", err)
	}
	if err := syscall.Ftruncate(fd, int64(total)); err != nil {
		t.Fatalf("ftruncate: %v", err)
	}
	mem, err := syscall.Mmap(fd, 0, total, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		t.Fatalf("mmap: %v", err)
	}
	p := &ringProducer{mem: mem, fd: fd, path: path, recordStride: recordStride, nslots: nslots}
	binary.LittleEndian.PutUint32(mem[offMagic:], ringMagic)
	binary.LittleEndian.PutUint32(mem[offVersion:], 1)
	binary.LittleEndian.PutUint32(mem[offHeaderBytes:], ringHeaderBytes)
	binary.LittleEndian.PutUint32(mem[offRecordStride:], uint32(recordStride))
	binary.LittleEndian.PutUint32(mem[offNslots:], uint32(nslots))
	binary.LittleEndian.PutUint32(mem[offTotalBytes:], uint32(total))
	binary.LittleEndian.PutUint32(mem[offNtasks:], uint32(len(tasks)))
	binary.LittleEndian.PutUint32(mem[offFlags:], 1)
	binary.LittleEndian.PutUint64(mem[offWriteSeq:], 0)
	binary.LittleEndian.PutUint32(mem[offStrideN:], 1)
	binary.LittleEndian.PutUint64(mem[offEpoch:], 1)
	for i, tk := range tasks {
		off := offTaskTable + i*taskEntryBytes
		binary.LittleEndian.PutUint32(mem[off:], tk.PeriodUs)
		binary.LittleEndian.PutUint16(mem[off+4:], tk.PayloadLen)
		binary.LittleEndian.PutUint16(mem[off+6:], tk.TaskID)
	}
	for s := 0; s < nslots; s++ {
		base := ringHeaderBytes + s*recordStride
		binary.LittleEndian.PutUint64(mem[base+recOffSeq:], ringSeqEmpty)
	}
	return p
}

// append writes one record with the given task and payload (payload padded/truncated
// to recordStride-recOffPayload), publishing seq last with a release store.
func (p *ringProducer) append(taskID uint16, payload []byte) uint64 {
	s := atomic.AddUint64((*uint64)(unsafe.Pointer(&p.mem[offWriteSeq])), 1) - 1
	base := ringHeaderBytes + int(s%uint64(p.nslots))*p.recordStride
	binary.LittleEndian.PutUint16(p.mem[base+recOffTaskID:], taskID)
	binary.LittleEndian.PutUint16(p.mem[base+recOffPayloadLen:], uint16(len(payload)))
	copy(p.mem[base+recOffPayload:base+p.recordStride], payload)
	atomic.StoreUint64((*uint64)(unsafe.Pointer(&p.mem[base+recOffSeq])), s) // publish
	return s
}

// relayout mimics a runtime RESTART that changed the addressed-variable set:
// it rewrites the header with a new record_stride/nslots/task-table, resets
// write_seq, re-inits the slots, and bumps epoch (published last, like the C
// producer). The consumer must pick up the new layout on its next drain.
func (p *ringProducer) relayout(recordStride int, tasks []ringTask) {
	total := len(p.mem)
	nslots := (total - ringHeaderBytes) / recordStride
	binary.LittleEndian.PutUint32(p.mem[offRecordStride:], uint32(recordStride))
	binary.LittleEndian.PutUint32(p.mem[offNslots:], uint32(nslots))
	binary.LittleEndian.PutUint32(p.mem[offNtasks:], uint32(len(tasks)))
	binary.LittleEndian.PutUint64(p.mem[offWriteSeq:], 0)
	for i, tk := range tasks {
		off := offTaskTable + i*taskEntryBytes
		binary.LittleEndian.PutUint32(p.mem[off:], tk.PeriodUs)
		binary.LittleEndian.PutUint16(p.mem[off+4:], tk.PayloadLen)
		binary.LittleEndian.PutUint16(p.mem[off+6:], tk.TaskID)
	}
	for s := 0; s < nslots; s++ {
		binary.LittleEndian.PutUint64(p.mem[ringHeaderBytes+s*recordStride+recOffSeq:], ringSeqEmpty)
	}
	p.recordStride = recordStride
	p.nslots = nslots
	old := binary.LittleEndian.Uint64(p.mem[offEpoch:])
	atomic.StoreUint64((*uint64)(unsafe.Pointer(&p.mem[offEpoch])), old+1) // publish last
}

func (p *ringProducer) close() {
	syscall.Munmap(p.mem)
	syscall.Close(p.fd)
	os.Remove(p.path)
}

func TestRingDrainInOrderNoLoss(t *testing.T) {
	name := "kron_test_noloss"
	recordStride := 16 + 8 // one LINT payload
	tasks := []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}}
	p := newRingProducer(t, name, recordStride, 1024, tasks)
	defer p.close()

	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()

	// producer writes an incrementing LINT counter, 500 records (< nslots)
	for i := 0; i < 500; i++ {
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], uint64(i))
		p.append(0, b[:])
	}

	var recs []RingRecord
	readSeq := uint64(0)
	var totalDropped uint64
	for {
		var d uint64
		readSeq, d, recs = rc.Drain(readSeq, recs, 0)
		totalDropped += d
		if readSeq >= 500 {
			break
		}
	}
	if totalDropped != 0 {
		t.Fatalf("expected 0 drops, got %d", totalDropped)
	}
	if len(recs) != 500 {
		t.Fatalf("expected 500 records, got %d", len(recs))
	}
	for i, r := range recs {
		if r.Seq != uint64(i) {
			t.Fatalf("record %d has seq %d", i, r.Seq)
		}
		v := binary.LittleEndian.Uint64(r.Payload)
		if v != uint64(i) {
			t.Fatalf("record %d payload = %d, want %d (a value was lost/reordered)", i, v, i)
		}
	}

	if got := rc.ProducedBytesPerSec(); got != 8.0/100*1e6 {
		t.Fatalf("ProducedBytesPerSec = %v, want %v", got, 8.0/100*1e6)
	}
}

func TestRingDrainDetectsLapLoss(t *testing.T) {
	name := "kron_test_lap"
	recordStride := 16 + 8
	nslots := 64
	tasks := []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}}
	p := newRingProducer(t, name, recordStride, nslots, tasks)
	defer p.close()

	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()

	// Write 200 records into a 64-slot ring WITHOUT draining → guaranteed lapping.
	total := 200
	for i := 0; i < total; i++ {
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], uint64(i))
		p.append(0, b[:])
	}

	var recs []RingRecord
	readSeq, dropped, recs := rc.Drain(0, nil, 0)
	// Only the last nslots records survive; the rest are counted as dropped.
	if dropped != uint64(total-nslots) {
		t.Fatalf("dropped = %d, want %d", dropped, total-nslots)
	}
	if len(recs) != nslots {
		t.Fatalf("recovered %d records, want %d", len(recs), nslots)
	}
	// The survivors must be the most recent, contiguous, in order.
	firstSeq := recs[0].Seq
	if firstSeq != uint64(total-nslots) {
		t.Fatalf("first surviving seq = %d, want %d", firstSeq, total-nslots)
	}
	for i, r := range recs {
		want := uint64(total-nslots) + uint64(i)
		if r.Seq != want {
			t.Fatalf("survivor %d seq=%d want %d", i, r.Seq, want)
		}
		if v := binary.LittleEndian.Uint64(r.Payload); v != want {
			t.Fatalf("survivor %d payload=%d want %d", i, v, want)
		}
	}
	_ = readSeq
}

// Regression: after a runtime restart that changes the layout (epoch bump), the
// consumer must RE-PARSE the header instead of decoding new records with the old
// record_stride. This is the "added variables → only the first one showed up" bug.
func TestRingReparseOnLayoutChange(t *testing.T) {
	name := "kron_test_reparse"
	p := newRingProducer(t, name, 16+8, 4096, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()

	// gen 1: one 8-byte var
	for i := 0; i < 10; i++ {
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], uint64(100+i))
		p.append(0, b[:])
	}
	readSeq, _, recs := rc.Drain(0, nil, 0)
	if len(recs) != 10 || rc.RecordStride() != 24 {
		t.Fatalf("gen1: got %d recs, stride %d", len(recs), rc.RecordStride())
	}

	// runtime restart with TWO 8-byte vars (stride 32, payload 16)
	epochBefore := rc.Epoch()
	p.relayout(16+16, []ringTask{{PeriodUs: 100, PayloadLen: 16, TaskID: 0}})
	// the stream handler resets its readSeq when the epoch changes:
	if rc.Epoch() == epochBefore {
		t.Fatalf("epoch did not change")
	}
	readSeq = 0
	for i := 0; i < 5; i++ {
		var b [16]byte
		binary.LittleEndian.PutUint64(b[0:], uint64(200+i))
		binary.LittleEndian.PutUint64(b[8:], uint64(900+i))
		p.append(0, b[:])
	}
	_, _, recs = rc.Drain(readSeq, nil, 0)
	// consumer must have re-parsed to the new stride and decode BOTH vars
	if rc.RecordStride() != 32 {
		t.Fatalf("consumer did not re-parse stride: got %d want 32", rc.RecordStride())
	}
	if len(recs) != 5 {
		t.Fatalf("gen2: got %d recs, want 5", len(recs))
	}
	for i, r := range recs {
		if len(r.Payload) != 16 {
			t.Fatalf("rec %d payload len %d want 16", i, len(r.Payload))
		}
		v0 := binary.LittleEndian.Uint64(r.Payload[0:])
		v1 := binary.LittleEndian.Uint64(r.Payload[8:])
		if v0 != uint64(200+i) || v1 != uint64(900+i) {
			t.Fatalf("rec %d decoded (%d,%d) want (%d,%d) — second var lost/misaligned", i, v0, v1, 200+i, 900+i)
		}
	}
}

// Drain must honor maxRecords so one frame can't allocate the whole (huge) ring
// at once — the fix for the OOM when a client attaches to a running producer.
func TestRingDrainRespectsMaxRecords(t *testing.T) {
	name := "kron_test_maxrecs"
	p := newRingProducer(t, name, 24, 4096, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()
	for i := 0; i < 1000; i++ {
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], uint64(i))
		p.append(0, b[:])
	}
	readSeq, _, recs := rc.Drain(0, nil, 100)
	if len(recs) != 100 {
		t.Fatalf("first drain returned %d, want capped at 100", len(recs))
	}
	if readSeq != 100 {
		t.Fatalf("readSeq=%d, want 100 (rest left for next tick)", readSeq)
	}
	// the remainder drains on subsequent calls
	_, _, recs2 := rc.Drain(readSeq, nil, 100)
	if len(recs2) != 100 || recs2[0].Seq != 100 {
		t.Fatalf("second drain: got %d recs starting at seq %d", len(recs2), recs2[0].Seq)
	}
}

func TestRingSetStrideRoundTrips(t *testing.T) {
	name := "kron_test_stride"
	p := newRingProducer(t, name, 24, 128, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()
	rc.SetStrideN(7)
	// producer reads the same header word
	got := atomic.LoadUint32((*uint32)(unsafe.Pointer(&p.mem[offStrideN])))
	if got != 7 {
		t.Fatalf("producer sees stride_N=%d, want 7", got)
	}
	if rc.StrideN() != 7 {
		t.Fatalf("consumer StrideN=%d, want 7", rc.StrideN())
	}
}
