package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The real log from a stuck EtherCAT bus: the routine chatter must stay in the
// file, the trouble must be classified so it lands in Warnings/Errors instead of
// the Messages list, and the endless repeated pair must collapse.
func TestRuntimeLogClassifiesAndFolds(t *testing.T) {
	cases := []struct{ line, want string }{
		{"[kronec] Bus running on enp7s0, 1 slave(s) in OP", "info"},
		{"[host] started: /x/logic_0.so  tasks=1", "info"},
		{"[kronec] Could not reach OP state", "error"},
		{"[kronec] Slave 1 recovery failed (state=0x00)", "error"},
		{"[kronec] Slave 1 not OP (state=0x00), recovering", "warning"},
		{"[plc] task 0: SCHED_FIFO prio 99 refused", "warning"},
		{"free(): double free detected in tcache 2", "error"},
		{"[kronec] No EtherCAT slaves found on enp7s0", "error"},
		{"[kronec] some routine detail nobody needs", ""},
	}
	for _, c := range cases {
		if got := runtimeLogLevel(c.line); got != c.want {
			t.Errorf("runtimeLogLevel(%q) = %q, want %q", c.line, got, c.want)
		}
	}

	dir := t.TempDir()
	s := &Server{events: NewEvents()}
	w := s.newRuntimeLogWriter(dir)
	// The stuck-bus pair, over and over. Only the first of each may be emitted.
	for i := 0; i < 50; i++ {
		_, _ = w.Write([]byte("[kronec] Slave 1 not OP (state=0x00), recovering\n"))
	}
	if w.emitted != 1 {
		t.Errorf("50 identical lines produced %d entries, want 1", w.emitted)
	}
	if w.repeats != 49 {
		t.Errorf("repeat counter = %d, want 49", w.repeats)
	}
	_ = w.Close()
	blob, _ := os.ReadFile(filepath.Join(dir, "runtime.log"))
	if got := strings.Count(string(blob), "not OP"); got != 50 {
		t.Errorf("file kept %d copies, want all 50 (folding is UI-only)", got)
	}
}

// The writer is fed by a pipe, so a line can arrive in pieces and several lines
// can arrive at once. Both must come out as whole lines, and nothing may be lost
// from the file even after the UI stream is capped.
func TestRuntimeLogWriterSplitsAndCaps(t *testing.T) {
	dir := t.TempDir()
	s := &Server{events: NewEvents()}
	w := s.newRuntimeLogWriter(dir)

	// A line split across two writes must not be emitted twice or truncated.
	if _, err := w.Write([]byte("[kronec] No EtherCAT sl")); err != nil {
		t.Fatal(err)
	}
	if w.emitted != 0 {
		t.Errorf("partial line emitted early (emitted=%d)", w.emitted)
	}
	if _, err := w.Write([]byte("aves found on enp7s0\n[host] started\r\n")); err != nil {
		t.Fatal(err)
	}
	// Both are classified: "No EtherCAT slaves found" is an error, "[host] started"
	// is info. A line that matched nothing would stay in the file only.
	if w.emitted != 2 {
		t.Errorf("want 2 whole lines emitted, got %d", w.emitted)
	}

	// Past the cap the panel stops but the file keeps everything.
	// Distinct, classified lines so neither the filter nor the repeat-folding
	// hides them — only the cap should.
	for i := 0; i < runtimeLogMaxLines+50; i++ {
		_, _ = w.Write([]byte(fmt.Sprintf("[kronec] Slave %d recovery failed\n", i)))
	}
	if w.emitted > runtimeLogMaxLines+1 { // +1 for the "further output" notice
		t.Errorf("emitted %d lines, cap is %d", w.emitted, runtimeLogMaxLines)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	blob, err := os.ReadFile(filepath.Join(dir, "runtime.log"))
	if err != nil {
		t.Fatalf("runtime.log not written: %v", err)
	}
	text := string(blob)
	if !strings.Contains(text, "[kronec] No EtherCAT slaves found on enp7s0") {
		t.Error("the split line did not reassemble in the file")
	}
	if got := strings.Count(text, "recovery failed"); got != runtimeLogMaxLines+50 {
		t.Errorf("file kept %d lines, want %d (the cap is UI-only)", got, runtimeLogMaxLines+50)
	}
}

// A writer whose file cannot be created must still accept writes: a run is never
// allowed to fail because of its own logging.
func TestRuntimeLogWriterSurvivesUnwritableDir(t *testing.T) {
	s := &Server{events: NewEvents()}
	w := s.newRuntimeLogWriter("/nonexistent-dir-xyzzy")
	if n, err := w.Write([]byte("still fine\n")); err != nil || n == 0 {
		t.Fatalf("Write returned n=%d err=%v", n, err)
	}
	_ = w.Close()
}
