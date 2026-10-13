package main

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/krontek/hotswaplib/shmcmd"
)

func TestReadForcedKeysReadsEveryFlag(t *testing.T) {
	mem := make([]byte, shmcmd.SegmentSize)
	read := func(b []byte, off int64) error {
		if off == shmcmd.ForceFlagsBase+3 {
			return errors.New("unreadable")
		}
		copy(b, mem[off:])
		return nil
	}
	specs := []ShmSpec{
		{Key: "prog_Main_b", ForceOff: shmcmd.ForceFlagsBase + 0},
		{Key: "prog__a", ForceOff: shmcmd.ForceFlagsBase + 1},
		{Key: "prog__pulse", ForceOff: shmcmd.ForceFlagsBase + 2},
		{Key: "prog__broken", ForceOff: shmcmd.ForceFlagsBase + 3},
		{Key: "prog__noflag"},
	}
	keys, ok := readForcedKeys(read, specs)
	if !ok || keys == nil || len(keys) != 0 {
		t.Fatalf("nothing forced: %#v %v", keys, ok)
	}
	mem[shmcmd.ForceFlagsBase+0] = shmcmd.FlagForced
	mem[shmcmd.ForceFlagsBase+1] = shmcmd.FlagForced
	mem[shmcmd.ForceFlagsBase+2] = 2 // v1 PULSE — not a hold
	keys, _ = readForcedKeys(read, specs)
	if want := []string{"prog_Main_b", "prog__a"}; !slices.Equal(keys, want) {
		t.Fatalf("got %v, want %v", keys, want)
	}
	if _, ok := readForcedKeys(read, []ShmSpec{{Key: "x"}}); ok {
		t.Fatal("ok without a single flag byte")
	}
	if specsHaveFlags([]ShmSpec{{Key: "x"}}) || !specsHaveFlags(specs) {
		t.Fatal("specsHaveFlags")
	}
}

func TestForcedTrackerFirstChangePeriodic(t *testing.T) {
	var ft forcedTracker
	t0 := time.Unix(0, 0)
	if f, ok := ft.next(nil, t0); !ok || f == nil {
		t.Fatal("first event must carry an (empty, non-null) set")
	}
	if _, ok := ft.next([]string{}, t0.Add(time.Second)); ok {
		t.Fatal("unchanged set resent early")
	}
	if f, ok := ft.next([]string{"a"}, t0.Add(time.Second)); !ok || f[0] != "a" {
		t.Fatal("change not sent")
	}
	if f, ok := ft.next([]string{}, t0.Add(time.Second)); !ok || len(f) != 0 {
		t.Fatal("release not sent")
	}
	if _, ok := ft.next([]string{}, t0.Add(time.Second+forcedResendEvery)); !ok {
		t.Fatal("no periodic resend")
	}
}
