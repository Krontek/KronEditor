//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
)

// macOS mirror — a plain mmap'd FILE, not a POSIX shm object.
//
// ⚠️ This is the one place macOS could not reuse the Linux implementation, and
// the reason is not cosmetic. Linux exposes every POSIX shm object as a file
// under /dev/shm, so the agent reads live values with ordinary ReadAt/WriteAt
// on a path. macOS has no /dev/shm at all: a shm_open'd object is invisible to
// the filesystem, so the agent could only reach it by calling shm_open itself —
// which means cgo, since neither the standard library nor x/sys/unix wraps it
// on darwin. Adding cgo to the agent for this one call would cost us
// CGO_ENABLED=0 cross-builds for a segment that is process-local anyway.
//
// Apple's shm_open also carries two limits that would bite this design
// specifically: names are capped at 31 characters, and an object may be
// ftruncate'd only ONCE in its lifetime — so a second cold start against a
// surviving segment cannot resize it, and there is no reliable way for the
// agent to unlink a stale one.
//
// Backing the mirror with a regular file in the loader-host's working
// directory (the build dir) sidesteps all of it: mmap(MAP_SHARED) on a file
// gives exactly the same coherent shared page the other platforms provide, the
// agent maps it with the same code as Linux (shmmirror_posix.go), and
// removeShmMirror becomes a plain os.Remove. The loader-host creates it
// (host.c, __APPLE__ branch) using the identical name transformation below.

// mirrorPath maps the POSIX shm name emitted by the generated plc.c
// ("/plc_runtime") onto the backing file the loader-host creates in its working
// directory ("<dir>/plc_runtime.mirror").
//
// ⚠️ host.c's mirror_path() performs the SAME transformation. If either side
// changes, the agent silently reads a file nobody writes and every live value
// freezes at zero — change both together.
func mirrorPath(dir, name string) string {
	return filepath.Join(dir, strings.TrimPrefix(name, "/")+".mirror")
}

// shmMirrorPath is what shmmirror_posix.go maps.
func shmMirrorPath(dir, name string) string { return mirrorPath(dir, name) }

// removeShmMirror drops a stale segment left by a previous run so a fresh cold
// start never reads another generation's values.
func removeShmMirror(dir, name string) { _ = os.Remove(mirrorPath(dir, name)) }
