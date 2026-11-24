package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func parsedTable(t *testing.T, ipc *IPCManager, names ...string) *parsedVariableTable {
	t.Helper()
	vars := make([]Variable, len(names))
	for i, n := range names {
		vars[i] = Variable{Name: n, Offset: 4 * i, Type: VarInt32, Size: 4, MbIndex: intPtr(i)}
	}
	pt, err := ipc.ParseVariableTable(tableJSON(t, vars, ""))
	if err != nil {
		t.Fatal(err)
	}
	return pt
}

func hasVar(ipc *IPCManager, name string) bool {
	ipc.mu.RLock()
	defer ipc.mu.RUnlock()
	_, ok := ipc.vars[name]
	return ok
}

// A table uploaded after a new runtime.bin, while the PREVIOUS runtime still
// runs, must not serve that runtime: it waits for the next spawn, which is
// the one running the new binary.
func TestVariableTableWaitsForTheRuntimeItBelongsTo(t *testing.T) {
	ipc := newTestIPC(65536)
	s := &Server{ipc: ipc}
	s.placeVariableTable(parsedTable(t, ipc, "old_a", "old_b"), false)
	s.ActivateStagedTable() // the old program is spawned (spawnedGen = binGen)

	s.binGen++ // Build & Send: /deploy/runtime
	if staged := s.placeVariableTable(parsedTable(t, ipc, "new_b", "new_a"), true); !staged {
		t.Fatal("table for a not-yet-started binary applied under the running old runtime")
	}
	if !hasVar(ipc, "old_a") || hasVar(ipc, "new_a") {
		t.Fatal("the running runtime is no longer served by its own table")
	}
	if !s.VariableTableStaged() {
		t.Fatal("staged table not reported")
	}

	s.ActivateStagedTable() // pre-start hook of the restart
	if !hasVar(ipc, "new_a") || hasVar(ipc, "old_a") {
		t.Fatal("staged table not activated by the spawn of the new binary")
	}
	if s.VariableTableStaged() {
		t.Fatal("table still reported staged after activation")
	}
}

// When the running process already IS the newest binary (a crash-restart
// between the runtime and the table upload, or a table-only redeploy), or
// nothing runs, the table applies at once.
func TestVariableTableAppliesAtOnceForTheCurrentBinary(t *testing.T) {
	ipc := newTestIPC(65536)
	s := &Server{ipc: ipc}
	s.binGen++
	s.ActivateStagedTable() // spawned from the newest binary
	if staged := s.placeVariableTable(parsedTable(t, ipc, "a"), true); staged || !hasVar(ipc, "a") {
		t.Fatal("table for the running binary was not applied")
	}
	s.binGen++
	if staged := s.placeVariableTable(parsedTable(t, ipc, "b"), false); staged || !hasVar(ipc, "b") {
		t.Fatal("table not applied with no runtime running")
	}
}

// /deploy/runtime bumps the binary generation the staging decision keys off.
func TestDeployRuntimeAdvancesBinaryGeneration(t *testing.T) {
	dir := t.TempDir()
	s := &Server{cfg: Config{DeployDir: dir}, pm: NewProcessManager(dir)}
	req := httptest.NewRequest(http.MethodPost, "/deploy/runtime", strings.NewReader("ELF..."))
	rec := httptest.NewRecorder()
	s.handleDeployRuntime(rec, req)
	if rec.Code != http.StatusOK || s.binGen != 1 {
		t.Fatalf("HTTP %d, binGen %d", rec.Code, s.binGen)
	}
}

// A restart that fails must not answer 200: Build & Send would report a
// deploy whose runtime is not running.
func TestConfigResultReportsStartFailure(t *testing.T) {
	rec := httptest.NewRecorder()
	writeConfigResult(rec, map[string]any{"auto_run": true}, errors.New("runtime binary not found"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "runtime binary not found") || !strings.Contains(rec.Body.String(), `"auto_run":true`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	writeConfigResult(rec, map[string]any{"auto_run": true}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// End to end through the handler: restart with no runtime.bin deployed.
func TestDeployConfigRestartFailureIs500(t *testing.T) {
	dir := t.TempDir()
	s := &Server{cfg: Config{DeployDir: dir}, ipc: newTestIPC(65536), pm: NewProcessManager(dir)}
	req := httptest.NewRequest(http.MethodPost, "/deploy/config", strings.NewReader(`{"restart":true}`))
	rec := httptest.NewRecorder()
	s.handleDeployConfig(rec, req)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "runtime start failed") {
		t.Fatalf("HTTP %d: %s", rec.Code, rec.Body.String())
	}
}
