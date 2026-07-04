package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/krontek/hotswaplib"
)

// TestDeployLogicPingPong verifies the target-side generation naming:
//   - a cold deploy always lands on logic_0.so and wipes stale slots,
//   - an online deploy lands on the OTHER slot from the CONFIRMED-running gen,
//   - the number never climbs past {0,1} no matter how many rounds,
//   - a stale higher-numbered leftover is cleaned up rather than continued.
func TestDeployLogicPingPong(t *testing.T) {
	dir := t.TempDir()
	pm := NewProcessManager(dir)
	s := &Server{cfg: Config{DeployDir: dir}, pm: pm}

	post := func(query string) string {
		req := httptest.NewRequest(http.MethodPost, "/deploy/logic"+query, strings.NewReader("dummy-so-bytes"))
		rec := httptest.NewRecorder()
		s.handleDeployLogic(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("deploy%s: HTTP %d: %s", query, rec.Code, rec.Body.String())
		}
		var resp struct{ Logic string }
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("deploy%s: bad json: %v", query, err)
		}
		return resp.Logic
	}
	slots := func() []string {
		entries, _ := os.ReadDir(dir)
		var out []string
		for _, e := range entries {
			if _, ok := hotswaplib.ParseGenFromName(e.Name()); ok {
				out = append(out, e.Name())
			}
		}
		return out
	}

	// Pre-seed a stale high-numbered leftover from an imagined old (monotonic) deploy.
	if err := os.WriteFile(hotswaplib.GenerationPath(dir, 57), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Cold deploy wipes the stale slot and installs exactly logic_0.so.
	if got := post("?cold=1"); got != "logic_0.so" {
		t.Fatalf("cold deploy = %q, want logic_0.so", got)
	}
	if s := slots(); len(s) != 1 || s[0] != "logic_0.so" {
		t.Fatalf("after cold deploy slots = %v, want [logic_0.so]", s)
	}

	// Simulate the loader-host running generation 0 (as spawnRuntime would set),
	// then run 20 online deploy+confirm rounds. Each must alternate 0<->1 and
	// the file count must stay bounded.
	pm.curGen = 0
	for i := 0; i < 20; i++ {
		name := post("")
		want := hotswaplib.GenerationPath(dir, hotswaplib.PingPongGeneration(pm.curGen))
		if name != wantBase(want) {
			t.Fatalf("round %d: online deploy = %q, want %q (confirmed gen %d)", i, name, wantBase(want), pm.curGen)
		}
		// Two slots may briefly coexist (old + new candidate) — never more.
		if got := slots(); len(got) > 2 {
			t.Fatalf("round %d: %d slots on disk (%v) — the number is growing", i, len(got), got)
		}
		// Confirm the swap: advance the certain-running gen and clean the other,
		// mirroring ProcessManager.SwapLogic's OK branch.
		gen, _ := hotswaplib.ParseGenFromName(name)
		pm.curGen = gen
		_ = hotswaplib.CleanupExcept(dir, gen)
	}

	// Final state: exactly one slot, and it is a member of {0,1}.
	final := slots()
	if len(final) != 1 || (final[0] != "logic_0.so" && final[0] != "logic_1.so") {
		t.Fatalf("final slots = %v, want a single logic_0/1.so", final)
	}
}

func wantBase(p string) string {
	i := strings.LastIndexByte(p, '/')
	return p[i+1:]
}
