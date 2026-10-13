package main

import (
	"encoding/binary"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

// End-to-end: real IPCManager over a temp /dev/shm, a background writer changing
// values, and the buffered-stream handler served over httptest. Verifies the
// binary frames parse and carry the live (changing) values.
func TestBufferedStreamEndToEnd(t *testing.T) {
	ipc, err := NewIPCManager("kron_buftest", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer ipc.Close()

	va := Variable{Name: "a", Offset: 0, Type: VarFloat32, Size: 4, Address: "%MD0"}
	vb := Variable{Name: "b", Offset: 4, Type: VarFloat32, Size: 4, Address: "%MD1"}
	ipc.vars = map[string]Variable{"a": va, "b": vb}
	ipc.addressedVars = map[string]Variable{"a": va, "b": vb}

	// Background writer — mutate SHM every 200 µs (faster than the 1 ms sampler).
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		var i uint32
		tk := time.NewTicker(200 * time.Microsecond)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				ipc.mu.Lock()
				binary.LittleEndian.PutUint32(ipc.mem[0:4], math.Float32bits(100+float32(i)))
				binary.LittleEndian.PutUint32(ipc.mem[4:8], math.Float32bits(200+float32(i)))
				ipc.mu.Unlock()
				i++
			}
		}
	}()
	defer func() { close(stop); wg.Wait() }()

	am := &APIManager{ipc: ipc}
	srv := httptest.NewServer(http.HandlerFunc(am.handleBufferedStream))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "?v=2&vars=a,b&interval_us=1000")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}

	readExact := func(n int) []byte {
		b := make([]byte, n)
		if _, err := io.ReadFull(resp.Body, b); err != nil {
			t.Fatalf("read %d: %v", n, err)
		}
		return b
	}

	framesToCheck := 3
	totalSamples := 0
	var lastT uint64
	for f := 0; f < framesToCheck; f++ {
		frameLen := binary.LittleEndian.Uint32(readExact(4))
		payload := readExact(int(frameLen))
		h := parseBufferedHeader(t, payload)
		count, varN, types := h.count, h.varN, h.types
		if varN != 2 || types[0] != 9 || types[1] != 9 {
			t.Fatalf("frame %d: varN=%d types=%v (want 2, [9 9])", f, varN, types)
		}
		if count == 0 && h.missed == 0 {
			t.Fatalf("frame %d: zero samples", f)
		}
		if h.intervalUs != 1000 || (count > 0 && h.tFirstUs == 0) {
			t.Fatalf("frame %d: interval %d t_first %d", f, h.intervalUs, h.tFirstUs)
		}
		if h.tFirstUs != 0 && h.tFirstUs <= lastT {
			t.Fatalf("frame %d: t_first %d not after previous %d", f, h.tFirstUs, lastT)
		}
		lastT = h.tFirstUs
		off := h.dataOff
		// bytes per sample = 8 (two float32); verify payload size matches
		if len(payload)-off != int(count)*8 {
			t.Fatalf("frame %d: payload %d != header (count %d * 8)", f, len(payload)-off, count)
		}
		// decode first + last sample, sanity-check ranges (a in [100,..], b=a+100)
		for _, si := range []int{0, int(count) - 1} {
			if count == 0 {
				break
			}
			p := off + si*8
			a := math.Float32frombits(binary.LittleEndian.Uint32(payload[p : p+4]))
			b := math.Float32frombits(binary.LittleEndian.Uint32(payload[p+4 : p+8]))
			if a < 100 || b != a+100 {
				t.Fatalf("frame %d sample %d: a=%v b=%v (want a>=100, b=a+100)", f, si, a, b)
			}
		}
		totalSamples += int(count)
		t.Logf("frame %d: %d samples x %d vars, %d B", f, count, varN, len(payload))
	}
	// At 1 ms sampling / 5 ms delivery we expect roughly 5 samples per frame.
	if avg := float64(totalSamples) / float64(framesToCheck); avg < 2 || avg > 10 {
		t.Fatalf("avg samples/frame = %.1f (want ~5)", avg)
	}
}

type bufferedHeader struct {
	version    uint16
	varN       int
	count      uint32
	intervalUs uint32
	missed     uint32
	tFirstUs   uint64
	types      []byte
	dataOff    int
}

// parseBufferedHeader decodes a v2 frame header (body after frame_len).
func parseBufferedHeader(t *testing.T, b []byte) bufferedHeader {
	t.Helper()
	h := bufferedHeader{
		version:    binary.LittleEndian.Uint16(b[0:2]),
		varN:       int(binary.LittleEndian.Uint16(b[2:4])),
		count:      binary.LittleEndian.Uint32(b[4:8]),
		intervalUs: binary.LittleEndian.Uint32(b[8:12]),
		missed:     binary.LittleEndian.Uint32(b[12:16]),
		tFirstUs:   binary.LittleEndian.Uint64(b[16:24]),
	}
	if h.version != bufferedFrameVersion {
		t.Fatalf("frame version %d, want %d", h.version, bufferedFrameVersion)
	}
	h.types = b[24 : 24+h.varN]
	h.dataOff = 24 + h.varN
	return h
}

func TestBufferedStreamRequiresV2(t *testing.T) {
	am := &APIManager{}
	srv := httptest.NewServer(http.HandlerFunc(am.handleBufferedStream))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "?vars=a")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}

// More than 255 variables: v1's u8 count wrapped; v2 carries a u16. The stream
// must also END when the variable table changes (stale offsets).
func TestBufferedStreamWideCountAndTableChange(t *testing.T) {
	ipc, err := NewIPCManager("kron_buftest_wide", 4096)
	if err != nil {
		t.Fatal(err)
	}
	defer ipc.Close()
	vars := map[string]Variable{}
	names := ""
	for i := 0; i < 300; i++ {
		n := "v" + strconv.Itoa(i)
		vars[n] = Variable{Name: n, Offset: i, Type: VarUint8, Size: 1, Address: "%MB" + strconv.Itoa(i)}
		if i > 0 {
			names += ","
		}
		names += n
	}
	ipc.vars, ipc.addressedVars = vars, vars

	am := &APIManager{ipc: ipc}
	srv := httptest.NewServer(http.HandlerFunc(am.handleBufferedStream))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "?v=2&interval_us=1000&vars=" + names)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var lenb [4]byte
	if _, err := io.ReadFull(resp.Body, lenb[:]); err != nil {
		t.Fatal(err)
	}
	body := make([]byte, binary.LittleEndian.Uint32(lenb[:]))
	if _, err := io.ReadFull(resp.Body, body); err != nil {
		t.Fatal(err)
	}
	if h := parseBufferedHeader(t, body); h.varN != 300 || len(body)-h.dataOff != int(h.count)*300 {
		t.Fatalf("var_count %d, sample bytes %d for %d samples", h.varN, len(body)-h.dataOff, h.count)
	}

	// A redeploy: the stream must close instead of decoding stale offsets.
	pt, err := ipc.ParseVariableTable([]byte(`{"variables":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	ipc.ApplyVariableTable(pt)
	done := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, resp.Body); done <- err }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream still open 2 s after the variable table changed")
	}
}
