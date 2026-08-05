//go:build darwin

package main

import (
	"fmt"
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
// agent reads it with the same ReadAt/WriteAt as Linux, and removeShmMirror
// becomes a plain os.Remove. The loader-host creates it (host.c, __APPLE__
// branch) using the identical name transformation below.
type shmMirror struct {
	f *os.File
}

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

// openShmMirror attaches to the mirror the running loader-host created. Fails
// while the host is still starting — callers treat that as "not up yet" and
// retry.
func openShmMirror(dir, name string, size int, write bool) (*shmMirror, error) {
	flag := os.O_RDONLY
	if write {
		flag = os.O_RDWR
	}
	f, err := os.OpenFile(mirrorPath(dir, name), flag, 0)
	if err != nil {
		return nil, err
	}
	// A file that exists but has not been sized yet means the host is between
	// creat() and ftruncate(). Reporting that as "not up" keeps the caller in
	// its retry loop instead of surfacing short reads as live values.
	if st, err := f.Stat(); err == nil && st.Size() < int64(size) {
		_ = f.Close()
		return nil, fmt.Errorf("mirror not sized yet (%d of %d bytes)", st.Size(), size)
	}
	return &shmMirror{f: f}, nil
}

func (m *shmMirror) ReadAt(b []byte, off int64) error {
	_, err := m.f.ReadAt(b, off)
	return err
}

func (m *shmMirror) WriteAt(b []byte, off int64) error {
	n, err := m.f.WriteAt(b, off)
	if err == nil && n != len(b) {
		return fmt.Errorf("short write (%d of %d)", n, len(b))
	}
	return err
}

func (m *shmMirror) Close() { _ = m.f.Close() }

// removeShmMirror drops a stale segment left by a previous run so a fresh cold
// start never reads another generation's values.
func removeShmMirror(dir, name string) { _ = os.Remove(mirrorPath(dir, name)) }
