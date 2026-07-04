package hotswaplib

import (
	"os"
	"path/filepath"
	"testing"
)

// TestPingPongAlternates verifies the core naming guarantee the user asked for:
// the generation only ever alternates between the two fixed slots {0,1} and
// never grows, no matter how many swaps happen.
func TestPingPongAlternates(t *testing.T) {
	// From a cold start at slot 0, 100 confirmed swaps must visit only 0 and 1,
	// strictly alternating.
	cur := 0
	seen := map[int]bool{cur: true}
	for i := 0; i < 100; i++ {
		next := PingPongGeneration(cur)
		if next == cur {
			t.Fatalf("swap %d: PingPongGeneration returned the SAME slot %d (must alternate)", i, cur)
		}
		if next != 0 && next != 1 {
			t.Fatalf("swap %d: slot %d outside the bounded {0,1} set — the number is growing", i, next)
		}
		seen[next] = true
		cur = next
	}
	if len(seen) != 2 {
		t.Fatalf("expected exactly slots {0,1} to be used, got %v", seen)
	}
}

// TestPingPongLegacyValue verifies an old monotonic value (e.g. logic_57.so left
// by a pre-upgrade deploy) still resolves to a valid {0,1} slot on the first
// swap after upgrade, so a device is never stuck.
func TestPingPongLegacyValue(t *testing.T) {
	for _, cur := range []int{2, 3, 10, 57, 58} {
		next := PingPongGeneration(cur)
		if next != 0 && next != 1 {
			t.Fatalf("legacy cur=%d resolved to non-bounded slot %d", cur, next)
		}
	}
	if PingPongGeneration(58) != 1 || PingPongGeneration(57) != 0 {
		t.Fatalf("even->1, odd->0 mapping broken")
	}
}

// TestPingPongLifecycleOnDisk simulates the full supervisor loop against a real
// directory: cold install (slot 0), then repeated ping-pong swaps, each
// compiling the new slot, then CleanupExcept after a "confirmed OK". Asserts
// that AT MOST two logic_*.so ever coexist and exactly one remains after each
// confirmed swap — proving files do not accumulate on a long-lived device.
func TestPingPongLifecycleOnDisk(t *testing.T) {
	dir := t.TempDir()
	touch := func(gen int) {
		if err := os.WriteFile(GenerationPath(dir, gen), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	countSlots := func() int {
		entries, _ := os.ReadDir(dir)
		n := 0
		for _, e := range entries {
			if _, ok := ParseGenFromName(e.Name()); ok {
				n++
			}
		}
		return n
	}

	// Cold install: exactly logic_0.so.
	if err := CleanupExcept(dir, -1); err != nil {
		t.Fatal(err)
	}
	touch(0)
	cur := 0 // confirmed-running generation (what a supervisor would track)

	for i := 0; i < 50; i++ {
		next := PingPongGeneration(cur)
		// Compile/upload the candidate into the OTHER slot.
		touch(next)
		if got := countSlots(); got != 2 {
			t.Fatalf("swap %d: expected 2 slots during swap, got %d", i, got)
		}
		// Confirmed OK → advance and clean up the old slot.
		cur = next
		if err := CleanupExcept(dir, cur); err != nil {
			t.Fatal(err)
		}
		if got := countSlots(); got != 1 {
			t.Fatalf("swap %d: expected 1 slot after cleanup, got %d", i, got)
		}
		// The single remaining file must be exactly the confirmed slot.
		if _, err := os.Stat(GenerationPath(dir, cur)); err != nil {
			t.Fatalf("swap %d: confirmed slot %d missing after cleanup", i, cur)
		}
	}

	// DiscoverGeneration must agree with the confirmed-running slot after a
	// clean confirmed swap (single file on disk).
	gen, _, ok := DiscoverGeneration(dir)
	if !ok || gen != cur {
		t.Fatalf("DiscoverGeneration=%d,ok=%v disagrees with confirmed cur=%d", gen, ok, cur)
	}
}

// TestTempGenerationPathDistinct ensures the temp compile path is never mistaken
// for a real slot by discovery (which would corrupt generation tracking).
func TestTempGenerationPathDistinct(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(TempGenerationPath(dir, 1), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := DiscoverGeneration(dir); ok {
		t.Fatalf("a stray %s was mistaken for a real logic slot", filepath.Base(TempGenerationPath(dir, 1)))
	}
}
