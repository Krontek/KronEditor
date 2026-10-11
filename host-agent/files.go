package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// ── write_plc_files ──────────────────────────────────────────────────────────

type writePLCFilesReq struct {
	Header        string `json:"header"`
	Source        string `json:"source"`
	VariableTable string `json:"variableTable"`
	HAL           string `json:"hal"`
	HostGlue      string `json:"hostGlue"` // hot-swap: HAL trampolines compiled into the loader-host
}

func (s *Server) handleWritePLCFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req writePLCFilesReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	writes := []struct {
		name    string
		content string
		skip    bool
	}{
		{"plc.h", req.Header, false},
		{"plc.c", req.Source, false},
		{"variables.json", req.VariableTable, false},
		{"kron_hal.h", req.HAL, req.HAL == ""},
	}
	for _, f := range writes {
		if f.skip {
			continue
		}
		if err := os.WriteFile(filepath.Join(buildDir, f.name), []byte(f.content), 0o644); err != nil {
			writeError(w, http.StatusInternalServerError, "write "+f.name+": "+err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "buildDir": buildDir})
}

// ── get_standard_headers ─────────────────────────────────────────────────────

func (s *Server) handleGetStandardHeaders(w http.ResponseWriter, r *http.Request) {
	includeDir, err := s.paths.ResourceTargetIncludeDir("x86_64/linux")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	halImpl := map[string]bool{
		"kronhal_rpi.h":    true,
		"kronhal_bb.h":     true,
		"kronhal_jetson.h": true,
		"kronhal_sim.h":    true,
	}

	type header struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	var headers []header

	// Top-level kron*.h / gpiod.h
	if entries, err := os.ReadDir(includeDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			isKron := strings.HasPrefix(name, "kron") && strings.HasSuffix(name, ".h")
			allowed := (isKron || name == "gpiod.h") && !halImpl[name]
			if !allowed {
				continue
			}
			if content, err := os.ReadFile(filepath.Join(includeDir, name)); err == nil {
				headers = append(headers, header{Name: name, Content: string(content)})
			}
		}
	}

	// HAL/ subdirectory
	halDir := filepath.Join(includeDir, "HAL")
	if entries, err := os.ReadDir(halDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !strings.HasPrefix(name, "kron") || !strings.HasSuffix(name, ".h") {
				continue
			}
			if halImpl[name] {
				continue
			}
			if content, err := os.ReadFile(filepath.Join(halDir, name)); err == nil {
				headers = append(headers, header{Name: "HAL/" + name, Content: string(content)})
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "headers": headers})
}

// ── build dir info ───────────────────────────────────────────────────────────

func (s *Server) handleGetBuildDir(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "buildDir": s.paths.BuildDir()})
}

// ── generic file ops (used by frontend FS replacement) ──────────────────────
//
// These endpoints replace @tauri-apps/plugin-fs. Frontend passes absolute paths.
// The agent does NOT sandbox — assumes a trusted local environment, same as
// Tauri's default plugin-fs scope.

type pathReq struct {
	Path string `json:"path"`
}

type writeFileReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) handleHomeDir(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "home": home})
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req pathReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	data, err := os.ReadFile(req.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "content": string(data)})
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req writeFileReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(req.Path), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteFile removes ONE file, and only from inside the app-data dir.
//
// ⚠️ Deliberately narrower than read-file/write-file, which take any absolute
// path. Those are recoverable mistakes; an unbounded delete is not, and nothing
// in the editor needs one — the only caller is the ESI library, whose files
// live in <AppDataDir>/esi. Containment is checked on the RESOLVED path (after
// symlinks and ".." are collapsed) and demands a separator-aligned prefix, so
// "<appdata>x/evil" cannot pass as "<appdata>/…". Directories are refused.
func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req pathReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	root, err := filepath.EvalSymlinks(s.paths.AppDataDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "app data dir unavailable: "+err.Error())
		return
	}
	target, err := filepath.EvalSymlinks(req.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if !withinDir(root, target) { // ollama.go: separator-aligned prefix test
		writeError(w, http.StatusForbidden, "refusing to delete outside the app data directory")
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "refusing to delete a directory")
		return
	}
	if err := os.Remove(target); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type listDirEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

func (s *Server) handleListDir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req pathReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entries, err := os.ReadDir(req.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	out := make([]listDirEntry, 0, len(entries))
	for _, e := range entries {
		info, _ := e.Info()
		var size int64
		if info != nil {
			size = info.Size()
		}
		out = append(out, listDirEntry{Name: e.Name(), IsDir: e.IsDir(), Size: size})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "entries": out})
}
