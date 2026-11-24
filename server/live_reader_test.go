package main

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

// The mailbox idle word follows the number of open editor streams: idle with
// none, not idle while one is open, idle again after the last one closes.
func TestLiveReadersDriveIdleWord(t *testing.T) {
	ipc, _ := newMailboxIPC(t, "kron_test_live_readers")
	ipc.publishIdle() // newMailboxIPC cleared the segment after construction
	if !ipc.mbox.Idle() {
		t.Fatal("no stream open: idle word must be set")
	}
	r1 := ipc.AcquireLiveReader()
	r2 := ipc.AcquireLiveReader()
	if ipc.mbox.Idle() || ipc.LiveReaders() != 2 {
		t.Fatalf("two readers: idle=%v readers=%d", ipc.mbox.Idle(), ipc.LiveReaders())
	}
	r1()
	r1() // release is idempotent
	if ipc.mbox.Idle() || ipc.LiveReaders() != 1 {
		t.Fatalf("one reader left: idle=%v readers=%d", ipc.mbox.Idle(), ipc.LiveReaders())
	}
	ipc.ResetMailbox() // pre-start hook must not flip it while a stream is open
	if ipc.mbox.Idle() {
		t.Fatal("ResetMailbox set idle under an open stream")
	}
	r2()
	if !ipc.mbox.Idle() || ipc.LiveReaders() != 0 {
		t.Fatalf("all released: idle=%v readers=%d", ipc.mbox.Idle(), ipc.LiveReaders())
	}
}

// The SSE editor stream holds a live reader for exactly its lifetime.
func TestSSEVarsHoldsLiveReader(t *testing.T) {
	ipc, _ := newMailboxIPC(t, "kron_test_live_sse")
	s := &Server{ipc: ipc}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/stream/vars", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() { s.handleSSEVars(httptest.NewRecorder(), req); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for ipc.LiveReaders() != 1 {
		if time.Now().After(deadline) {
			t.Fatal("stream did not register a live reader")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if ipc.LiveReaders() != 0 || !ipc.mbox.Idle() {
		t.Fatalf("after close: readers=%d idle=%v", ipc.LiveReaders(), ipc.mbox.Idle())
	}
}
