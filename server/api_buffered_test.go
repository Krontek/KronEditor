package main

import (
	"encoding/binary"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
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

	resp, err := http.Get(srv.URL + "?vars=a,b&interval_us=1000")
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
	for f := 0; f < framesToCheck; f++ {
		frameLen := binary.LittleEndian.Uint32(readExact(4))
		payload := readExact(int(frameLen))
		count := binary.LittleEndian.Uint16(payload[0:2])
		varN := payload[2]
		types := payload[3 : 3+int(varN)]
		if varN != 2 || types[0] != 9 || types[1] != 9 {
			t.Fatalf("frame %d: varN=%d types=%v (want 2, [9 9])", f, varN, types)
		}
		if count == 0 {
			t.Fatalf("frame %d: zero samples", f)
		}
		off := 3 + int(varN)
		// bytes per sample = 8 (two float32); verify payload size matches
		if len(payload)-off != int(count)*8 {
			t.Fatalf("frame %d: payload %d != header (count %d * 8)", f, len(payload)-off, count)
		}
		// decode first + last sample, sanity-check ranges (a in [100,..], b=a+100)
		for _, si := range []int{0, int(count) - 1} {
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
