package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The archives have inter-dependencies (libkron_axis.a calls MotionLimitsInit /
// GenerateTrajectory / BrakeDistance, all in libTrajectoryGenerator.a) and a
// classic linker scans each archive once, in command-line order. Byte-sorted,
// an uppercase name lands BEFORE a lowercase one — so the provider is already
// past when the consumer is pulled in, and the link dies with an undefined
// reference. The group is what makes the order irrelevant.
func writeArchives(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("!<arch>\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestCollectStaticArchivesPutsUppercaseFirst(t *testing.T) {
	dir := writeArchives(t, "libkron_axis.a", "libTrajectoryGenerator.a", "notes.txt")
	got := CollectStaticArchives(dir)
	if len(got) != 2 {
		t.Fatalf("want 2 archives, got %v", got)
	}
	// Documents the hazard rather than the preference: this order is exactly
	// the one that fails without a group.
	if filepath.Base(got[0]) != "libTrajectoryGenerator.a" {
		t.Fatalf("expected the byte-sorted order that motivates the group, got %v", got)
	}
}

func TestStaticArchiveLinkArgsGroupsOnELF(t *testing.T) {
	dir := writeArchives(t, "libkron_axis.a", "libTrajectoryGenerator.a")
	args := staticArchiveLinkArgs(dir, false)
	if len(args) != 4 {
		t.Fatalf("want group + 2 archives + end, got %v", args)
	}
	if args[0] != "-Wl,--start-group" || args[len(args)-1] != "-Wl,--end-group" {
		t.Fatalf("archives are not wrapped in a link group: %v", args)
	}
	for _, want := range []string{"libTrajectoryGenerator.a", "libkron_axis.a"} {
		found := false
		for _, a := range args {
			if strings.HasSuffix(a, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s dropped from the link line: %v", want, args)
		}
	}
}

// ld64 rejects --start-group outright, and needs no equivalent: it already
// re-scans archives until nothing new resolves.
func TestStaticArchiveLinkArgsNoGroupOnMachO(t *testing.T) {
	dir := writeArchives(t, "libkron_axis.a", "libTrajectoryGenerator.a")
	args := staticArchiveLinkArgs(dir, true)
	for _, a := range args {
		if strings.HasPrefix(a, "-Wl,--start-group") || strings.HasPrefix(a, "-Wl,--end-group") {
			t.Fatalf("Mach-O link line must not carry a group: %v", args)
		}
	}
	if len(args) != 2 {
		t.Fatalf("want the two archives, got %v", args)
	}
}

func TestStaticArchiveLinkArgsEmptyDirAddsNoFlags(t *testing.T) {
	if args := staticArchiveLinkArgs(t.TempDir(), false); len(args) != 0 {
		t.Fatalf("empty lib dir must contribute nothing, got %v", args)
	}
}

// ⚠️ The loader-host links the static archives whenever host_glue.c exists, so
// since the axis engine moved into its bus thread the host carries the whole
// motion stack — KronAxis_Submit included. A logic swap recompiles only
// logic.so, whose MC_*_Call/KronAxis_* are undefined symbols bound to the HOST,
// so a rebuilt libkron_axis.a reaches nothing unless the host's cache key moves
// with it. It did not, and a fixed library appeared to change nothing at all.
func TestMixStaticArchivesReactsToARebuiltLibrary(t *testing.T) {
	dir := writeArchives(t, "libkron_axis.a", "libTrajectoryGenerator.a")

	digest := func() string {
		h := sha256.New()
		mixStaticArchives(h, dir)
		return hex.EncodeToString(h.Sum(nil))
	}

	before := digest()
	if before == digest() {
		// stable for identical input — required, or the host would rebuild forever
	} else {
		t.Fatal("hash is not stable for unchanged archives")
	}

	// Same name, same length, different bytes: exactly what rebuilding one
	// library looks like, and what an mtime- or size-based key can miss.
	if err := os.WriteFile(filepath.Join(dir, "libkron_axis.a"), []byte("!<arch>X"), 0o644); err != nil {
		t.Fatal(err)
	}
	if after := digest(); after == before {
		t.Fatal("a rebuilt archive left the loader-host cache key unchanged — the stale host would be reused")
	}
}

func TestMixStaticArchivesIgnoresNonArchives(t *testing.T) {
	dir := writeArchives(t, "libkron_axis.a")
	h := sha256.New()
	mixStaticArchives(h, dir)
	before := hex.EncodeToString(h.Sum(nil))

	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("irrelevant"), 0o644); err != nil {
		t.Fatal(err)
	}
	h2 := sha256.New()
	mixStaticArchives(h2, dir)
	if hex.EncodeToString(h2.Sum(nil)) != before {
		t.Fatal("a non-archive file moved the cache key and would force needless host rebuilds")
	}
}
