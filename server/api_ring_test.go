package main

import (
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// readFrame reads one /stream/ring frame from r, returning stride_N, dropped,
// and the decoded (seq,payload) records.
type ringFrame struct {
	strideN uint32
	dropped uint64
	recs    []struct {
		seq     uint64
		payload []byte
	}
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
	count := binary.LittleEndian.Uint32(body[0:4])
	f.strideN = binary.LittleEndian.Uint32(body[4:8])
	f.dropped = binary.LittleEndian.Uint64(body[8:16])
	off := 16
	for i := uint32(0); i < count; i++ {
		seq := binary.LittleEndian.Uint64(body[off:])
		plen := int(binary.LittleEndian.Uint16(body[off+10:]))
		payload := make([]byte, plen)
		copy(payload, body[off+12:off+12+plen])
		f.recs = append(f.recs, struct {
			seq     uint64
			payload []byte
		}{seq, payload})
		off += 12 + plen
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

	resp, err := http.Get(srv.URL)
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
		for _, rec := range f.recs {
			if !first && rec.seq != prev+1 {
				t.Fatalf("seq gap: %d -> %d (a value was lost)", prev, rec.seq)
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
