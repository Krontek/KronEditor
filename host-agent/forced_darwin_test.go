//go:build darwin

package main

import (
	"os"
	"testing"
	"time"

	"github.com/krontek/hotswaplib/shmcmd"
)

// The real poller over a real (file-backed, macOS) mirror: the forced set
// rides beside "vars", ignores the subscription, and an unforce is reported
// as an empty list.
func TestHotswapPollerEmitsForcedSet(t *testing.T) {
	s := &Server{paths: &Paths{AppDataDir: t.TempDir()}, events: NewEvents(), live: NewLiveFilter()}
	if err := os.MkdirAll(s.paths.SimBuildDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	path := mirrorPath(s.paths.SimBuildDir(), hotswapShmName)
	if err := os.WriteFile(path, make([]byte, hotswapShmSize), 0o600); err != nil {
		t.Fatal(err)
	}
	w, err := openShmMirror(s.paths.SimBuildDir(), hotswapShmName, hotswapShmSize, true)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	mem := w.Bytes()
	mem[shmcmd.ForceFlagsBase+1] = shmcmd.FlagForced

	specs := []ShmSpec{
		{Key: "prog__g", Offset: 0, VType: "DINT", Size: 4, ForceOff: shmcmd.ForceFlagsBase},
		{Key: "prog_Other_x", Offset: 4, VType: "BOOL", Size: 1, ForceOff: shmcmd.ForceFlagsBase + 1},
	}
	s.live.Set([]string{"prog__"}, nil) // the forced variable is NOT subscribed

	ch := make(chan eventMsg, 64)
	s.events.mu.Lock()
	s.events.subscribers[ch] = struct{}{}
	s.events.mu.Unlock()
	stop := make(chan struct{})
	go s.hotswapPoller(specs, stop)
	defer close(stop)

	next := func() map[string]any {
		t.Helper()
		for {
			select {
			case m := <-ch:
				if m.Topic == "simulation-output" {
					return m.Data.(map[string]any)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("no simulation-output event")
			}
		}
	}
	ev := next()
	f, ok := ev[forcedEventKey].([]string)
	if !ok || len(f) != 1 || f[0] != "prog_Other_x" {
		t.Fatalf("first event %s = %#v", forcedEventKey, ev[forcedEventKey])
	}
	vars := ev["vars"].(map[string]interface{})
	if _, ok := vars["prog_Other_x"]; ok {
		t.Fatal("the forced set widened the subscription")
	}
	if _, ok := vars["prog__g"]; !ok {
		t.Fatal("subscribed value missing")
	}

	mem[shmcmd.ForceFlagsBase+1] = 0 // the runtime released it
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ev = next()
		if f, ok := ev[forcedEventKey].([]string); ok {
			if len(f) != 0 {
				continue
			}
			return
		}
	}
	t.Fatal("release never reported as an empty forced set")
}
