package main

import "testing"

// The field failure this whole change exists for: at 100 kHz with one 8-byte
// variable the record stride is 24 B, so production is 2.4 MB/s. The runtime's
// own fallback is 1 MiB — 0.43 s of slack — which trips the decimation
// controller's fill watermark within half a second of the first client connect.
const (
	testStride100kHz = 24
	testPeriod100kHz = 10 // us
)

func layout(stride, periodUs int) *RingConfig {
	return &RingConfig{
		RecordStride: stride,
		Tasks: []RingTaskLayout{{
			TaskID: 0, PeriodUs: periodUs,
			Vars: []RingVar{{Name: "Var0", Type: "uint64", Size: 8}},
		}},
	}
}

func TestRingProducedBytesPerSecUsesStrideNotPayload(t *testing.T) {
	got := ringProducedBytesPerSec(layout(testStride100kHz, testPeriod100kHz))
	want := 24.0 / 10 * 1e6 // 2.4 MB/s
	if got != want {
		t.Fatalf("produced = %v B/s, want %v (payload-only would give %v)",
			got, want, 8.0/10*1e6)
	}
	if ringProducedBytesPerSec(nil) != 0 {
		t.Fatal("nil layout must produce 0")
	}
	if ringProducedBytesPerSec(&RingConfig{RecordStride: 0}) != 0 {
		t.Fatal("zero stride must produce 0")
	}
}

func TestRingBytesForTargetsSecondsNotThePercentage(t *testing.T) {
	var avail uint64 = 3_674_042_368 // the field device: ~3.4 GiB available
	p := ringProducedBytesPerSec(layout(testStride100kHz, testPeriod100kHz))

	got := ringBytesFor(50, avail, p)
	want := uint64(p * ringTargetSeconds) // 24 MB
	if got != want {
		t.Fatalf("bytes = %d, want %d (10 s of production)", got, want)
	}

	// The whole point: the 50%% ceiling must NOT become the size.
	if ceiling := uint64(0.5 * float64(avail)); got >= ceiling {
		t.Fatalf("bytes = %d took the RAM ceiling %d instead of the target", got, ceiling)
	}
	// ...and it must be far larger than the 1 MiB fallback that caused the bug.
	if got <= ringDefaultBytes {
		t.Fatalf("bytes = %d is no better than the runtime fallback %d", got, ringDefaultBytes)
	}
}

func TestRingBytesForClampsToTheRAMCeiling(t *testing.T) {
	// A tiny device with a very fast project: the ceiling must win.
	var avail uint64 = 128 << 20                 // 128 MiB available
	p := ringProducedBytesPerSec(layout(96, 10)) // 9.6 MB/s -> wants 96 MB
	got := ringBytesFor(10, avail, p)            // ceiling = 12.8 MB
	if want := uint64(0.10 * float64(avail)); got != want {
		t.Fatalf("bytes = %d, want the ceiling %d", got, want)
	}
}

func TestRingBytesForWithoutALayoutFallsBackNotToTheCeiling(t *testing.T) {
	var avail uint64 = 3_674_042_368
	got := ringBytesFor(50, avail, 0)
	if got != ringDefaultBytes {
		t.Fatalf("bytes = %d, want the standalone default %d when nothing "+
			"will write to the ring", got, ringDefaultBytes)
	}
}

func TestRingBytesForRespectsFloorAndHardCap(t *testing.T) {
	if got := ringBytesFor(50, 4<<30, 1); got != ringMinBytes {
		t.Fatalf("a near-zero rate must clamp up to %d, got %d", ringMinBytes, got)
	}
	// No /proc/meminfo (dev host) and a huge rate: the absolute cap applies.
	if got := ringBytesFor(50, 0, 1e12); got != ringMaxBytes {
		t.Fatalf("bytes = %d, want the hard cap %d", got, ringMaxBytes)
	}
	// pct out of range is clamped, never trusted verbatim
	if ringBytesFor(500, 1<<30, 1e12) != ringBytesFor(ringMaxRAMPercent, 1<<30, 1e12) {
		t.Fatal("pct above ringMaxRAMPercent must clamp")
	}
}
