package main

import (
	"bytes"
	"debug/dwarf"
	"debug/elf"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type VarSpec struct {
	Key     string
	Address uint64
	VType   string
}

type SimState struct {
	mu       sync.Mutex
	cmd      *exec.Cmd
	pid      int
	varSpecs []VarSpec
	stopCh   chan struct{}
	done     chan struct{} // closed by the reaper goroutine (the ONLY cmd.Wait caller)
}

func NewSimState() *SimState {
	return &SimState{}
}

// Stop kills a running simulation and waits for its reaper to confirm the
// process is gone. exec.Cmd.Wait must only ever be called once, so Stop never
// calls Wait itself — the reaper goroutine spawned in handleRunSimulation owns
// Wait and closes `done`. Returns whether a simulation was actually running.
func (s *SimState) Stop() bool {
	s.mu.Lock()
	cmd, ch, done := s.cmd, s.stopCh, s.done
	s.cmd = nil
	s.pid = 0
	s.varSpecs = nil
	s.stopCh = nil
	s.done = nil
	s.mu.Unlock()

	if ch != nil {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	if cmd == nil {
		return false
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}
	return true
}

// ── run_simulation ───────────────────────────────────────────────────────────

func (s *Server) handleRunSimulation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	// ⚠️ This is the LEGACY plain-sim path: it runs the binary and reads its
	// variables out of /proc/<pid>/mem using ELF/DWARF symbol offsets. Neither
	// exists on Windows or macOS, and porting it would mean a PE- or
	// Mach-O-aware reader plus ReadProcessMemory / mach_vm_read (the latter
	// additionally blocked by SIP and task_for_pid entitlements) for no
	// user-visible gain — hot-swap is the default sim runtime and reads the
	// shared-memory mirror by variables.json offset, so it needs no debug info
	// at all. Fail with a clear reason rather than letting parseELFSymbols
	// report "bad magic" on a PE or Mach-O file.
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		writeError(w, http.StatusBadRequest,
			"the plain simulation runtime is Linux-only; this platform uses the hot-swap runtime (POST /api/host/hotswap/run)")
		return
	}
	buildDir := s.paths.BuildDir()
	binPath := filepath.Join(buildDir, simBin)
	varTablePath := filepath.Join(buildDir, "variables.json")

	vtBytes, err := os.ReadFile(varTablePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read variables.json: "+err.Error())
		return
	}
	var varTable map[string]interface{}
	if err := json.Unmarshal(vtBytes, &varTable); err != nil {
		writeError(w, http.StatusInternalServerError, "parse variables.json: "+err.Error())
		return
	}

	symbols, err := parseELFSymbols(binPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	specs := buildVarSpecs(varTable, symbols)
	if len(specs) == 0 {
		writeError(w, http.StatusBadRequest, "No variables matched in symbol table")
		return
	}

	s.sim.mu.Lock()
	if s.sim.cmd != nil {
		s.sim.mu.Unlock()
		writeError(w, http.StatusConflict, "Simulation is already running")
		return
	}
	cmd := exec.Command(binPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		s.sim.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "spawn: "+err.Error())
		return
	}
	s.sim.cmd = cmd
	s.sim.pid = cmd.Process.Pid
	s.sim.varSpecs = specs
	stopCh := make(chan struct{})
	done := make(chan struct{})
	s.sim.stopCh = stopCh
	s.sim.done = done
	pid := s.sim.pid
	s.sim.mu.Unlock()

	s.events.Emit("simulation-output", map[string]any{"status": "started"})

	go s.simulationPoller(pid, specs, stopCh)
	// Reaper: the ONLY cmd.Wait caller for this process. Stop() just kills and
	// then waits on `done` — never a second Wait (which races/panics).
	go func() {
		_ = cmd.Wait()
		close(done)
		s.sim.mu.Lock()
		if s.sim.cmd == cmd {
			s.sim.cmd = nil
			s.sim.pid = 0
			s.sim.varSpecs = nil
			s.sim.done = nil
			if s.sim.stopCh != nil {
				close(s.sim.stopCh)
				s.sim.stopCh = nil
			}
		}
		s.sim.mu.Unlock()
		s.events.Emit("simulation-output", map[string]any{"status": "exited"})
	}()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pid": pid, "message": "Simulation started"})
}

