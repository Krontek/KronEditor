//go:build !windows && !darwin

package main

import (
	"fmt"
	"os"
)

// shmMirror is the agent's handle on the loader-host's shared-memory mirror —
// the single place live values are read from and force-writes are injected
// into. The three platforms create the segment very differently (POSIX shm
// object vs Win32 named section vs a plain mmap'd file on macOS), so the
// difference is confined to this set of files and everything above addresses
// the mirror purely by byte offset.
//
// On Linux a POSIX shm object is just a file under /dev/shm, so ordinary
// ReadAt/WriteAt is the whole implementation.
type shmMirror struct {
	f *os.File
}

// openShmMirror attaches to the mirror the running loader-host created. name is
// the POSIX shm name emitted by the generated plc.c (plc_shm_name()), e.g.
// "/plc_runtime". Fails while the host is still starting — callers treat that
// as "not up yet" and retry.
//
// dir is the loader-host's working directory; unused on Linux, where the
// segment is named in the global /dev/shm namespace rather than placed on
// disk. It exists in the signature for the macOS implementation, which backs
// the mirror with a real file next to the build output.
func openShmMirror(dir, name string, size int, write bool) (*shmMirror, error) {
	flag := os.O_RDONLY
	if write {
		flag = os.O_RDWR
	}
	f, err := os.OpenFile("/dev/shm"+name, flag, 0)
	if err != nil {
		return nil, err
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
func removeShmMirror(dir, name string) { _ = os.Remove("/dev/shm" + name) }
