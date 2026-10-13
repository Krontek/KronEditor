package main

import (
	"encoding/json"
	"testing"
)

// IEC TIME/LTIME reach KronServer as the variable-table type "int64" (signed
// microseconds, CTranspilerService.js IEC_TO_SERVER_TYPE). They used to be
// "uint32", so T#2h wrapped and a negative duration could not be written.
// Every path here is the generic int64 one; this pins the TIME values that
// matter: beyond 2^32, negative, and beyond 2^53 (must stay exact).
func TestTimeValuesAsInt64(t *testing.T) {
	if typeSizeMap[VarInt64] != 8 {
		t.Fatalf("typeSizeMap[int64] = %d, want 8", typeSizeMap[VarInt64])
	}
	cases := []struct {
		raw  string // as a REST/RPC client sends it
		want int64
	}{
		{`7200000000`, 7200000000},   // T#2h
		{`"7200000000"`, 7200000000}, // the same as a decimal string
		{`-5000000`, -5000000},       // T#-5s
		{`"-5000000"`, -5000000},
		{`"9007199254740993"`, 9007199254740993}, // > 2^53: only a string is exact
	}
	for _, c := range cases {
		b, err := encodeValue(VarInt64, json.RawMessage(c.raw))
		if err != nil || len(b) != 8 {
			t.Fatalf("encodeValue(int64, %s) = %v, %v", c.raw, b, err)
		}
		v, err := decodeValue(VarInt64, b)
		if err != nil || v != c.want {
			t.Fatalf("decodeValue after %s = %#v, %v; want %d", c.raw, v, err, c.want)
		}
	}
	if got := jsonSafe64(int64(9007199254740993)); got != "9007199254740993" {
		t.Fatalf("jsonSafe64 beyond 2^53 = %#v, want the decimal string", got)
	}
	if got := jsonSafe64(int64(-5000000)); got != int64(-5000000) {
		t.Fatalf("jsonSafe64(-5000000) = %#v", got)
	}
}