// ── sim_status ───────────────────────────────────────────────────────────────
// Reports whether a local simulation process is currently running. Used by the
// editor on (re)load to re-attach to a sim it started before the tab was closed
// — the host-agent keeps the sim + its /proc poller alive across browser reloads.
func (s *Server) handleSimStatus(w http.ResponseWriter, r *http.Request) {
	s.sim.mu.Lock()
	plainCmd := s.sim.cmd
	plainPid := s.sim.pid
	s.sim.mu.Unlock()

	s.hotswap.mu.Lock()
	hsCmd := s.hotswap.cmd
	hsPid := s.hotswap.pid
	s.hotswap.mu.Unlock()

	// The simulation now runs as a hot-swap loader-host by default, so report
	// that too (mode "hotswap"). A plain sim (legacy path) reports mode "plain".
	running := plainCmd != nil || hsCmd != nil
	mode := ""
	pid := 0
	if hsCmd != nil {
		mode, pid = "hotswap", hsPid
	} else if plainCmd != nil {
		mode, pid = "plain", plainPid
	}
	writeJSON(w, http.StatusOK, map[string]any{"running": running, "pid": pid, "mode": mode})
}

// ── stop_simulation ──────────────────────────────────────────────────────────

func (s *Server) handleStopSimulation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	if !s.sim.Stop() {
		writeError(w, http.StatusBadRequest, "No simulation running")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Simulation stopped"})
}

// ── write_variable ───────────────────────────────────────────────────────────

type writeVariableReq struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	// Mode selects the force-flag semantics in the hot-swap sim: "force" (default)
	// holds the value every scan; "pulse" injects it for a single scan then the
	// logic resumes (the generated plc_shm_pull auto-clears a pulse flag).
	Mode string `json:"mode"`
}

func (s *Server) handleWriteVariable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req writeVariableReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.sim.mu.Lock()
	pid := s.sim.pid
	var spec *VarSpec
	for i := range s.sim.varSpecs {
		if s.sim.varSpecs[i].Key == req.Name {
			spec = &s.sim.varSpecs[i]
			break
		}
	}
	s.sim.mu.Unlock()
	if pid == 0 {
		// The DEFAULT simulation is the hot-swap loader-host, not the plain
		// sim — force-write through its /dev/shm mirror instead.
		s.writeHotSwapVariable(w, req)
		return
	}
	if spec == nil {
		writeError(w, http.StatusNotFound, "Variable not found: "+req.Name)
		return
	}
	data, ok := encodeValue(spec.VType, req.Value)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Cannot encode %q as %s", req.Value, spec.VType))
		return
	}
	// Re-check the pid under the lock: it was read before encodeValue, and a
	// Stop() in that window frees the number for reuse — a /proc/<pid>/mem
	// write would then land in an unrelated process. The gap is microseconds
	// (unlike the hot-swap path, which had a clang run in it), but the check
	// is free.
	s.sim.mu.Lock()
	stillRunning := s.sim.pid == pid
	s.sim.mu.Unlock()
	if !stillRunning {
		writeError(w, http.StatusConflict, "simulation stopped while the write was being prepared")
		return
	}
	if err := writeProcMem(pid, spec.Address, data); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── plc-variables SSE (dedicated channel) ────────────────────────────────────
//
// The generic /api/host/events stream carries everything; this dedicated
// endpoint matches the existing PLCClient `streamVars` API shape (just a
// flat `{ varName: value, ... }` JSON object per event).

func (s *Server) handlePlcVariables(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := make(chan map[string]interface{}, 16)
	s.sim.subscribePlcVars(ch)
	defer s.sim.unsubscribePlcVars(ch)

	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case vars := <-ch:
			payload, err := json.Marshal(vars)
			if err != nil {
				plcVarsMarshalLogOnce.Do(func() { log.Printf("plc-variables: marshal failed (frame dropped): %v", err) })
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
	}
}

// plcVarsMarshalLogOnce keeps a persistent marshal failure from flooding the log.
var plcVarsMarshalLogOnce sync.Once

