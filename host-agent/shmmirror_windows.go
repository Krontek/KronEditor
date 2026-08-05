//go:build windows

package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// shmMirror — Windows side. See shmmirror_unix.go for the contract.
//
// ⚠️ A Win32 named section has NO filesystem path, so there is nothing to open
// with os.OpenFile. We OpenFileMapping by name (never CreateFileMapping): the
// loader-host is the creator, and a section only lives as long as a handle to
// it is open. If the agent created it too, a stale segment would outlive a
// crashed host and the next run would read the previous generation's values.
type shmMirror struct {
	h    windows.Handle
	addr uintptr
	size int
}

// dir is the loader-host's working directory; unused on Windows, where the
// mapping lives in the kernel object namespace rather than on disk. It exists
// in the signature for the macOS implementation, which backs the mirror with a
// real file next to the build output.
func openShmMirror(dir, name string, size int, write bool) (*shmMirror, error) {
	if size <= 0 {
		return nil, fmt.Errorf("invalid mirror size %d", size)
	}
	access := uint32(windows.FILE_MAP_READ)
	if write {
		access = windows.FILE_MAP_READ | windows.FILE_MAP_WRITE
	}
	np, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	h, err := openFileMapping(access, np)
	if err != nil {
		return nil, fmt.Errorf("open shm mapping %q: %w", name, err)
	}
	addr, err := windows.MapViewOfFile(h, access, 0, 0, uintptr(size))
	if err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("map shm view %q: %w", name, err)
	}
	return &shmMirror{h: h, addr: addr, size: size}, nil
}

// view exposes the mapping as a slice. Bounds are checked by the callers below
// so a bad variables.json offset can never read or write outside the segment.
func (m *shmMirror) view() []byte {
	return unsafe.Slice((*byte)(unsafe.Pointer(m.addr)), m.size)
}

func (m *shmMirror) ReadAt(b []byte, off int64) error {
	if off < 0 || int(off)+len(b) > m.size {
		return fmt.Errorf("read at 0x%x len %d out of mirror bounds (%d)", off, len(b), m.size)
	}
	copy(b, m.view()[off:])
	return nil
}

func (m *shmMirror) WriteAt(b []byte, off int64) error {
	if off < 0 || int(off)+len(b) > m.size {
		return fmt.Errorf("write at 0x%x len %d out of mirror bounds (%d)", off, len(b), m.size)
	}
	copy(m.view()[off:], b)
	return nil
}

func (m *shmMirror) Close() {
	if m.addr != 0 {
		_ = windows.UnmapViewOfFile(m.addr)
		m.addr = 0
	}
	if m.h != 0 {
		_ = windows.CloseHandle(m.h)
		m.h = 0
	}
}

// removeShmMirror is a no-op on Windows: a named section is reference-counted
// by the kernel and disappears on its own once the loader-host (its only
// creator) exits. There is no name to unlink.
func removeShmMirror(dir, name string) {}

// x/sys/windows wraps CreateFileMapping but NOT OpenFileMapping, so bind it
// directly. Opening (rather than creating) is deliberate — see the type doc.
var (
	kernel32             = windows.NewLazySystemDLL("kernel32.dll")
	procOpenFileMappingW = kernel32.NewProc("OpenFileMappingW")
)

func openFileMapping(access uint32, name *uint16) (windows.Handle, error) {
	r, _, e := procOpenFileMappingW.Call(
		uintptr(access),
		0, // bInheritHandle = FALSE
		uintptr(unsafe.Pointer(name)),
	)
	if r == 0 {
		if e != nil && e != windows.ERROR_SUCCESS {
			return 0, e
		}
		return 0, windows.ERROR_FILE_NOT_FOUND
	}
	return windows.Handle(r), nil
}
