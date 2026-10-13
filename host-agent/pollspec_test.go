package main

import "testing"

// A STRING field in PlcState is its own text (kron_string_t, value
// semantics), so the legacy /proc/mem poller reads it in place; it used to
// skip it because the field was an 8-byte pointer.
func TestPollSpecReadsStringInPlace(t *testing.T) {
	ps, ok := newPollSpec("prog_Main_s", "STRING", 0x1000)
	if !ok || ps.size != plcStringBytes {
		t.Fatalf("STRING poll spec = %+v ok=%v, want size %d", ps, ok, plcStringBytes)
	}
	buf := make([]byte, plcStringBytes)
	copy(buf, "hello")
	if v := decodeValue(buf, ps.vtype); v != "hello" {
		t.Fatalf("decoded %q, want \"hello\"", v)
	}
	if _, ok := newPollSpec("x", "Rec", 0); ok {
		t.Fatal("an unsized user type must still be skipped")
	}
}
