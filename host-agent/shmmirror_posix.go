//go:build !windows

package main

import (
	"fmt"
	"os"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// shmMirror is the agent's handle on the loader-host's shared-memory mirror —
// the single place live values are read from and force-write commands are
// posted into. The three platforms create the segment very differently (POSIX
// shm object vs Win32 named section vs a plain mmap'd file on macOS); only the
// PATH differs between Linux and macOS (shmMirrorPath, per-OS files), and
// everything above addresses the mirror purely by byte offset.
//
// ⚠️ MAPPED, not read with pread/pwrite. The force-write mailbox (SHM layout
// v2) needs real atomic loads/stores and compare-and-swap on words the
// runtime's task threads touch concurrently, and a file write is a memcpy in
// the kernel with no such guarantee. Live-value reads use one atomic access
// per naturally aligned slot for the same reason (no half-old/half-new LREAL).
type shmMirror struct {
	f    *os.File
	mem  []byte
	size int
}

// openShmMirror attaches to the mirror the running loader-host created. name is
// the POSIX shm name emitted by the generated plc.c (plc_shm_name()), e.g.
// "/plc_runtime"; dir is the loader-host's working directory (macOS keeps the
// mirror there). Fails while the host is still starting — callers treat that
// as "not up yet" and retry.
func openShmMirror(dir, name string, size int, write bool) (*shmMirror, error) {
	if size <= 0 {
		return nil, fmt.Errorf("invalid mirror size %d", size)
	}
	flag, prot := os.O_RDONLY, syscall.PROT_READ
	if write {
		flag, prot = os.O_RDWR, syscall.PROT_READ|syscall.PROT_WRITE
	}
	f, err := os.OpenFile(shmMirrorPath(dir, name), flag, 0)
	if err != nil {
		return nil, err
	}
	// A segment that exists but has not been sized yet means the host is
	// between creat() and ftruncate(). Mapping past EOF would SIGBUS the agent
	// on first touch, so report "not up" and let the caller retry.
	if st, err := f.Stat(); err != nil || st.Size() < int64(size) {
		_ = f.Close()
		if err == nil {
			err = fmt.Errorf("mirror not sized yet (%d of %d bytes)", st.Size(), size)
		}
		return nil, err
	}
	mem, err := syscall.Mmap(int(f.Fd()), 0, size, prot, syscall.MAP_SHARED)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("mmap mirror: %w", err)
	}
	return &shmMirror{f: f, mem: mem, size: size}, nil
}

// checkBounds rejects an offset/length pair that falls outside the segment.
// ⚠️ The offset comes from the client-supplied variable table and is not
// validated upstream (KronServer validates its own copy; the host agent never
// did) — on a mapping an out-of-range access is a crash, not an error.
func (m *shmMirror) checkBounds(off int64, n int) error {
	if off < 0 || n < 0 || off+int64(n) > int64(m.size) {
		return fmt.Errorf("access at 0x%x len %d out of mirror bounds (%d)", off, n, m.size)
	}
	return nil
}

// ReadAt copies a slot out. 1/2/4/8-byte reads at a naturally aligned offset
// are single atomic loads (SHM layout v2 aligns every slot to its width).
func (m *shmMirror) ReadAt(b []byte, off int64) error {
	if err := m.checkBounds(off, len(b)); err != nil {
		return err
	}
	loadScalarOrCopy(m.mem, int(off), b)
	return nil
}

// Bytes is the whole mapped segment (the force-write mailbox works on it).
func (m *shmMirror) Bytes() []byte { return m.mem }

func (m *shmMirror) Close() {
	if m.mem != nil {
		_ = syscall.Munmap(m.mem)
		m.mem = nil
	}
	if m.f != nil {
		_ = m.f.Close()
		m.f = nil
	}
}

// loadScalarOrCopy reads n = len(dst) bytes at off with one atomic access when
// the slot is a naturally aligned 4- or 8-byte scalar, else a plain copy (a
// 1/2-byte aligned load is a single access anyway; text is a memcpy — STRING
// is read-only and a torn display line is tolerated).
func loadScalarOrCopy(mem []byte, off int, dst []byte) {
	p := unsafe.Pointer(&mem[off])
	switch {
	case len(dst) == 8 && uintptr(p)%8 == 0:
		v := atomic.LoadUint64((*uint64)(p))
		for i := 0; i < 8; i++ {
			dst[i] = byte(v >> (8 * i))
		}
	case len(dst) == 4 && uintptr(p)%4 == 0:
		v := atomic.LoadUint32((*uint32)(p))
		for i := 0; i < 4; i++ {
			dst[i] = byte(v >> (8 * i))
		}
	default:
		copy(dst, mem[off:off+len(dst)])
	}
}
