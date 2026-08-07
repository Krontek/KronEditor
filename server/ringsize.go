// ringsize.go — sizing the lossless capture ring from a % of device RAM.
//
// The editor exposes a "capture buffer" as a percentage of the target's RAM.
// KronServer reads the device memory here, converts the % to a byte size (with
// safety clamps), and (re)creates the ring segment at that size right before it
// launches the runtime — so the runtime adopts KronServer's size and no env/
// argument has to survive a `sudo` env reset. See server/RING_FORMAT.md.
package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

const (
	ringDefaultBytes  = 1 << 20   // 1 MiB — standalone fallback when % not set
	ringMinBytes      = 64 << 10  // 64 KiB floor (a smaller ring is pointless)
	ringMaxBytes      = 512 << 20 // 512 MiB hard cap regardless of RAM
	ringMaxRAMPercent = 25.0      // never reserve more than 25% of *available* RAM
)

// readMemInfo returns MemTotal and MemAvailable in BYTES from /proc/meminfo.
// Returns (0,0) if unreadable (non-Linux dev host); callers fall back to a
// default byte size.
func readMemInfo() (total, available uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		key := line[:colon]
		if key != "MemTotal" && key != "MemAvailable" {
			continue
		}
		fields := strings.Fields(strings.TrimSpace(line[colon+1:]))
		if len(fields) == 0 {
			continue
		}
		kb, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			total = kb * 1024
		case "MemAvailable":
			available = kb * 1024
		}
	}
	return total, available
}

// ringBytesFromPercent converts a RAM percentage into a clamped ring byte size.
// pct <= 0 (unset) → the standalone default. Otherwise pct is clamped to
// ringMaxRAMPercent, applied to MemAvailable, and clamped to [min, min(512MiB,
// 25% of available)].
func ringBytesFromPercent(pct float64, memAvailable uint64) uint64 {
	if pct <= 0 || memAvailable == 0 {
		return ringDefaultBytes
	}
	if pct > ringMaxRAMPercent {
		pct = ringMaxRAMPercent
	}
	b := uint64(pct / 100.0 * float64(memAvailable))
	hardMax := uint64(ringMaxBytes)
	if capByRAM := memAvailable * uint64(ringMaxRAMPercent) / 100; capByRAM < hardMax {
		hardMax = capByRAM
	}
	if b > hardMax {
		b = hardMax
	}
	if b < ringMinBytes {
		b = ringMinBytes
	}
	return b
}

// createRingSegment (re)creates /dev/shm/<shmName>_ring at the given size so the
// runtime adopts it (the runtime only ftruncates when it finds the segment
// smaller than one header+record). Safe to call before each runtime (re)start —
// the previous runtime is already stopped by then.
func createRingSegment(shmName string, bytes uint64) error {
	path := "/dev/shm/" + shmName + "_ring"
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT, 0660)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return syscall.Ftruncate(fd, int64(bytes))
}