// SimState also maintains a fan-out for variable snapshots used by handlePlcVariables.
var plcVarSubsMu sync.Mutex
var plcVarSubs = make(map[chan map[string]interface{}]struct{})

func (s *SimState) subscribePlcVars(ch chan map[string]interface{}) {
	plcVarSubsMu.Lock()
	plcVarSubs[ch] = struct{}{}
	plcVarSubsMu.Unlock()
}
func (s *SimState) unsubscribePlcVars(ch chan map[string]interface{}) {
	plcVarSubsMu.Lock()
	delete(plcVarSubs, ch)
	plcVarSubsMu.Unlock()
}
func broadcastPlcVars(vars map[string]interface{}) {
	plcVarSubsMu.Lock()
	defer plcVarSubsMu.Unlock()
	for ch := range plcVarSubs {
		select {
		case ch <- vars:
		default:
		}
	}
}

// ── simulation poller ────────────────────────────────────────────────────────

func (s *Server) simulationPoller(pid int, specs []VarSpec, stop <-chan struct{}) {
	plan, bufSize := make([]pollSpec, 0, len(specs)), 0
	for _, sp := range specs {
		if ps, ok := newPollSpec(sp.Key, sp.VType, sp.Address); ok {
			plan = append(plan, ps)
			if ps.size > bufSize {
				bufSize = ps.size
			}
		}
	}
	if len(plan) == 0 {
		return // nothing readable — don't wake up 5 times a second to say so
	}
	// One scratch buffer for the whole run: decodeValue never retains buf (each
	// branch copies scalars out or builds a fresh map), so allocating one per
	// variable per tick was pure garbage.
	buf := make([]byte, bufSize)

	memPath := fmt.Sprintf("/proc/%d/mem", pid)
	time.Sleep(100 * time.Millisecond)
	// ⚠️ The fd is held OPEN across ticks. Re-opening cost an open+close pair
	// (plus a redundant Stat) every 200 ms for a path whose identity cannot
	// change during a run — the pid is fixed and the process is ours.
	f, err := os.Open(memPath)
	if err != nil {
		s.events.Emit("simulation-output", map[string]any{"error": "Failed to open process memory"})
		return
	}
	defer f.Close()

	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		vars := make(map[string]interface{}, len(plan))
		anyOK := false
		for _, sp := range plan {
			if _, err := f.ReadAt(buf[:sp.size], sp.offset); err == nil {
				vars[sp.key] = decodeValue(buf[:sp.size], sp.vtype)
				anyOK = true
			}
		}
		if anyOK {
			s.events.Emit("simulation-output", map[string]any{"vars": vars})
			broadcastPlcVars(vars)
			continue
		}
		// Nothing read at all. A dead process is the likely cause and the
		// poller used to end the goroutine on that (it Stat'd the path at the
		// top of every tick), so confirm it here instead — on the failure path
		// only, and never ending the run over a transient read error.
		if _, err := os.Stat(memPath); err != nil {
			return
		}
	}
}

// ── ELF symbol parsing ───────────────────────────────────────────────────────

func parseELFSymbols(path string) (map[string]uint64, error) {
	f, err := elf.Open(path)
	if err != nil {
		return nil, fmt.Errorf("parse ELF %s: %w", path, err)
	}
	defer f.Close()
	out := make(map[string]uint64)
	syms, _ := f.Symbols()
	for _, sym := range syms {
		if sym.Value == 0 || sym.Name == "" {
			continue
		}
		out[sym.Name] = sym.Value
	}
	dyn, _ := f.DynamicSymbols()
	for _, sym := range dyn {
		if sym.Value == 0 || sym.Name == "" {
			continue
		}
		if _, exists := out[sym.Name]; !exists {
			out[sym.Name] = sym.Value
		}
	}
	// PLC variables are now fields of `static PlcState __plc_state` (hot-swap
	// refactor), reached via `S->field` — so the individual variable C symbols
	// (prog_X_v, …) the variable table references are NOT standalone globals.
	// Resolve each PlcState member's absolute address (base of __plc_state +
	// member offset from DWARF) and register it under the member name, so
	// buildVarSpecs() matches c_symbol/base_symbol exactly as before. Skipped
	// silently for old-style binaries (no __plc_state) or builds without DWARF.
	base, ok := out["__plc_state"]
	if !ok {
		// clang can suffix internal-linkage symbols (__plc_state.1); tolerate it.
		for n, v := range out {
			if strings.HasPrefix(n, "__plc_state.") {
				base, ok = v, true
				break
			}
		}
	}
	if ok {
		if offs, err := plcStateMemberOffsets(f); err == nil {
			for name, off := range offs {
				if _, exists := out[name]; !exists {
					out[name] = base + uint64(off)
				}
			}
		}
	}
	return out, nil
}

