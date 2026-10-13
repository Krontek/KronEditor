package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/krontek/hotswaplib"
)

// newTestIPC builds an IPCManager over a plain byte slice — no /dev/shm — so
// table/flag logic can be tested without a real segment.
func newTestIPC(size int) *IPCManager {
	return &IPCManager{shmSize: size, mem: make([]byte, size), vars: map[string]Variable{}}
}

func tableJSON(t *testing.T, vars []Variable, pwHash string) []byte {
	t.Helper()
	b, err := json.Marshal(VariableTable{Variables: vars, APIPasswordHash: pwHash, APIPasswordSalt: "s"})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// NaN/±Inf must decode to nil (JSON null): one non-finite REAL used to make
// json.Marshal refuse the WHOLE map, blanking every stream frame.
func TestDecodeValueMapsNonFiniteToNull(t *testing.T) {
	cases := map[string][]byte{}
	b8 := make([]byte, 8)
	binary.LittleEndian.PutUint64(b8, math.Float64bits(math.NaN()))
	cases["f64 NaN"] = append([]byte(nil), b8...)
	binary.LittleEndian.PutUint64(b8, math.Float64bits(math.Inf(-1)))
	cases["f64 -Inf"] = append([]byte(nil), b8...)
	b4 := make([]byte, 4)
	binary.LittleEndian.PutUint32(b4, math.Float32bits(float32(math.Inf(1))))
	cases["f32 +Inf"] = b4

	m := map[string]any{"ok": 1.5}
	for name, raw := range cases {
		typ := VarFloat64
		if len(raw) == 4 {
			typ = VarFloat32
		}
		v, err := decodeValue(typ, raw)
		if err != nil || v != nil {
			t.Fatalf("%s: decodeValue = (%v, %v), want (nil, nil)", name, v, err)
		}
		m[name] = v
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("a map with decoded non-finite values must marshal: %v", err)
	}
	if !strings.Contains(string(data), `"f64 NaN":null`) {
		t.Fatalf("NaN not encoded as null: %s", data)
	}
	if _, err := toProtoStruct(m); err != nil {
		t.Fatalf("structpb conversion failed: %v", err)
	}
}

// jsonOK must not answer 200 with an empty body when encoding fails.
func TestJSONOKReportsEncodingFailure(t *testing.T) {
	rec := httptest.NewRecorder()
	jsonOK(rec, map[string]any{"x": math.NaN()})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("empty body on encoding failure")
	}
	rec = httptest.NewRecorder()
	jsonOK(rec, map[string]any{"x": 1})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"x":1`) {
		t.Fatalf("happy path broken: %d %q", rec.Code, rec.Body.String())
	}
}

// A rejected variable table must never replace the deployed file.
func TestRejectedVariableTableKeepsDeployedFile(t *testing.T) {
	dir := t.TempDir()
	ipc := newTestIPC(65536)
	s := &Server{cfg: Config{DeployDir: dir}, ipc: ipc}
	good := tableJSON(t, []Variable{{Name: "a", Offset: 0, Type: VarInt32, Size: 4, ForceFlagOffset: forceFlagsBase}}, "")

	post := func(body []byte) int {
		req := httptest.NewRequest(http.MethodPost, "/deploy/variable-table", strings.NewReader(string(body)))
		rec := httptest.NewRecorder()
		s.handleDeployVariableTable(rec, req)
		return rec.Code
	}
	if code := post(good); code != http.StatusOK {
		t.Fatalf("good table: HTTP %d", code)
	}
	bad := tableJSON(t, []Variable{{Name: "a", Offset: 70000, Type: VarInt32, Size: 4}}, "")
	if code := post(bad); code != http.StatusUnprocessableEntity {
		t.Fatalf("bad table: HTTP %d, want 422", code)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "variable_table.json"))
	if err != nil || string(onDisk) != string(good) {
		t.Fatalf("deployed file was replaced by a rejected table: %q (%v)", onDisk, err)
	}
	if ipc.VariableCount() != 1 {
		t.Fatalf("in-memory table changed: %d vars", ipc.VariableCount())
	}
}

// Force flags are index-keyed: a DIFFERENT table must start with a clean flag
// region, the SAME table (crash-restart, plain restart) must keep its forces.
func TestForceFlagsClearedOnlyWhenTheTableChanges(t *testing.T) {
	ipc := newTestIPC(65536)
	load := func(vars []Variable) {
		pt, err := ipc.ParseVariableTable(tableJSON(t, vars, ""))
		if err != nil {
			t.Fatal(err)
		}
		ipc.ApplyVariableTable(pt)
	}
	v1 := []Variable{
		{Name: "a", Offset: 0, Type: VarBool, Size: 1, ForceFlagOffset: forceFlagsBase},
		{Name: "b", Offset: 1, Type: VarBool, Size: 1, ForceFlagOffset: forceFlagsBase + 1},
	}
	load(v1)
	ipc.MarkTableStarted()
	ipc.mem[forceFlagsBase+1] = 1 // "b" forced
	ipc.mem[forceFlagsBase+500] = 1

	ipc.ClearForcesIfTableChanged() // same table → keep
	if ipc.mem[forceFlagsBase+1] != 1 {
		t.Fatal("force flag cleared although the table did not change")
	}

	// Redeploy with a variable inserted before "b": flag index 1 now means "x".
	load([]Variable{
		{Name: "a", Offset: 0, Type: VarBool, Size: 1, ForceFlagOffset: forceFlagsBase},
		{Name: "x", Offset: 1, Type: VarBool, Size: 1, ForceFlagOffset: forceFlagsBase + 1},
		{Name: "b", Offset: 2, Type: VarBool, Size: 1, ForceFlagOffset: forceFlagsBase + 2},
	})
	ipc.mem[5] = 42 // data below the region is untouched
	ipc.ClearForcesIfTableChanged()
	if ipc.mem[forceFlagsBase+1] != 0 || ipc.mem[forceFlagsBase+500] != 0 {
		t.Fatal("stale force flags survived a table change")
	}
	if ipc.mem[5] != 42 {
		t.Fatal("data region was touched")
	}
	// A second start with that same new table keeps new forces.
	ipc.mem[forceFlagsBase+2] = 1
	ipc.ClearForcesIfTableChanged()
	if ipc.mem[forceFlagsBase+2] != 1 {
		t.Fatal("forces cleared on a restart with an unchanged table")
	}
}

// A new API password revokes the tokens issued under the old one.
func TestAPITokensRevokedOnPasswordChange(t *testing.T) {
	ipc := newTestIPC(65536)
	am := NewAPIManager(ipc, nil, "x")
	load := func(hash string) {
		pt, err := ipc.ParseVariableTable(tableJSON(t, nil, hash))
		if err != nil {
			t.Fatal(err)
		}
		ipc.ApplyVariableTable(pt)
	}
	load(hashPassword("s", "old"))
	tok := am.sessions.Create("api_client", RoleOperator).Token
	load(hashPassword("s", "old")) // same password: token survives
	if _, ok := am.sessions.Get(tok); !ok {
		t.Fatal("token revoked although the password did not change")
	}
	load(hashPassword("s", "new"))
	if _, ok := am.sessions.Get(tok); ok {
		t.Fatal("token still valid after the API password changed")
	}
}

// /hotswap/swap must accept only a bare ping-pong slot name.
func TestSwapLogicRejectsPathLikeNames(t *testing.T) {
	pm := NewProcessManager(t.TempDir())
	for _, name := range []string{"../logic_0.so", "/tmp/logic_1.so", "logic_2.so", "x/logic_0.so", "logic_0.so.tmp"} {
		_, _, err := pm.SwapLogic(name)
		if err == nil || !strings.Contains(err.Error(), "invalid logic name") {
			t.Fatalf("%q: err = %v, want an invalid-name rejection", name, err)
		}
	}
	// A valid name gets past validation (and then fails because nothing runs).
	if _, _, err := pm.SwapLogic("logic_1.so"); err == nil || strings.Contains(err.Error(), "invalid logic name") {
		t.Fatalf("logic_1.so: err = %v", err)
	}
}

// A plain runtime upload removes stale logic slots so the next start does not
// launch the self-contained binary as a loader-host.
func TestDeployRuntimeDropsStaleLogicSlots(t *testing.T) {
	dir := t.TempDir()
	s := &Server{cfg: Config{DeployDir: dir}, pm: NewProcessManager(dir)}
	for _, g := range []int{0, 1} {
		if err := os.WriteFile(hotswaplib.GenerationPath(dir, g), []byte("so"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(dir, "swap_result"), []byte("OK 1"), 0o644)
	req := httptest.NewRequest(http.MethodPost, "/deploy/runtime", strings.NewReader("ELF..."))
	rec := httptest.NewRecorder()
	s.handleDeployRuntime(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", rec.Code, rec.Body.String())
	}
	if _, _, ok := hotswaplib.DiscoverGeneration(dir); ok {
		t.Fatal("logic slot left behind after a plain runtime deploy")
	}
	if _, err := os.Stat(filepath.Join(dir, "swap_result")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("swap_result left behind")
	}
}

// A Stop that lands while a crash-restart is pending (or already firing) wins.
func TestRestartTimerAbortsAfterStop(t *testing.T) {
	pm := NewProcessManager(t.TempDir())
	pm.mu.Lock()
	pm.autoRunGetter = func() bool { return true }
	pm.scheduleRestartLocked()
	epoch := pm.restartEpoch
	pm.mu.Unlock()

	if err := pm.Stop(); err != nil {
		t.Fatal(err)
	}
	// Simulate the timer callback having passed its first check just before
	// the Stop: the spawn itself must still refuse.
	if err := pm.start(int64(epoch)); !errors.Is(err, errRestartSuperseded) {
		t.Fatalf("start after Stop = %v, want errRestartSuperseded", err)
	}
}

// Cold start prefers the last confirmed generation over the highest on disk.
func TestColdStartPrefersConfirmedGeneration(t *testing.T) {
	dir := t.TempDir()
	pm := NewProcessManager(dir)
	for _, g := range []int{0, 1} {
		if err := os.WriteFile(hotswaplib.GenerationPath(dir, g), []byte("so"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if gen, _, ok := pm.coldStartGenerationLocked(); !ok || gen != 1 {
		t.Fatalf("no confirmed generation: got %d, want the highest on disk (1)", gen)
	}
	pm.lastGoodGen = 0
	if gen, _, ok := pm.coldStartGenerationLocked(); !ok || gen != 0 {
		t.Fatalf("got generation %d, want the confirmed one (0)", gen)
	}
	// The confirmed slot is gone (a cold deploy wiped it): fall back to disk.
	_ = os.Remove(hotswaplib.GenerationPath(dir, 0))
	if gen, _, ok := pm.coldStartGenerationLocked(); !ok || gen != 1 {
		t.Fatalf("got generation %d after the confirmed slot vanished, want 1", gen)
	}
}
