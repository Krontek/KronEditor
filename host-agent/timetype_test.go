package main

import (
	"encoding/binary"
	"testing"
)

// IEC TIME/LTIME are signed 64-bit microseconds (kronstandard.h). The pollers
// and the force-write encoder used to treat TIME as a uint32, so T#2h wrapped
// and T#-5s could not be represented at all.
func TestTimeIsSigned64BitMicroseconds(t *testing.T) {
	for _, typ := range []string{"TIME", "LTIME", "time"} {
		if n := typeSize(typ); n != 8 {
			t.Fatalf("typeSize(%q) = %d, want 8", typ, n)
		}
		ps, ok := newMirrorPollSpec("prog_Main_t", typ, 0, 8)
		if !ok || ps.size != 8 {
			t.Fatalf("mirror poll spec for %q = %+v ok=%v", typ, ps, ok)
		}
	}

	cases := []struct {
		raw  string
		want any
	}{
		{"7200000000", int64(7200000000)},                // T#2h — beyond the old uint32 range
		{"-5000000", int64(-5000000)},                    // T#-5s
		{"9007199254740993", "9007199254740993"},         // beyond 2^53 → exact decimal string
		{"-9223372036854775808", "-9223372036854775808"}, // int64 min
	}
	for _, c := range cases {
		b, ok := encodeValue("TIME", c.raw)
		if !ok || len(b) != 8 {
			t.Fatalf("encodeValue(TIME, %s) = %v ok=%v, want 8 bytes", c.raw, b, ok)
		}
		if got := decodeValue(b, "TIME"); got != c.want {
			t.Fatalf("round trip %s: got %#v, want %#v", c.raw, got, c.want)
		}
	}
	if _, ok := encodeValue("TIME", "9223372036854775808"); ok {
		t.Fatal("a value beyond int64 must be refused, not wrapped")
	}
}

// The legacy /proc/mem sim reads a whole TON/TOF struct: three int64 times
// followed by the IN/Q/M bytes.
func TestDecodeTONStruct64(t *testing.T) {
	if n := typeSize("TON"); n != 32 {
		t.Fatalf("typeSize(TON) = %d, want 32", n)
	}
	buf := make([]byte, 32)
	binary.LittleEndian.PutUint64(buf[0:], uint64(7200000000))
	binary.LittleEndian.PutUint64(buf[8:], uint64(4294967301))
	binary.LittleEndian.PutUint64(buf[16:], uint64(1000))
	buf[24], buf[25], buf[26] = 1, 0, 1
	m, ok := decodeValue(buf, "TON").(map[string]interface{})
	if !ok {
		t.Fatal("TON did not decode to a map")
	}
	if m["PT"] != int64(7200000000) || m["ET"] != int64(4294967301) || m["StartTime"] != int64(1000) {
		t.Fatalf("TON times = %v", m)
	}
	if m["IN"] != true || m["Q"] != false || m["M"] != true {
		t.Fatalf("TON flags = %v", m)
	}
}