// plcStateMemberOffsets reads the byte offset of each direct member of the
// `PlcState` struct from the binary's DWARF debug info.
func plcStateMemberOffsets(f *elf.File) (map[string]int64, error) {
	d, err := f.DWARF()
	if err != nil {
		return nil, err
	}
	r := d.Reader()
	for {
		e, err := r.Next()
		if err != nil {
			return nil, err
		}
		if e == nil {
			break
		}
		if e.Tag != dwarf.TagStructType {
			continue
		}
		if name, _ := e.Val(dwarf.AttrName).(string); name != "PlcState" {
			continue
		}
		offs := make(map[string]int64)
		if !e.Children {
			return offs, nil
		}
		for {
			kid, err := r.Next()
			if err != nil {
				return nil, err
			}
			if kid == nil || kid.Tag == 0 { // null DIE closes the child list
				break
			}
			if kid.Tag == dwarf.TagMember {
				if mname, _ := kid.Val(dwarf.AttrName).(string); mname != "" {
					offs[mname] = dwarfMemberOffset(kid)
				}
			} else if kid.Children {
				r.SkipChildren()
			}
		}
		return offs, nil
	}
	return nil, fmt.Errorf("PlcState struct not found in DWARF")
}

// dwarfMemberOffset extracts DW_AT_data_member_location, which clang emits as a
// constant (DWARF ≥4) or, older, as a DW_OP_plus_uconst location expression.
func dwarfMemberOffset(e *dwarf.Entry) int64 {
	switch x := e.Val(dwarf.AttrDataMemberLoc).(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case uint64:
		return int64(x)
	case []byte:
		if len(x) >= 2 && x[0] == 0x23 { // DW_OP_plus_uconst <uleb128>
			off, _ := readULEB128(x[1:])
			return int64(off)
		}
	}
	return 0
}

func readULEB128(b []byte) (uint64, int) {
	var result uint64
	var shift uint
	for i := 0; i < len(b); i++ {
		result |= uint64(b[i]&0x7f) << shift
		if b[i]&0x80 == 0 {
			return result, i + 1
		}
		shift += 7
	}
	return result, len(b)
}

// ── variable table parsing ───────────────────────────────────────────────────

func buildVarSpecs(varTable map[string]interface{}, symbols map[string]uint64) []VarSpec {
	var specs []VarSpec
	if programs, ok := varTable["programs"].(map[string]interface{}); ok {
		for prog, info := range programs {
			progMap, _ := info.(map[string]interface{})
			vars, _ := progMap["variables"].(map[string]interface{})
			for name, vInfo := range vars {
				vMap, _ := vInfo.(map[string]interface{})
				cSym, _ := vMap["c_symbol"].(string)
				vType, _ := vMap["type"].(string)
				if vType == "" {
					vType = "BOOL"
				}
				if addr, ok := symbols[cSym]; ok {
					specs = append(specs, VarSpec{
						Key:     fmt.Sprintf("prog_%s_%s", prog, name),
						Address: addr,
						VType:   vType,
					})
				}
			}
		}
	}
	if gvars, ok := varTable["globalVars"].(map[string]interface{}); ok {
		for name, vInfo := range gvars {
			vMap, _ := vInfo.(map[string]interface{})
			cSym, _ := vMap["c_symbol"].(string)
			if cSym == "" {
				cSym = name
			}
			vType, _ := vMap["type"].(string)
			if vType == "" {
				vType = "BOOL"
			}
			if addr, ok := symbols[cSym]; ok {
				specs = append(specs, VarSpec{
					Key:     "prog__" + name,
					Address: addr,
					VType:   vType,
				})
			}
		}
	}
	if debug, ok := varTable["debugDefaults"].(map[string]interface{}); ok {
		for key, entry := range debug {
			eMap, _ := entry.(map[string]interface{})
			baseSym, ok := eMap["base_symbol"].(string)
			if !ok {
				continue
			}
			byteOffset, _ := eMap["byte_offset"].(float64)
			vType, _ := eMap["type"].(string)
			if vType == "" {
				vType = "BOOL"
			}
			if baseAddr, ok := symbols[baseSym]; ok {
				specs = append(specs, VarSpec{
					Key:     key,
					Address: baseAddr + uint64(byteOffset),
					VType:   vType,
				})
			}
		}
	}
	return specs
}

