package main

import "testing"

func TestLiveFilterEmptyMatchesEverything(t *testing.T) {
	f := NewLiveFilter()
	_, match := f.Snapshot()
	for _, k := range []string{"prog_Main_x", "prog__g", "anything"} {
		if !match(k) {
			t.Fatalf("empty filter rejected %q — a sim must start fully observable", k)
		}
	}
	// Explicitly clearing it must restore that, not leave the last subscription.
	f.Set([]string{"prog_Main_"}, nil)
	f.Set(nil, nil)
	if _, m := f.Snapshot(); !m("prog_Other_x") {
		t.Fatal("cleared filter still narrowing")
	}
}

func TestLiveFilterPrefixesAndNames(t *testing.T) {
	f := NewLiveFilter()
	f.Set([]string{"prog_Main_", "prog__"}, []string{"prog_Other_watched"})
	_, match := f.Snapshot()
	for _, k := range []string{"prog_Main_cnt", "prog_Main_ton.ET", "prog__gCounter", "prog____exec_us_Main", "prog_Other_watched"} {
		if !match(k) {
			t.Errorf("subscribed key %q not matched", k)
		}
	}
	for _, k := range []string{"prog_Other_cnt", "prog_Second_x"} {
		if match(k) {
			t.Errorf("unsubscribed key %q matched", k)
		}
	}
}

func TestLiveFilterGenerationMovesOnEverySet(t *testing.T) {
	f := NewLiveFilter()
	g0 := f.Gen()
	f.Set([]string{"prog_Main_"}, nil)
	g1 := f.Gen()
	if g1 == g0 {
		t.Fatal("generation unchanged — pollers would never rebuild their plan")
	}
	// Snapshot must report the generation its matcher belongs to, or a poller
	// could label a plan with a generation it was not built under.
	gen, match := f.Snapshot()
	if gen != g1 {
		t.Fatalf("snapshot generation %d, want %d", gen, g1)
	}
	f.Set(nil, []string{"x"})
	if !match("prog_Main_a") {
		t.Fatal("an already-taken matcher changed under a later Set")
	}
}
