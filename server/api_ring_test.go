package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ringFrame is one decoded /stream/ring v2 frame.
type ringFrame struct {
	version uint16
	strideN uint32
	dropped uint64
	epoch   uint64
	recs    []ringFrameRec
}

type ringFrameRec struct {
	seq     uint64
	scan    uint32
	payload []byte
}

func readRingFrame(r io.Reader) (*ringFrame, error) {
	var lenb [4]byte
	if _, err := io.ReadFull(r, lenb[:]); err != nil {
		return nil, err
	}
	body := make([]byte, binary.LittleEndian.Uint32(lenb[:]))
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	f := &ringFrame{}
	f.version = binary.LittleEndian.Uint16(body[0:2])
	hdrLen := int(binary.LittleEndian.Uint16(body[2:4]))
	count := binary.LittleEndian.Uint32(body[4:8])
	f.strideN = binary.LittleEndian.Uint32(body[8:12])
	f.dropped = binary.LittleEndian.Uint64(body[12:20])
	f.epoch = binary.LittleEndian.Uint64(body[20:28])
	off := hdrLen
	for i := uint32(0); i < count; i++ {
		seq := binary.LittleEndian.Uint64(body[off:])
		plen := int(binary.LittleEndian.Uint16(body[off+10:]))
		scan := binary.LittleEndian.Uint32(body[off+12:])
		payload := make([]byte, plen)
		copy(payload, body[off+16:off+16+plen])
		f.recs = append(f.recs, ringFrameRec{seq: seq, scan: scan, payload: payload})
		off += 16 + plen
	}
	return f, nil
}

// end-to-end: synthetic producer fills the ring, the real HTTP handler streams
// it, and the client must reassemble records CONTIGUOUSLY (no seq gaps) with zero
// drops. The client starts from write_seq at connect (no pre-connect history), so
// the producer writes CONTINUOUSLY after the client attaches.
func TestRingStreamEndToEndNoLoss(t *testing.T) {
	name := "kron_test_e2e"
	recordStride := 16 + 8
	p := newRingProducer(t, name, recordStride, 4096, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()

	// producer goroutine: writes a monotonically increasing counter, paced so it
	// never laps the 4096-slot ring before the 5 ms consumer reads it.
	stop := make(chan struct{})
	go func() {
		for i := uint64(1); ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			var b [8]byte
			binary.LittleEndian.PutUint64(b[:], i)
			p.append(0, b[:])
			time.Sleep(20 * time.Microsecond)
		}
	}()
	defer close(stop)

	am := &APIManager{shmName: name}
	srv := httptest.NewServer(http.HandlerFunc(am.handleRingStream))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "?v=2")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}

	const want = 500
	var got, lastDropped uint64
	var prev uint64
	first := true
	deadline := time.Now().Add(5 * time.Second)
	for got < want && time.Now().Before(deadline) {
		f, err := readRingFrame(resp.Body)
		if err != nil {
			t.Fatalf("read frame after %d recs: %v", got, err)
		}
		lastDropped = f.dropped
		if f.version != ringFrameVersion {
			t.Fatalf("frame version %d, want %d", f.version, ringFrameVersion)
		}
		for _, rec := range f.recs {
			if !first && rec.seq != prev+1 {
				t.Fatalf("seq gap: %d -> %d (a value was lost)", prev, rec.seq)
			}
			if rec.scan != uint32(rec.seq*3) {
				t.Fatalf("seq %d: scan %d, want %d (scan counter not carried)", rec.seq, rec.scan, uint32(rec.seq*3))
			}
			first, prev = false, rec.seq
			got++
		}
	}
	if got < want {
		t.Fatalf("received %d/%d records", got, want)
	}
	if lastDropped != 0 {
		t.Fatalf("expected 0 streaming drops, got %d", lastDropped)
	}
}

