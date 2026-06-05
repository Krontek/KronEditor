package main

import (
	"debug/dwarf"
	"debug/elf"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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
}

func NewSimState() *SimState {
	return &SimState{}
}

func (s *SimState) Stop() {
	s.mu.Lock()
	cmd := s.cmd
	ch := s.stopCh
	s.cmd = nil
	s.pid = 0
	s.varSpecs = nil
	s.stopCh = nil
	s.mu.Unlock()

	if ch != nil {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
}

// ── run_simulation ───────────────────────────────────────────────────────────

func (s *Server) handleRunSimulation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
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
	s.sim.stopCh = stopCh
	pid := s.sim.pid
	s.sim.mu.Unlock()

	s.events.Emit("simulation-output", map[string]any{"status": "started"})

	go s.simulationPoller(pid, specs, stopCh)
	go func() {
		_ = cmd.Wait()
		s.sim.mu.Lock()
		if s.sim.cmd == cmd {
			s.sim.cmd = nil
			s.sim.pid = 0
			s.sim.varSpecs = nil
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
	s.sim.mu.Lock()
	cmd := s.sim.cmd
	ch := s.sim.stopCh
	s.sim.cmd = nil
	s.sim.pid = 0
	s.sim.varSpecs = nil
	s.sim.stopCh = nil
	s.sim.mu.Unlock()
	if cmd == nil {
		writeError(w, http.StatusBadRequest, "No simulation running")
		return
	}
	if ch != nil {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Simulation stopped"})
}

// ── write_variable ───────────────────────────────────────────────────────────

type writeVariableReq struct {
	Name  string `json:"name"`
	Value string `json:"value"`
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
		writeError(w, http.StatusBadRequest, "No simulation running")
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
			payload, _ := json.Marshal(vars)
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
	}
}

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
	memPath := fmt.Sprintf("/proc/%d/mem", pid)
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(memPath); err != nil {
		s.events.Emit("simulation-output", map[string]any{"error": "Failed to open process memory"})
		return
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		if _, err := os.Stat(memPath); err != nil {
			return
		}
		f, err := os.Open(memPath)
		if err != nil {
			return
		}
		vars := make(map[string]interface{})
		anyOK := false
		for _, sp := range specs {
			size := typeSize(sp.VType)
			if size == 0 {
				continue
			}
			buf := make([]byte, size)
			if _, err := f.ReadAt(buf, int64(sp.Address)); err == nil {
				vars[sp.Key] = decodeValue(buf, sp.VType)
				anyOK = true
			}
		}
		f.Close()
		if anyOK {
			s.events.Emit("simulation-output", map[string]any{"vars": vars})
			broadcastPlcVars(vars)
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

func typeSize(t string) int {
	switch strings.ToUpper(t) {
	case "BOOL", "SINT", "USINT":
		return 1
	case "INT", "UINT":
		return 2
	case "DINT", "UDINT", "TIME", "REAL":
		return 4
	case "LINT", "ULINT", "LREAL":
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
	case "USINT":
		return buf[0]
	case "INT":
		return int16(binary.LittleEndian.Uint16(buf[:2]))
	case "UINT":
		return binary.LittleEndian.Uint16(buf[:2])
	case "DINT":
		return int32(binary.LittleEndian.Uint32(buf[:4]))
	case "UDINT", "TIME":
		return binary.LittleEndian.Uint32(buf[:4])
	case "LINT":
		return int64(binary.LittleEndian.Uint64(buf[:8]))
	case "ULINT":
		return binary.LittleEndian.Uint64(buf[:8])
	case "REAL":
		return math.Float32frombits(binary.LittleEndian.Uint32(buf[:4]))
	case "LREAL":
		return math.Float64frombits(binary.LittleEndian.Uint64(buf[:8]))
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
	case "USINT":
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
	case "UINT":
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
	case "UDINT", "TIME":
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
	case "ULINT":
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
