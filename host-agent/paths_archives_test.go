package main

import (
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
