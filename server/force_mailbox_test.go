package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"github.com/krontek/hotswaplib/shmcmd"
)

// fakeConsumer drains the force-write mailbox the way the generated C does
// (generateShmMailbox): acquire seq, claim, apply to the slot + flag, publish
// ack. Enough to drive the server's write paths end to end.
type fakeConsumer struct {
	mem   []byte
	table map[uint32]Variable // index → variable
	n     uint32
}

func (c *fakeConsumer) u32(off int) *uint32 { return (*uint32)(unsafe.Pointer(&c.mem[off])) }
func (c *fakeConsumer) u64(off int) *uint64 { return (*uint64)(unsafe.Pointer(&c.mem[off])) }

func (c *fakeConsumer) init() {
	mb := shmcmd.MailboxBase
	atomic.StoreUint64(c.u64(mb+32), atomic.LoadUint64(c.u64(mb+24)))
	binary.LittleEndian.PutUint16(c.mem[mb+4:], shmcmd.LayoutVersion)
	binary.LittleEndian.PutUint16(c.mem[mb+6:], shmcmd.HeaderBytes)
	atomic.StoreUint32(c.u32(mb+8), shmcmd.Capacity)
	atomic.StoreUint32(c.u32(mb+12), shmcmd.EntryBytes)
	atomic.StoreUint32(c.u32(mb+16), c.n)
	atomic.StoreUint32(c.u32(mb), shmcmd.Magic)
}

func (c *fakeConsumer) drain() {
	mb := shmcmd.MailboxBase
	ack := atomic.LoadUint64(c.u64(mb + 32))
	for {
		s := ack + 1
		e := mb + shmcmd.HeaderBytes + int(s%shmcmd.Capacity)*shmcmd.EntryBytes
		if atomic.LoadUint64(c.u64(e)) != s {
			return
		}
		if atomic.CompareAndSwapUint32(c.u32(e+12), 0, 1) {
			w := atomic.LoadUint32(c.u32(e + 16))
			op, idx := shmcmd.Op(w), atomic.LoadUint32(c.u32(e+8))
			st := uint32(2)
			switch {
			case op == shmcmd.OpClearAll:
				for i := uint32(0); i < c.n; i++ {
					c.mem[shmcmd.ForceFlagsBase+int(i)] = 0
				}
			default:
				v := c.table[idx]
				if op == shmcmd.OpForce {
					c.mem[shmcmd.ForceFlagsBase+int(idx)] = shmcmd.FlagForced
				} else {
					c.mem[shmcmd.ForceFlagsBase+int(idx)] = 0
				}
				if op != shmcmd.OpUnforce || (w>>16)&0xff != 0 {
					shmcmd.StoreScalar(c.mem, v.Offset, c.mem[e+24:e+24+v.Size])
				}
			}
			atomic.StoreUint32(c.u32(e+12), st)
		}
		ack = s
		atomic.StoreUint64(c.u64(mb+32), ack)
	}
}

func newMailboxIPC(t *testing.T, name string) (*IPCManager, *fakeConsumer) {
	t.Helper()
	ipc, err := NewIPCManager(name, shmcmd.SegmentSize)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ipc.Close() })
	tbl := `{"variables":[
	  {"name":"speed","offset":0,"type":"float64","size":8,"force_flag_offset":32768,"address":"%ML0"},
	  {"name":"run","offset":8,"type":"bool","size":1,"force_flag_offset":32769,"address":"%MX8.0"},
	  {"name":"big","offset":16,"type":"uint64","size":8,"force_flag_offset":32770,"address":"%ML2"}],
	  "shm_layout":{"version":2,"mailbox_offset":61440,"mailbox_capacity":64,"nvars":3,"max_task_interval_us":1000}}`
	pt, err := ipc.ParseVariableTable([]byte(tbl))
	if err != nil {
		t.Fatal(err)
	}
	ipc.ApplyVariableTable(pt)
	c := &fakeConsumer{mem: ipc.mem, n: 3, table: map[uint32]Variable{}}
	for _, v := range pt.vars {
		c.table[uint32(v.ForceFlagOffset-forceFlagsBase)] = v
	}
	// Clean slate (the segment file may survive a previous run).
	for i := shmcmd.ForceFlagsBase; i < len(ipc.mem); i++ {
		ipc.mem[i] = 0
	}
	return ipc, c
}

func runConsumer(c *fakeConsumer) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		tk := time.NewTicker(300 * time.Microsecond)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				c.drain()
			}
		}
	}()
	return func() { close(stop); <-done }
}

func TestWriteVariableWaitsForAck(t *testing.T) {
	ipc, c := newMailboxIPC(t, "kron_mbx_ack")
	c.init()
	defer runConsumer(c)()
	if err := ipc.WriteVariable("speed", json.RawMessage(`12.5`)); err != nil {
		t.Fatal(err)
	}
	// The value is in place WHEN the call returns — no polling.
	if v, _ := ipc.ReadVariable("speed"); v != 12.5 {
		t.Fatalf("speed = %v right after the ack", v)
	}
	if ipc.mem[32768] != shmcmd.FlagForced {
		t.Fatalf("flag %#x", ipc.mem[32768])
	}
	if err := ipc.WriteVariableMode("speed", json.RawMessage(`1`), shmcmd.OpUnforce); err != nil {
		t.Fatal(err)
	}
	if ipc.mem[32768] != 0 {
		t.Fatal("unforce left the flag")
	}
	// ULINT above 2^53 as a decimal string survives exactly.
	if err := ipc.WriteVariable("big", json.RawMessage(`"18446744073709551615"`)); err != nil {
		t.Fatal(err)
	}
	if v, _ := ipc.ReadVariable("big"); v != uint64(18446744073709551615) {
		t.Fatalf("big = %v", v)
	}
}

