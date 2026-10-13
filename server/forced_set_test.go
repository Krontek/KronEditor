package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/krontek/hotswaplib/shmcmd"
)

// forcedTestIPC builds an IPCManager over a private in-memory segment — no
// /dev/shm needed: three variables, two of them addressed.
func forcedTestIPC() *IPCManager {
	b := make([]uint64, shmcmd.SegmentSize/8)
	mem := unsafe.Slice((*byte)(unsafe.Pointer(&b[0])), shmcmd.SegmentSize)
	vars := map[string]Variable{
		"prog__speed":     {Name: "prog__speed", Offset: 0, Type: VarFloat64, Size: 8, ForceFlagOffset: 32768, Address: "%ML0"},
		"prog__run":       {Name: "prog__run", Offset: 8, Type: VarBool, Size: 1, ForceFlagOffset: 32769, Address: "%MX8.0"},
		"prog_Main_local": {Name: "prog_Main_local", Offset: 12, Type: VarInt32, Size: 4, ForceFlagOffset: 32770},
		"prog__noflag":    {Name: "prog__noflag", Offset: 16, Type: VarInt32, Size: 4},
	}
	addressed := map[string]Variable{"prog__speed": vars["prog__speed"], "prog__run": vars["prog__run"]}
	return &IPCManager{mem: mem, shmSize: len(mem), vars: vars, addressedVars: addressed}
}

func TestForcedVariablesReadsFlagBytes(t *testing.T) {
	ipc := forcedTestIPC()
	if got := ipc.ForcedVariables(false); got == nil || len(got) != 0 {
		t.Fatalf("nothing forced: got %#v, want an empty non-nil list", got)
	}
	ipc.mem[32770] = shmcmd.FlagForced // unaddressed local
	ipc.mem[32768] = shmcmd.FlagForced // addressed
	ipc.mem[32769] = 2                 // v1 PULSE: transient, not a force
	ipc.mem[0] = shmcmd.FlagForced     // prog__noflag has no flag byte at all
	if got, want := ipc.ForcedVariables(false), []string{"prog_Main_local", "prog__speed"}; !slices.Equal(got, want) {
		t.Fatalf("all: got %v, want %v", got, want)
	}
	// REST scope: addressed variables only.
	if got, want := ipc.ForcedVariables(true), []string{"prog__speed"}; !slices.Equal(got, want) {
		t.Fatalf("addressed: got %v, want %v", got, want)
	}
}

func TestForcedTrackerSendsFirstChangeAndPeriodic(t *testing.T) {
	var ft forcedTracker
	t0 := time.Unix(1000, 0)
	if got, ok := ft.next(nil, t0); !ok || got == nil || len(got) != 0 {
		t.Fatalf("first event must carry the set (empty, not null): %v %v", got, ok)
	}
	if _, ok := ft.next([]string{}, t0.Add(50*time.Millisecond)); ok {
		t.Fatal("unchanged set resent before the period")
	}
	if got, ok := ft.next([]string{"a"}, t0.Add(100*time.Millisecond)); !ok || !slices.Equal(got, []string{"a"}) {
		t.Fatal("change not sent")
	}
	// Release → an explicit empty list.
	if got, ok := ft.next([]string{}, t0.Add(150*time.Millisecond)); !ok || len(got) != 0 {
		t.Fatal("release not sent")
	}
	if _, ok := ft.next([]string{}, t0.Add(150*time.Millisecond+forcedResendEvery)); !ok {
		t.Fatal("no periodic resend")
	}
}

// readSSEEvents reads n "data:" payloads from a live /stream/vars response.
func readSSEEvents(t *testing.T, srv *httptest.Server, query string, n int) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/stream/vars"+query, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []map[string]any
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() && len(out) < n {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line[6:]), &ev); err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	return out
}

func TestStreamVarsCarriesForcedKeyDespiteFilter(t *testing.T) {
	ipc := forcedTestIPC()
	ipc.mem[32770] = shmcmd.FlagForced
	s := &Server{ipc: ipc}
	srv := httptest.NewServer(http.HandlerFunc(s.handleSSEVars))
	defer srv.Close()

	// Subscribed to globals only — the forced local must still be listed.
	evs := readSSEEvents(t, srv, "?p=prog__", 2)
	if len(evs) != 2 {
		t.Fatalf("got %d events", len(evs))
	}
	first := evs[0]
	forced, ok := first[forcedStreamKey].([]any)
	if !ok || len(forced) != 1 || forced[0] != "prog_Main_local" {
		t.Fatalf("first event __forced = %#v", first[forcedStreamKey])
	}
	if _, leaked := first["prog_Main_local"]; leaked {
		t.Fatal("the forced set widened the value subscription")
	}
	if _, ok := first["prog__speed"]; !ok {
		t.Fatal("subscribed value missing")
	}
	// Unchanged 50 ms later → omitted.
	if _, ok := evs[1][forcedStreamKey]; ok {
		t.Fatal("unchanged forced set resent on the next tick")
	}
}

func TestRESTListForcesIsAddressedOnly(t *testing.T) {
	ipc := forcedTestIPC()
	ipc.mem[32768] = shmcmd.FlagForced
	ipc.mem[32770] = shmcmd.FlagForced
	am := &APIManager{ipc: ipc}
	rec := httptest.NewRecorder()
	am.handleListForces(rec, httptest.NewRequest("GET", "/api/v1/forces", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var body struct {
		Forced []string `json:"forced"`
		Count  int      `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Count != 1 || !slices.Equal(body.Forced, []string{"prog__speed"}) {
		t.Fatalf("got %+v", body)
	}
}
