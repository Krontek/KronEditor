package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	connect "connectrpc.com/connect"
	"github.com/krontek/hotswaplib/shmcmd"
	"google.golang.org/protobuf/types/known/structpb"
	plcv1 "plc-agent/gen/plc/v1"
)

// fakeConsumer drains the write mailbox the way the generated C does
// (generateShmMailbox): acquire seq, claim, apply to the slot, publish ack.
// Like the runtime it accepts ONLY OpWrite and answers anything else with
// BAD_OP. Enough to drive the server's write paths end to end.
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
			op, size, idx := w&0xff, int((w>>8)&0xff), atomic.LoadUint32(c.u32(e+8))
			v, known := c.table[idx]
			var st uint32
			switch {
			case op != shmcmd.OpWrite:
				st = 6 // BAD_OP
			case !known || idx >= c.n:
				st = 3 // BAD_INDEX
			case size != v.Size:
				st = 4 // BAD_SIZE
			default:
				shmcmd.StoreScalar(c.mem, v.Offset, c.mem[e+24:e+24+v.Size])
				st = 2 // APPLIED
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
	  {"name":"speed","offset":0,"type":"float64","size":8,"mb_index":0,"address":"%ML0"},
	  {"name":"run","offset":8,"type":"bool","size":1,"mb_index":1,"address":"%MX8.0"},
	  {"name":"big","offset":16,"type":"uint64","size":8,"mb_index":2,"address":"%ML2"},
	  {"name":"legacy","offset":24,"type":"int32","size":4,"address":"%MD24"}],
	  "shm_layout":{"version":3,"size":28,"mailbox_offset":61440,"mailbox_capacity":64,"nvars":3,"max_task_interval_us":1000}}`
	pt, err := ipc.ParseVariableTable([]byte(tbl))
	if err != nil {
		t.Fatal(err)
	}
	ipc.ApplyVariableTable(pt)
	c := &fakeConsumer{mem: ipc.mem, n: 3, table: map[uint32]Variable{}}
	for _, v := range pt.vars {
		if v.MbIndex != nil {
			c.table[uint32(*v.MbIndex)] = v
		}
	}
	// Clean slate (the segment file may survive a previous run).
	clear(ipc.mem)
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
	var once sync.Once
	return func() { once.Do(func() { close(stop); <-done }) }
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
	// Every command on the wire is OpWrite (the consumer answers BAD_OP to
	// anything else, which would have failed the write above).
	e := shmcmd.MailboxBase + shmcmd.HeaderBytes + 1*shmcmd.EntryBytes
	if op := ipc.mem[e+16]; op != shmcmd.OpWrite {
		t.Fatalf("posted op %d, want OpWrite (%d)", op, shmcmd.OpWrite)
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
	// Forcing was removed: every legacy mode is refused, never downgraded.
	for _, m := range []string{"force", "pulse", "unforce", "bogus"} {
		if st := post("speed", `{"value":1,"mode":"`+m+`"}`); st != http.StatusBadRequest {
			t.Fatalf("mode %q: %d, want 400", m, st)
		}
	}
	if st := post("speed", `{"value":3,"mode":"write"}`); st != 200 {
		t.Fatalf(`mode "write": %d, want 200`, st)
	}
	if st := post("speed", `{}`); st != http.StatusBadRequest {
		t.Fatalf("missing value: %d, want 400", st)
	}
	// A variable from a pre-v3 table (no mb_index) cannot be written.
	if st := post("legacy", `{"value":1}`); st != http.StatusBadRequest {
		t.Fatalf("variable without mb_index: %d, want 400", st)
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
	if st := post("run", `{"value":true}`); st != 200 || ipc.mem[8] != 1 {
		t.Fatalf("bool write: %d slot %d", st, ipc.mem[8])
	}

	// Mailbox full: 503. Fake a backlog of Capacity unacknowledged commands.
	stop()
	mb := shmcmd.MailboxBase
	ack := binary.LittleEndian.Uint64(ipc.mem[mb+32:])
	binary.LittleEndian.PutUint64(ipc.mem[mb+24:], ack+shmcmd.Capacity)
	if st := post("speed", `{"value":1}`); st != http.StatusServiceUnavailable {
		t.Fatalf("full mailbox: %d, want 503", st)
	}
}

// The ConnectRPC WriteVar and the HMI write refuse a FORCE request too.
func TestRPCAndHMIRefuseForceMode(t *testing.T) {
	ipc, c := newMailboxIPC(t, "kron_mbx_modes")
	c.init()
	defer runConsumer(c)()

	svc := &PLCService{ipc: ipc}
	call := func(mode string, v *structpb.Value) connect.Code {
		_, err := svc.WriteVar(context.Background(), connect.NewRequest(&plcv1.WriteVarRequest{Name: "speed", Value: v, Mode: mode}))
		if err == nil {
			return 0
		}
		return connect.CodeOf(err)
	}
	for _, m := range []string{"force", "pulse", "unforce"} {
		if code := call(m, structpb.NewNumberValue(1)); code != connect.CodeInvalidArgument {
			t.Fatalf("RPC mode %q: %v, want InvalidArgument", m, code)
		}
	}
	if code := call("", nil); code != connect.CodeInvalidArgument {
		t.Fatalf("RPC without a value: %v, want InvalidArgument", code)
	}
	if code := call("", structpb.NewNumberValue(7)); code != 0 {
		t.Fatalf("RPC write: %v", code)
	}
	if v, _ := ipc.ReadVariable("speed"); v != 7.0 {
		t.Fatalf("speed = %v after the RPC write", v)
	}

	hm := NewHMIManager(slog.Default(), NewUserStore(), NewSessionStore(), ipc, t.TempDir())
	if err := hm.LoadJSON([]byte(hmiLayoutWithUser(hashPassword("s", "pw")))); err != nil {
		t.Fatal(err)
	}
	ck := &http.Cookie{Name: sessionCookieName, Value: hm.sessions.Create("op", RoleOperator).Token}
	if rec := hmiDo(hm.handleAPIWrite, http.MethodPost, `{"key":"run","value":true,"mode":"force"}`, "application/json", ck); rec.Code != http.StatusBadRequest {
		t.Fatalf("HMI force: %d %s, want 400", rec.Code, rec.Body.String())
	}
	if rec := hmiDo(hm.handleAPIWrite, http.MethodPost, `{"key":"run","value":true}`, "application/json", ck); rec.Code != http.StatusOK {
		t.Fatalf("HMI write: %d %s", rec.Code, rec.Body.String())
	}
}

// mb_index and the data region are validated at load: a corrupt table is a
// deploy error, not writes landing on the wrong variable.
func TestParseValidatesMailboxIndex(t *testing.T) {
	ipc := newTestIPC(shmcmd.SegmentSize)
	layout := `"shm_layout":{"version":3,"mailbox_offset":61440,"mailbox_capacity":64,"nvars":2}`
	for name, tbl := range map[string]string{
		"index past nvars": `{"variables":[{"name":"x","offset":0,"type":"bool","size":1,"mb_index":2}],` + layout + `}`,
		"negative index":   `{"variables":[{"name":"x","offset":0,"type":"bool","size":1,"mb_index":-1}]}`,
		"duplicate index": `{"variables":[{"name":"x","offset":0,"type":"bool","size":1,"mb_index":1},` +
			`{"name":"y","offset":1,"type":"bool","size":1,"mb_index":1}],` + layout + `}`,
		"slot in mailbox": `{"variables":[{"name":"x","offset":61440,"type":"bool","size":1,"mb_index":0}],` + layout + `}`,
	} {
		if _, err := ipc.ParseVariableTable([]byte(tbl)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// The former force-flag region [32768,61440) is data space since v3.
	ok := `{"variables":[{"name":"x","offset":61432,"type":"float64","size":8,"mb_index":1}],` + layout + `}`
	if _, err := ipc.ParseVariableTable([]byte(ok)); err != nil {
		t.Fatalf("slot just below the mailbox rejected: %v", err)
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