func TestRESTWriteConcurrentAndErrorCodes(t *testing.T) {
	ipc, c := newMailboxIPC(t, "kron_mbx_rest")
	am := &APIManager{ipc: ipc}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.SetPathValue("name", r.URL.Query().Get("n"))
		am.handleWriteOne(w, r)
	}))
	defer srv.Close()
	post := func(name, body string) int {
		resp, err := http.Post(srv.URL+"?n="+name, "application/json", bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	// Not initialised (runtime never started / v1 runtime): 409, not 200.
	if st := post("speed", `{"value":1}`); st != http.StatusConflict {
		t.Fatalf("uninitialised mailbox: %d, want 409", st)
	}
	c.init()
	// Initialised but nobody consuming: 504 (with a short timeout).
	ipc.mu.Lock()
	ipc.ackTimeout = 50 * time.Millisecond
	ipc.mu.Unlock()
	if st := post("speed", `{"value":1}`); st != http.StatusGatewayTimeout {
		t.Fatalf("stalled runtime: %d, want 504", st)
	}
	// Runtime not running: 409 immediately.
	ipc.SetRuntimeAlive(func() bool { return false })
	if st := post("speed", `{"value":1}`); st != http.StatusConflict {
		t.Fatalf("stopped runtime: %d, want 409", st)
	}
	ipc.SetRuntimeAlive(func() bool { return true })
	ipc.mu.Lock()
	ipc.ackTimeout = 2 * time.Second
	ipc.mu.Unlock()

	stop := runConsumer(c)
	defer stop()
	if st := post("speed", `{"value":1,"mode":"bogus"}`); st != http.StatusBadRequest {
		t.Fatalf("bad mode: %d", st)
	}
	var wg sync.WaitGroup
	var bad atomic.Int32
	for g := 0; g < 6; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 40; i++ {
				if st := post("speed", `{"value":`+strconv.Itoa(g*1000+i)+`}`); st != 200 {
					bad.Add(1)
				}
			}
		}(g)
	}
	wg.Wait()
	if bad.Load() != 0 {
		t.Fatalf("%d concurrent writes failed", bad.Load())
	}
	if st := post("run", `{"value":true,"mode":"pulse"}`); st != 200 || ipc.mem[32769] != 0 {
		t.Fatalf("pulse: %d flag %d", st, ipc.mem[32769])
	}
}

func TestClearAllForcesPaths(t *testing.T) {
	ipc, c := newMailboxIPC(t, "kron_mbx_clear")
	c.init()
	stop := runConsumer(c)
	if err := ipc.WriteVariable("run", json.RawMessage(`true`)); err != nil {
		t.Fatal(err)
	}
	if err := ipc.ClearAllForces(); err != nil || ipc.mem[32769] != 0 {
		t.Fatalf("running clear: %v flag %d", err, ipc.mem[32769])
	}
	stop()
	// Stopped runtime: cleared directly (nobody to race), never an error.
	ipc.mem[32769] = shmcmd.FlagForced
	ipc.SetRuntimeAlive(func() bool { return false })
	if err := ipc.ClearAllForces(); err != nil || ipc.mem[32769] != 0 {
		t.Fatalf("stopped clear: %v flag %d", err, ipc.mem[32769])
	}
	// The mailbox itself is never touched by a flag clear.
	if binary.LittleEndian.Uint32(ipc.mem[shmcmd.MailboxBase:]) != shmcmd.Magic {
		t.Fatal("flag clear wiped the mailbox header")
	}
}

func TestParseRejectsFlagInMailbox(t *testing.T) {
	ipc, err := NewIPCManager("kron_mbx_parse", shmcmd.SegmentSize)
	if err != nil {
		t.Fatal(err)
	}
	defer ipc.Close()
	_, err = ipc.ParseVariableTable([]byte(`{"variables":[{"name":"x","offset":0,"type":"bool","size":1,"force_flag_offset":61440}]}`))
	if err == nil {
		t.Fatal("a force flag inside the mailbox was accepted")
	}
}

func TestJSONSafe64(t *testing.T) {
	if v := jsonSafe64(int64(1 << 53)); v != int64(1<<53) {
		t.Fatalf("2^53 must stay a number: %v", v)
	}
	if v := jsonSafe64(int64(1<<53 + 1)); v != "9007199254740993" {
		t.Fatalf("2^53+1: %v", v)
	}
	if v := jsonSafe64(uint64(18446744073709551615)); v != "18446744073709551615" {
		t.Fatalf("max uint64: %v", v)
	}
	if v := jsonSafe64(int64(-(1<<53 + 1))); v != "-9007199254740993" {
		t.Fatalf("negative: %v", v)
	}
}
