package shmcmd

import (
	"encoding/binary"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

// fakeRuntime mirrors the generated C consumer (generateShmMailbox) closely
// enough to exercise the writer: same try-lock, same claim CAS, same ack order.
type fakeRuntime struct {
	mem   []byte
	nvars uint32
	sizes []int // per index; 0 = read-only
	state [][8]byte
	mu    sync.Mutex // guards state for the test's reads
}

func newSeg(t *testing.T) []byte {
	t.Helper()
	// []uint64 backing guarantees 8-byte alignment, like an mmap base.
	b := make([]uint64, SegmentSize/8)
	return unsafe.Slice((*byte)(unsafe.Pointer(&b[0])), SegmentSize)
}

func (r *fakeRuntime) u32p(off int) *uint32 { return (*uint32)(unsafe.Pointer(&r.mem[off])) }
func (r *fakeRuntime) u64p(off int) *uint64 { return (*uint64)(unsafe.Pointer(&r.mem[off])) }

func (r *fakeRuntime) init(version uint16) {
	mb := MailboxBase
	atomic.StoreUint32(r.u32p(mb), 0)
	atomic.StoreUint64(r.u64p(mb+offAck), atomic.LoadUint64(r.u64p(mb+offHead)))
	binary.LittleEndian.PutUint16(r.mem[mb+offVersion:], version)
	binary.LittleEndian.PutUint16(r.mem[mb+offHdrLen:], HeaderBytes)
	atomic.StoreUint32(r.u32p(mb+offCap), Capacity)
	atomic.StoreUint32(r.u32p(mb+offEntry), EntryBytes)
	atomic.StoreUint32(r.u32p(mb+offNvars), r.nvars)
	atomic.StoreUint32(r.u32p(mb), Magic)
}

func (r *fakeRuntime) consume() {
	mb := MailboxBase
	if atomic.LoadUint32(r.u32p(mb)) != Magic {
		return
	}
	if !atomic.CompareAndSwapUint32(r.u32p(mb+20), 0, 1) {
		return
	}
	ack := atomic.LoadUint64(r.u64p(mb + offAck))
	for k := 0; k < Capacity; k++ {
		s := ack + 1
		e := mb + HeaderBytes + int(s%Capacity)*EntryBytes
		if atomic.LoadUint64(r.u64p(e)) != s {
			break
		}
		if atomic.CompareAndSwapUint32(r.u32p(e+entStatus), stPending, stClaimed) {
			atomic.StoreUint32(r.u32p(e+entStatus), r.apply(e))
		}
		ack = s
		atomic.StoreUint64(r.u64p(mb+offAck), ack)
	}
	atomic.StoreUint32(r.u32p(mb+20), 0)
}

func (r *fakeRuntime) apply(e int) uint32 {
	w := atomic.LoadUint32(r.u32p(e + entOp))
	op, sz, has := Op(w), int(w>>8&0xff), w>>16&0xff
	idx := atomic.LoadUint32(r.u32p(e + entIndex))
	if op == OpClearAll {
		for i := uint32(0); i < r.nvars; i++ {
			r.mem[ForceFlagsBase+int(i)] = 0
		}
		return stApplied
	}
	if op < OpForce || op > OpUnforce {
		return stBadOp
	}
	if idx >= r.nvars {
		return stBadIndex
	}
	n := r.sizes[idx]
	if n == 0 {
		return stReadOnly
	}
	writes := op != OpUnforce || has != 0
	if writes && sz != n {
		return stBadSize
	}
	if op == OpForce {
		r.mem[ForceFlagsBase+int(idx)] = FlagForced
	} else {
		r.mem[ForceFlagsBase+int(idx)] = 0
	}
	if writes {
		v := atomic.LoadUint64(r.u64p(e + entValue))
		r.mu.Lock()
		binary.LittleEndian.PutUint64(r.state[idx][:], v)
		r.mu.Unlock()
	}
	return stApplied
}

func (r *fakeRuntime) run(stop <-chan struct{}, period time.Duration, threads int) *sync.WaitGroup {
	var wg sync.WaitGroup
	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tk := time.NewTicker(period)
			defer tk.Stop()
			for {
				select {
				case <-stop:
					return
				case <-tk.C:
					r.consume()
				}
			}
		}()
	}
	return &wg
}