// the producer must be PAUSED (stride_N=0) when no client is connected and
// RESUMED (>=1) as soon as one registers.
func TestRingControllerPausesWhenIdle(t *testing.T) {
	name := "kron_test_pause"
	p := newRingProducer(t, name, 24, 128, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()
	ctl := newRingController(rc)

	id := ctl.register()
	if rc.StrideN() < 1 {
		t.Fatalf("after register stride_N=%d, want >=1 (resumed)", rc.StrideN())
	}
	ctl.unregister(id)
	if rc.StrideN() != 0 {
		t.Fatalf("after last unregister stride_N=%d, want 0 (paused)", rc.StrideN())
	}
	// a second client resumes it again
	id2 := ctl.register()
	if rc.StrideN() < 1 {
		t.Fatalf("after re-register stride_N=%d, want >=1 (resumed)", rc.StrideN())
	}
	ctl.unregister(id2)
}

// the controller must raise the stride when a client's link cannot keep up,
// keeping the ring from swelling (fill-watermark path).
func TestRingControllerRaisesStrideUnderBacklog(t *testing.T) {
	name := "kron_test_ctl"
	p := newRingProducer(t, name, 24, 128, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()

	ctl := newRingController(rc)
	id := ctl.register()
	defer ctl.unregister(id)

	// simulate a saturated client: backlog above the high watermark, slow link.
	// nslots=128, ringFillHigh=0.5 → backlog 100 (>64) must grow the stride.
	startN := rc.StrideN()
	for i := 0; i < 8; i++ {
		ctl.report(id, 1000 /*slow 1KB/s link*/, 100 /*backlog*/, 0 /*readSeq*/)
		time.Sleep(ringTickMs * time.Millisecond * 2)
		if rc.StrideN() > startN {
			return // controller reacted
		}
	}
	t.Fatalf("controller did not raise stride under sustained backlog (stride still %d)", rc.StrideN())
}

// TestRingControllerRecoversFromAStrideBurst pins the fix for the field failure:
// the stride grows by DOUBLING, so shrinking by 1 per 100 ms tick left a device
// pinned in the thousands effectively forever (2048 -> 1 took 2047 ticks, and any
// blip on the way re-doubled it). Recovery must be multiplicative too.
//
// Asserts the DECAY RATE over a few ticks rather than waiting out a full
// recovery: 10%/tick reaches ~1088 after six ticks, while the old -1/tick would
// still be at 2042. Those are far enough apart to be unambiguous, and the test
// stays sub-second.
func TestRingControllerRecoversFromAStrideBurst(t *testing.T) {
	name := "kron_test_recover"
	p := newRingProducer(t, name, 24, 4096, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()

	ctl := newRingController(rc)
	id := ctl.register()
	defer ctl.unregister(id)

	// Put BOTH the controller and the ring header where the field device was.
	// (Setting only ctl.n leaves the header at register()'s stride and the test
	// passes without exercising anything.)
	const burst = 2048
	ctl.mu.Lock()
	ctl.n = burst
	ctl.mu.Unlock()
	rc.SetStrideN(burst)

	// Healthy link, empty backlog: exactly the conditions for relaxing.
	const ticks = 6
	deadline := time.Now().Add(ticks * ringTickMs * time.Millisecond)
	for time.Now().Before(deadline) {
		ctl.report(id, 50e6 /*fast link*/, 0 /*no backlog*/, 0)
		time.Sleep(ringTickMs * time.Millisecond / 4)
	}

	got := rc.StrideN()
	if got >= burst {
		t.Fatalf("stride did not fall at all: %d", got)
	}
	// Additive (-1/tick) would leave ~2042; multiplicative (10%/tick) reaches
	// ~1088. The threshold sits between them with room for tick jitter — tying
	// it to the exact decay curve would make the test flaky, not stricter.
	if got > burst*3/4 {
		t.Fatalf("stride only reached %d after %d ticks — decrease looks additive, "+
			"not multiplicative (additive would give ~%d)", got, ticks, burst-ticks)
	}
}

// TestRingWireBytesPerSecMatchesTheControllersUnit guards the unit mismatch:
// D is measured over whole frames, so P must include the 16-byte per-record
// stream header. Payload-only understated production 2.5x for an 8-byte var.
func TestRingWireBytesPerSecMatchesTheControllersUnit(t *testing.T) {
	name := "kron_test_wirerate"
	p := newRingProducer(t, name, 24, 64, []ringTask{{PeriodUs: 10, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()

	payloadOnly := rc.ProducedBytesPerSec() // 8 B / 10 us  = 800 KB/s
	wire := rc.WireBytesPerSec()            // 24 B / 10 us = 2.4 MB/s
	if want := (8.0 + 16.0) / 10 * 1e6; wire != want {
		t.Fatalf("WireBytesPerSec = %v, want %v", wire, want)
	}
	if wire <= payloadOnly {
		t.Fatalf("wire rate %v must exceed payload-only %v", wire, payloadOnly)
	}
	// the informational /ring/info field must keep its documented meaning
	if want := 8.0 / 10 * 1e6; payloadOnly != want {
		t.Fatalf("ProducedBytesPerSec changed meaning: %v, want %v", payloadOnly, want)
	}
}

// A client connecting after an idle period starts at full fidelity, not at the
// stride a previous (maybe congested) session left behind.
func TestRingControllerResetsStrideAfterIdle(t *testing.T) {
	name := "kron_test_resetn"
	p := newRingProducer(t, name, 24, 128, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	rc, err := OpenRing(name)
	if err != nil {
		t.Fatalf("OpenRing: %v", err)
	}
	defer rc.Close()
	ctl := newRingController(rc)
	id := ctl.register()
	ctl.mu.Lock()
	ctl.n = 512
	ctl.mu.Unlock()
	ctl.unregister(id)
	// Reconnect inside one control tick: the loop must still be the only one.
	id2 := ctl.register()
	defer ctl.unregister(id2)
	if got := rc.StrideN(); got != 1 {
		t.Fatalf("stride after reconnect = %d, want 1", got)
	}
	ctl.mu.Lock()
	running := ctl.running
	ctl.mu.Unlock()
	if !running {
		t.Fatal("controller loop not marked running after reconnect")
	}
}

// A v1 client must get a clear 400, not a stream it would misparse.
func TestRingStreamRequiresV2(t *testing.T) {
	am := &APIManager{shmName: "kron_test_v2req"}
	srv := httptest.NewServer(http.HandlerFunc(am.handleRingStream))
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}

// Frame v2 byte layout: header fields at fixed offsets, header_len lets a
// client skip fields a later version adds, scan rides in every record.
func TestAppendRingFrameV2Layout(t *testing.T) {
	recs := []RingRecord{
		{Seq: 7, TaskID: 2, Scan: 0xDEADBEEF, Payload: []byte{1, 2, 3}},
		{Seq: 8, TaskID: 0, Scan: 5, Payload: nil},
	}
	b := appendRingFrame([]byte{0xAA}, recs, 4, 9, 0x0102030405060708)
	if b[0] != 0xAA {
		t.Fatal("prefix clobbered")
	}
	b = b[1:]
	if got := binary.LittleEndian.Uint32(b[0:4]); int(got) != len(b)-4 {
		t.Fatalf("frame_len %d, body %d", got, len(b)-4)
	}
	f, err := readRingFrame(bytesReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if f.version != 2 || f.strideN != 4 || f.dropped != 9 || f.epoch != 0x0102030405060708 {
		t.Fatalf("header: %+v", f)
	}
	if binary.LittleEndian.Uint16(b[6:8]) != ringFrameHeaderLen || ringFrameHeaderLen != 28 {
		t.Fatalf("header_len %d", binary.LittleEndian.Uint16(b[6:8]))
	}
	if len(f.recs) != 2 || f.recs[0].scan != 0xDEADBEEF || string(f.recs[0].payload) != "\x01\x02\x03" || f.recs[1].seq != 8 {
		t.Fatalf("records: %+v", f.recs)
	}
}

// An epoch change must reach the client at once as an EMPTY frame carrying the
// new epoch, so it re-fetches /ring/info before the new layout's records.
func TestRingStreamAnnouncesEpochChange(t *testing.T) {
	name := "kron_test_epoch"
	p := newRingProducer(t, name, 24, 256, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	defer p.close()
	am := &APIManager{shmName: name}
	srv := httptest.NewServer(http.HandlerFunc(am.handleRingStream))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "?v=2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	time.Sleep(20 * time.Millisecond) // let the handler record the first epoch
	old := binary.LittleEndian.Uint64(p.mem[offEpoch:])
	p.relayout(24, []ringTask{{PeriodUs: 100, PayloadLen: 8, TaskID: 0}})
	f, err := readRingFrame(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if f.epoch == old {
		t.Fatalf("first frame after relayout still carries epoch %d", old)
	}
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
