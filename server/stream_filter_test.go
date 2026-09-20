package main

import (
	"net/url"
	"testing"
)

func TestStreamVarMatcherNoParamsMeansNoFilter(t *testing.T) {
	// An older editor sends no query at all; it must keep receiving everything.
	if streamVarMatcher(url.Values{}) != nil {
		t.Fatal("empty query produced a filter")
	}
	q, _ := url.ParseQuery("p=&v=")
	if streamVarMatcher(q) != nil {
		t.Fatal("blank params produced a filter")
	}
}

func TestStreamVarMatcherPrefixesAndNames(t *testing.T) {
	q, _ := url.ParseQuery("p=prog_Main_,prog__&v=prog_Other_watched,prog_Third_hmi")
	match := streamVarMatcher(q)
	if match == nil {
		t.Fatal("no matcher built")
	}
	for _, k := range []string{"prog_Main_cnt", "prog__gCounter", "prog_Other_watched", "prog_Third_hmi"} {
		if !match(k) {
			t.Errorf("subscribed key %q not matched", k)
		}
	}
	for _, k := range []string{"prog_Other_cnt", "prog_Third_x"} {
		if match(k) {
			t.Errorf("unsubscribed key %q matched", k)
		}
	}
}

func TestStreamVarMatcherIgnoresBlankAndPaddedEntries(t *testing.T) {
	q, _ := url.ParseQuery("p=" + url.QueryEscape(" prog_Main_ ,,") + "&v=" + url.QueryEscape(", prog__g ,"))
	match := streamVarMatcher(q)
	if match == nil {
		t.Fatal("no matcher built")
	}
	if !match("prog_Main_x") || !match("prog__g") {
		t.Fatal("padded entries not trimmed")
	}
	// A blank entry must not become a prefix that matches everything.
	if match("prog_Other_x") {
		t.Fatal("blank entry became a match-all prefix")
	}
}
