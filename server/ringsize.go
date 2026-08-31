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
	ringDefaultBytes   = 1 << 20  // 1 MiB — standalone runtime fallback (no KronServer)
	ringMinBytes       = 64 << 10 // 64 KiB floor (a smaller ring is pointless)
	ringMaxBytes       = 2 << 30  // 2 GiB hard cap regardless of RAM
	ringMaxRAMPercent  = 50.0     // never reserve more than 50% of *available* RAM
	ringDefaultPercent = 50.0     // ceiling default when the device config is unset

	// ringTargetSeconds is how long a link stall the ring should absorb without
	// losing a scan. This — not the RAM percentage — is the PRIMARY sizing input.
	//
	// ⚠️ Bigger is NOT better, and the reason is latency, not memory. /dev/shm is
	// tmpfs (demand-paged) and the producer never initialises slots, so an
	// oversized segment costs no RSS until it actually fills. What it does cost
	// is reaction time: the decimation controller trips on `fill = backlog /
	// nslots`, a FRACTION, so on a 1.8 GB / 76M-slot ring a consumer that cannot
	// keep up stays undetected for ~6 minutes while the data it is reading goes
	// that stale. Ten seconds of production is far more than any TCP hiccup and
	// still surfaces sustained overload within a few seconds.
	ringTargetSeconds = 10.0
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

// ringProducedBytesPerSec is the rate the deployed project will write INTO THE
// RING, from the variable table's layout — available before the runtime has ever
// run, which is what makes pre-start sizing possible.
//
// ⚠️ It multiplies by RecordStride, not payload_len: a record occupies a whole
// stride-sized slot in the segment, so payload-only would undersize the ring by
// the 16-byte record header (3x for a single 8-byte variable).
func ringProducedBytesPerSec(cfg *RingConfig) float64 {
	if cfg == nil || cfg.RecordStride <= 0 {
		return 0
	}
	var bps float64
	for _, t := range cfg.Tasks {
		if t.PeriodUs > 0 && len(t.Vars) > 0 {
			bps += float64(cfg.RecordStride) / float64(t.PeriodUs) * 1e6
		}
	}
	return bps
}

// ringBytesFor resolves the capture-ring byte size:
//
//	min( P x ringTargetSeconds , pct% x MemAvailable )   clamped to [min, max]
//
// The RAM percentage is a CEILING (what the device may give up), not the target.
// Using it as the target is what produced the two failure modes seen in the
// field: a segment far larger than any burst needs (hiding overload for
// minutes), or — when the sizing never ran at all — the runtime's own 1 MiB
// fallback, which at 100 kHz is 0.43 s of slack and trips the decimation
// controller within half a second of the first connect.
func ringBytesFor(pct float64, memAvailable uint64, producedBytesPerSec float64) uint64 {
	if pct <= 0 {
		pct = ringDefaultPercent
	}
	if pct > ringMaxRAMPercent {
		pct = ringMaxRAMPercent
	}

	ceiling := uint64(ringMaxBytes)
	if memAvailable > 0 {
		if byRAM := uint64(pct / 100.0 * float64(memAvailable)); byRAM < ceiling {
			ceiling = byRAM
		}
	}

	// No deployed layout (no addressed variables, or the variable table has not
	// been uploaded yet): fall back to the standalone default rather than
	// reserving the whole ceiling for a ring nothing is going to write to.
	want := uint64(ringDefaultBytes)
	if producedBytesPerSec > 0 {
		want = uint64(producedBytesPerSec * ringTargetSeconds)
	}
	if want > ceiling {
		want = ceiling
	}
	if want < ringMinBytes {
		want = ringMinBytes
	}
	return want
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