// ── type encoding/decoding ───────────────────────────────────────────────────

// pollSpec is a poller's precomputed view of one monitored variable. The
// pollers run at 5 Hz for the whole life of a run, so everything that does not
// change between ticks is resolved ONCE here: the size (typeSize is a
// strings.ToUpper + switch) and the type name already upper-cased, which makes
// decodeValue's own ToUpper hit its no-allocation fast path.
type pollSpec struct {
	key    string
	vtype  string
	offset int64
	size   int
}

// newPollSpec reports false for a type with no readable size, so the unreadable
// variables are dropped from the plan instead of being re-tested every tick.
func newPollSpec(key, vtype string, offset uint64) (pollSpec, bool) {
	size := typeSize(vtype)
	if size == 0 {
		return pollSpec{}, false
	}
	return pollSpec{key: key, vtype: strings.ToUpper(vtype), offset: int64(offset), size: size}, true
}

// newMirrorPollSpec is newPollSpec for the SHM MIRROR, where a slot's width
// comes from the deployed variable table instead of the C type. ⚠️ The two
// cannot be merged: the legacy /proc/mem poller reads PlcState directly, where
// a STRING field is an 8-byte `char *` and not the text, so typeSize keeps
// returning 0 for it and that poller keeps skipping it. Reading the table
// width there would hand back whatever bytes follow the pointer.
func newMirrorPollSpec(key, vtype string, offset uint64, tableSize int) (pollSpec, bool) {
	size := typeSize(vtype)
	if size == 0 && isTextType(vtype) {
		size = tableSize
	}
	if size <= 0 || size > maxMirrorSlotBytes {
		return pollSpec{}, false
	}
	return pollSpec{key: key, vtype: strings.ToUpper(vtype), offset: int64(offset), size: size}, true
}

func isTextType(t string) bool {
	u := strings.ToUpper(t)
	return u == "STRING" || u == "WSTRING"
}

// maxMirrorSlotBytes bounds a width taken from an on-disk variable table.
const maxMirrorSlotBytes = 1024

func typeSize(t string) int {
	switch strings.ToUpper(t) {
	case "BOOL", "SINT", "USINT", "BYTE":
		return 1
	case "INT", "UINT", "WORD":
		return 2
	case "DINT", "UDINT", "TIME", "REAL", "DWORD":
		return 4
	case "LINT", "ULINT", "LREAL", "LWORD":
		return 8
	case "TON", "TOF":
		return 16
	case "CTU":
		return 8
	default:
		return 0
	}
}