func newRuntime(t *testing.T, nvars int) (*fakeRuntime, *Mailbox) {
	mem := newSeg(t)
	r := &fakeRuntime{mem: mem, nvars: uint32(nvars), sizes: make([]int, nvars), state: make([][8]byte, nvars)}
	for i := range r.sizes {
		r.sizes[i] = 4
	}
	m, err := New(mem)
	if err != nil {
		t.Fatal(err)
	}
	return r, m
}

func val32(v uint32) []byte { b := make([]byte, 4); binary.LittleEndian.PutUint32(b, v); return b }

func TestConcurrentWritersAllApplied(t *testing.T) {
	r, m := newRuntime(t, 16)
	r.init(LayoutVersion)
	stop := make(chan struct{})
	wg := r.run(stop, 200*time.Microsecond, 3) // three task threads race for the lock
	defer func() { close(stop); wg.Wait() }()

	var w sync.WaitGroup
	var fails atomic.Int32
	for g := 0; g < 8; g++ {
		w.Add(1)
		go func(g int) {
			defer w.Done()
			for i := 0; i < 200; i++ {
				idx := uint32(g)
				if err := m.Post(Command{Index: idx, Op: OpForce, Value: val32(uint32(i))}, WaitOptions{Timeout: 2 * time.Second}); err != nil {
					// a burst can momentarily fill the mailbox; that is a clean refusal
					if KindOf(err) != KindFull {
						t.Errorf("post: %v", err)
					}
					fails.Add(1)
					i--
					time.Sleep(time.Millisecond)
				}
			}
		}(g)
	}
	w.Wait()
	for g := 0; g < 8; g++ {
		r.mu.Lock()
		got := binary.LittleEndian.Uint32(r.state[g][:])
		r.mu.Unlock()
		if got != 199 {
			t.Errorf("writer %d: final value %d, want 199 (ordering lost)", g, got)
		}
		if r.mem[ForceFlagsBase+g] != FlagForced {
			t.Errorf("writer %d: flag %#x, want forced", g, r.mem[ForceFlagsBase+g])
		}
	}
	if p := m.Pending(); p != 0 {
		t.Errorf("pending after all acks: %d", p)
	}
}

func TestUnforceAndClearAll(t *testing.T) {
	r, m := newRuntime(t, 4)
	r.init(LayoutVersion)
	stop := make(chan struct{})
	wg := r.run(stop, 200*time.Microsecond, 1)
	defer func() { close(stop); wg.Wait() }()
	opt := WaitOptions{Timeout: time.Second}
	if err := m.Post(Command{Index: 1, Op: OpForce, Value: val32(7)}, opt); err != nil {
		t.Fatal(err)
	}
	if err := m.Post(Command{Index: 1, Op: OpUnforce, Value: val32(0)}, opt); err != nil {
		t.Fatal(err)
	}
	if r.mem[ForceFlagsBase+1] != 0 {
		t.Fatal("unforce left the flag set")
	}
	if err := m.Post(Command{Index: 2, Op: OpForce, Value: val32(1)}, opt); err != nil {
		t.Fatal(err)
	}
	if err := m.Post(Command{Op: OpClearAll}, opt); err != nil {
		t.Fatal(err)
	}
	if r.mem[ForceFlagsBase+2] != 0 {
		t.Fatal("clear-all left a flag set")
	}
	if err := m.Post(Command{Index: 3, Op: OpForce, Value: []byte{1, 2}}, opt); KindOf(err) != KindRejected {
		t.Fatalf("size mismatch: got %v, want a rejection", err)
	}
	if err := m.Post(Command{Index: 9, Op: OpForce, Value: val32(1)}, opt); KindOf(err) != KindInvalid {
		t.Fatalf("index past nvars: got %v", err)
	}
}