func decodeValue(buf []byte, t string) interface{} {
	switch strings.ToUpper(t) {
	case "BOOL":
		return buf[0] != 0
	case "SINT":
		return int8(buf[0])
	case "USINT", "BYTE":
		return buf[0]
	case "INT":
		return int16(binary.LittleEndian.Uint16(buf[:2]))
	case "UINT", "WORD":
		return binary.LittleEndian.Uint16(buf[:2])
	case "DINT":
		return int32(binary.LittleEndian.Uint32(buf[:4]))
	case "UDINT", "TIME", "DWORD":
		return binary.LittleEndian.Uint32(buf[:4])
	case "LINT":
		return int64(binary.LittleEndian.Uint64(buf[:8]))
	case "ULINT", "LWORD":
		return binary.LittleEndian.Uint64(buf[:8])
	case "REAL":
		return sanitizeFloat(float64(math.Float32frombits(binary.LittleEndian.Uint32(buf[:4]))), true)
	case "LREAL":
		return sanitizeFloat(math.Float64frombits(binary.LittleEndian.Uint64(buf[:8])), false)
	case "STRING", "WSTRING":
		// A fixed, NUL-padded slot in the shm mirror (a full slot has no
		// terminator). ToValidUTF8 guards json.Marshal the same way
		// sanitizeFloat guards it for NaN: the bytes come from a device file,
		// and one stray byte would drop the WHOLE variable frame.
		b := buf
		if i := bytes.IndexByte(b, 0); i >= 0 {
			b = b[:i]
		}
		return strings.ToValidUTF8(string(b), "")
	case "TON", "TOF":
		if len(buf) >= 15 {
			return map[string]interface{}{
				"PT":        binary.LittleEndian.Uint32(buf[0:4]),
				"ET":        binary.LittleEndian.Uint32(buf[4:8]),
				"StartTime": binary.LittleEndian.Uint32(buf[8:12]),
				"IN":        buf[12] != 0,
				"Q":         buf[13] != 0,
				"M":         buf[14] != 0,
			}
		}
	case "CTU":
		if len(buf) >= 8 {
			return map[string]interface{}{
				"PV":    int16(binary.LittleEndian.Uint16(buf[0:2])),
				"CV":    int16(binary.LittleEndian.Uint16(buf[2:4])),
				"CU":    buf[4] != 0,
				"RESET": buf[5] != 0,
				"Q":     buf[6] != 0,
				"M":     buf[7] != 0,
			}
		}
	}
	return nil
}

// sanitizeFloat maps NaN/±Inf to nil (JSON null): json.Marshal rejects
// non-finite floats, and one bad REAL used to make the ENTIRE live-variable
// frame silently fail to marshal (stream freezes).
func sanitizeFloat(v float64, single bool) interface{} {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	if single {
		return float32(v)
	}
	return v
}

func encodeValue(t, value string) ([]byte, bool) {
	s := strings.TrimSpace(value)
	switch strings.ToUpper(t) {
	case "BOOL":
		switch strings.ToUpper(s) {
		case "TRUE", "1":
			return []byte{1}, true
		default:
			return []byte{0}, true
		}
	case "SINT":
		v, err := strconv.ParseInt(s, 10, 8)
		if err != nil {
			return nil, false
		}
		return []byte{byte(int8(v))}, true
	case "USINT", "BYTE":
		v, err := strconv.ParseUint(s, 10, 8)
		if err != nil {
			return nil, false
		}
		return []byte{byte(v)}, true
	case "INT":
		v, err := strconv.ParseInt(s, 10, 16)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 2)
		binary.LittleEndian.PutUint16(out, uint16(int16(v)))
		return out, true
	case "UINT", "WORD":
		v, err := strconv.ParseUint(s, 10, 16)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 2)
		binary.LittleEndian.PutUint16(out, uint16(v))
		return out, true
	case "DINT":
		v, err := strconv.ParseInt(s, 10, 32)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 4)
		binary.LittleEndian.PutUint32(out, uint32(int32(v)))
		return out, true
	case "UDINT", "TIME", "DWORD":
		v, err := strconv.ParseUint(s, 10, 32)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 4)
		binary.LittleEndian.PutUint32(out, uint32(v))
		return out, true
	case "LINT":
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 8)
		binary.LittleEndian.PutUint64(out, uint64(v))
		return out, true
	case "ULINT", "LWORD":
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 8)
		binary.LittleEndian.PutUint64(out, v)
		return out, true
	case "REAL":
		v, err := strconv.ParseFloat(s, 32)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 4)
		binary.LittleEndian.PutUint32(out, math.Float32bits(float32(v)))
		return out, true
	case "LREAL":
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 8)
		binary.LittleEndian.PutUint64(out, math.Float64bits(v))
		return out, true
	}
	return nil, false
}

// ── /proc/<pid>/mem write (Linux) ────────────────────────────────────────────

func writeProcMem(pid int, address uint64, data []byte) error {
	path := fmt.Sprintf("/proc/%d/mem", pid)
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	if _, err := f.WriteAt(data, int64(address)); err != nil {
		return fmt.Errorf("write at 0x%x: %w", address, err)
	}
	return nil
}