func TestTimeoutCancelsSoALateRuntimeNeverApplies(t *testing.T) {
	r, m := newRuntime(t, 2)
	r.init(LayoutVersion)
	// No consumer running.
	start := time.Now()
	err := m.Post(Command{Index: 0, Op: OpForce, Value: val32(5)}, WaitOptions{Timeout: 50 * time.Millisecond})
	if KindOf(err) != KindTimeout || HTTPStatus(err) != 504 {
		t.Fatalf("got %v, want a 504 timeout", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("timeout not honoured")
	}
	// The runtime wakes up afterwards: the command is consumed (ack moves) but NOT applied.
	r.consume()
	if r.mem[ForceFlagsBase] != 0 || r.state[0] != [8]byte{} {
		t.Fatal("a cancelled command was applied late")
	}
	if p := m.Pending(); p != 0 {
		t.Fatalf("cancelled command still pending: %d", p)
	}
}

func TestFullMailbox(t *testing.T) {
	r, m := newRuntime(t, 2)
	r.init(LayoutVersion)
	// Fill without consuming: post directly (the wait would time out).
	for i := 0; i < Capacity; i++ {
		if _, err := m.post(Command{Index: 0, Op: OpForce, Value: val32(uint32(i))}); err != nil {
			t.Fatalf("post %d: %v", i, err)
		}
	}
	_, err := m.post(Command{Index: 0, Op: OpForce, Value: val32(1)})
	if KindOf(err) != KindFull || HTTPStatus(err) != 503 {
		t.Fatalf("got %v, want a 503 full", err)
	}
	r.consume() // one lap
	if _, err := m.post(Command{Index: 0, Op: OpForce, Value: val32(99)}); err != nil {
		t.Fatalf("after drain: %v", err)
	}
}

func TestVersionMismatchAndNotReady(t *testing.T) {
	r, m := newRuntime(t, 2)
	err := m.Post(Command{Index: 0, Op: OpForce, Value: val32(1)}, WaitOptions{Timeout: 20 * time.Millisecond})
	if KindOf(err) != KindNotReady {
		t.Fatalf("uninitialised: got %v", err)
	}
	r.init(3)
	err = m.Post(Command{Index: 0, Op: OpForce, Value: val32(1)}, WaitOptions{Timeout: 20 * time.Millisecond})
	if KindOf(err) != KindMismatch || HTTPStatus(err) != 409 {
		t.Fatalf("version 3: got %v", err)
	}
	// Garbage where the magic should be: a v1 runtime with >28k variables.
	binary.LittleEndian.PutUint32(r.mem[MailboxBase:], 0x01010101)
	if err := m.Probe(); KindOf(err) != KindMismatch {
		t.Fatalf("garbage magic: got %v", err)
	}
}

func TestStoppedRuntimeFailsFast(t *testing.T) {
	r, m := newRuntime(t, 2)
	r.init(LayoutVersion)
	var alive atomic.Bool
	alive.Store(true)
	go func() { time.Sleep(30 * time.Millisecond); alive.Store(false) }()
	start := time.Now()
	err := m.Post(Command{Index: 0, Op: OpForce, Value: val32(1)}, WaitOptions{Timeout: 2 * time.Second, Alive: alive.Load})
	if KindOf(err) != KindNotRunning {
		t.Fatalf("got %v, want not-running", err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatalf("took %v — a stop must not cost the full timeout", time.Since(start))
	}
	if err := m.Post(Command{Index: 0, Op: OpForce, Value: val32(1)}, WaitOptions{Alive: alive.Load}); KindOf(err) != KindNotRunning {
		t.Fatalf("already stopped: got %v", err)
	}
}

func TestResetDropsPending(t *testing.T) {
	r, m := newRuntime(t, 2)
	r.init(LayoutVersion)
	if _, err := m.post(Command{Index: 0, Op: OpForce, Value: val32(3)}); err != nil {
		t.Fatal(err)
	}
	m.Reset()
	r.init(LayoutVersion)
	r.consume()
	if r.mem[ForceFlagsBase] != 0 {
		t.Fatal("a command posted before the restart reached the new runtime")
	}
}

func TestTimeoutFor(t *testing.T) {
	if d := TimeoutFor(1000); d != minTimeout {
		t.Errorf("1 ms task: %v", d)
	}
	if d := TimeoutFor(500_000); d != 1100*time.Millisecond {
		t.Errorf("500 ms task: %v", d)
	}
	if d := TimeoutFor(10_000_000); d != maxTimeout {
		t.Errorf("10 s task: %v", d)
	}
}

func TestScalarHelpers(t *testing.T) {
	mem := newSeg(t)
	StoreScalar(mem, 8, []byte{1, 2, 3, 4, 5, 6, 7, 8})
	StoreScalar(mem, 4, []byte{9, 8, 7, 6})
	var d [8]byte
	LoadScalar(mem, 8, 8, d[:])
	if d != [8]byte{1, 2, 3, 4, 5, 6, 7, 8} {
		t.Fatalf("u64 round trip: %v", d)
	}
	LoadScalar(mem, 4, 4, d[:4])
	if d[0] != 9 || d[3] != 6 {
		t.Fatalf("u32 round trip: %v", d)
	}
	LoadScalar(mem, 9, 4, d[:4]) // unaligned: byte copy
	if d[0] != 2 {
		t.Fatalf("unaligned: %v", d)
	}
}

// A write right after Start: the runtime publishes the mailbox a moment later.
// While the process is alive that is waited out, not reported.
func TestWaitsForAStartingRuntime(t *testing.T) {
	r, m := newRuntime(t, 2)
	stop := make(chan struct{})
	go func() { time.Sleep(30 * time.Millisecond); r.init(LayoutVersion) }()
	wg := r.run(stop, 200*time.Microsecond, 1)
	defer func() { close(stop); wg.Wait() }()
	alive := func() bool { return true }
	if err := m.Post(Command{Index: 0, Op: OpForce, Value: val32(9)}, WaitOptions{Timeout: time.Second, Alive: alive}); err != nil {
		t.Fatalf("write during start-up: %v", err)
	}
	// A v1 runtime never initialises: reported once the timeout is spent.
	_, m2 := newRuntime(t, 2)
	err := m2.Post(Command{Index: 0, Op: OpForce, Value: val32(9)}, WaitOptions{Timeout: 40 * time.Millisecond, Alive: alive})
	if KindOf(err) != KindNotReady {
		t.Fatalf("v1 runtime: %v", err)
	}
}

func TestIsForced(t *testing.T) {
	mem := newSeg(t)
	mem[ForceFlagsBase] = FlagForced
	mem[ForceFlagsBase+1] = 1 // v1 runtime FORCE
	mem[ForceFlagsBase+2] = 2 // v1 PULSE — transient, not a force
	mem[ForceFlagsBase+3] = 0
	want := []bool{true, true, false, false}
	for i, w := range want {
		if got := IsForced(mem, ForceFlagsBase+i); got != w {
			t.Errorf("flag %d: IsForced = %v, want %v", i, got, w)
		}
	}
	// No flag (offset 0), a data offset and the mailbox are never "forced".
	mem[0] = FlagForced
	mem[MailboxBase] = FlagForced
	for _, off := range []int{0, 100, MailboxBase, SegmentSize + 5, -1} {
		if IsForced(mem, off) {
			t.Errorf("offset %d reported forced", off)
		}
	}
}
