package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ollama.go — local-model install, download & setup for the AI Agent panel.
//
// Everything here is designed so the user can go from "nothing installed" to a
// connected local model entirely from the UI, with no terminal and no sudo:
//
//   POST /api/host/ollama-status {baseUrl?}
//        → { ok, running, installed, models:[{name,size}] }
//        running   = daemon reachable at baseUrl
//        installed = an ollama binary exists (user-local or on PATH)
//
//   POST /api/host/ollama-setup {baseUrl?}   (one-click bootstrap)
//        → { ok, started:true }   (returns immediately)
//        Background: if the daemon is already up → done. Otherwise locate an
//        ollama binary; if none, download the official user-local tarball into
//        {AppDataDir}/ollama (no sudo); then spawn `ollama serve` as a managed
//        process and poll until the daemon answers. Progress on event topic
//        "ollama-setup-progress" = { phase, percent, done, error }.
//
//   POST /api/host/ollama-pull {model, baseUrl?}
//        → { ok, started:true }   (returns immediately)
//        Streams `POST {base}/api/pull` progress on topic
//        "ollama-pull-progress" = { model, status, completed, total, percent, done, error }.
//
// No `ollama` CLI is required for pull/status — we use the daemon's HTTP API.
// The CLI binary is only needed to RUN the daemon (`ollama serve`), which is
// exactly what setup downloads when it's missing.

const defaultOllamaBase = "http://localhost:11434"

const (
	ollamaPullProgressTopic  = "ollama-pull-progress"
	ollamaSetupProgressTopic = "ollama-setup-progress"
)

// OllamaState owns the managed `ollama serve` process and tracks in-flight pulls.
type OllamaState struct {
	mu       sync.Mutex
	serveCmd *exec.Cmd
	inFlight map[string]bool
	setting  bool // a setup run is in progress
}

func NewOllamaState() *OllamaState {
	return &OllamaState{inFlight: map[string]bool{}}
}

// Stop kills the managed daemon (if we started one) on agent shutdown.
func (o *OllamaState) Stop() {
	o.mu.Lock()
	cmd := o.serveCmd
	o.serveCmd = nil
	o.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
}

func normalizeOllamaBase(raw string) string {
	b := strings.TrimSpace(raw)
	if b == "" {
		return defaultOllamaBase
	}
	b = strings.TrimRight(b, "/")
	if !strings.HasPrefix(b, "http://") && !strings.HasPrefix(b, "https://") {
		b = "http://" + b
	}
	return b
}

func ollamaReachable(base string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(base + "/api/tags")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// localBinaryPath returns the path to our user-local ollama install, if present.
func (s *Server) localOllamaBinary() string {
	p := filepath.Join(s.paths.AppDataDir, "ollama", "bin", "ollama")
	if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
		return p
	}
	return ""
}

// ollamaBinary resolves an ollama binary: user-local install first, then PATH.
func (s *Server) ollamaBinary() string {
	if p := s.localOllamaBinary(); p != "" {
		return p
	}
	if p, err := exec.LookPath("ollama"); err == nil {
		return p
	}
	return ""
}

// ── status ───────────────────────────────────────────────────────────────────

type ollamaStatusReq struct {
	BaseURL string `json:"baseUrl"`
}

type ollamaTagsResp struct {
	Models []struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	} `json:"models"`
}

func (s *Server) handleOllamaStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req ollamaStatusReq
	_ = json.NewDecoder(r.Body).Decode(&req) // body optional
	base := normalizeOllamaBase(req.BaseURL)
	installed := s.ollamaBinary() != ""

	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get(base + "/api/tags")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "running": false, "installed": installed, "baseUrl": base,
			"models": []any{}, "error": err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	var tags ollamaTagsResp
	if err := json.NewDecoder(resp.Body).Decode(&tags); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "running": true, "installed": installed, "baseUrl": base,
			"models": []any{}, "error": "tags parse: " + err.Error(),
		})
		return
	}
	models := make([]map[string]any, 0, len(tags.Models))
	for _, m := range tags.Models {
		models = append(models, map[string]any{"name": m.Name, "size": m.Size})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "running": true, "installed": installed, "baseUrl": base, "models": models,
	})
}

// ── setup (install + start) ────────────────────────────────────────────────

type ollamaSetupReq struct {
	BaseURL string `json:"baseUrl"`
}

func (s *Server) emitSetup(phase string, percent int, done bool, errMsg string) {
	s.events.Emit(ollamaSetupProgressTopic, map[string]any{
		"phase": phase, "percent": percent, "done": done, "error": errMsg,
	})
}

func (s *Server) handleOllamaSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req ollamaSetupReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	base := normalizeOllamaBase(req.BaseURL)

	s.ollama.mu.Lock()
	if s.ollama.setting {
		s.ollama.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": false, "alreadyRunning": true})
		return
	}
	s.ollama.setting = true
	s.ollama.mu.Unlock()

	go func() {
		defer func() {
			s.ollama.mu.Lock()
			s.ollama.setting = false
			s.ollama.mu.Unlock()
		}()
		s.runOllamaSetup(base)
	}()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true})
}

func (s *Server) runOllamaSetup(base string) {
	s.emitSetup("checking", 0, false, "")
	if ollamaReachable(base) {
		s.emitSetup("ready", 100, true, "")
		return
	}

	bin := s.ollamaBinary()
	if bin == "" {
		s.emitSetup("downloading", 0, false, "")
		var err error
		bin, err = s.downloadOllama(func(done, total int64) {
			pct := 0
			if total > 0 {
				pct = int(done * 100 / total)
			}
			s.emitSetup("downloading", pct, false, "")
		})
		if err != nil {
			s.emitSetup("failed", 0, true, "download: "+err.Error())
			return
		}
	}

	s.emitSetup("starting", 0, false, "")
	if err := s.startOllamaServe(bin, base); err != nil {
		s.emitSetup("failed", 0, true, "start: "+err.Error())
		return
	}

	// Poll until the daemon answers (up to ~20s).
	for i := 0; i < 40; i++ {
		if ollamaReachable(base) {
			s.emitSetup("ready", 100, true, "")
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	s.emitSetup("failed", 0, true, "daemon did not become ready")
}

// downloadOllama fetches the official user-local tarball and extracts it into
// {AppDataDir}/ollama. No sudo: we run the binary in place. Returns the bin path.
func (s *Server) downloadOllama(onProgress func(done, total int64)) (string, error) {
	arch := runtime.GOARCH // "amd64" | "arm64" — matches Ollama's release naming
	url := "https://ollama.com/download/ollama-linux-" + arch + ".tgz"
	dest := filepath.Join(s.paths.AppDataDir, "ollama")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return "", err
	}

	client := &http.Client{Timeout: 0} // large file; no overall timeout
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &httpStatusErr{code: resp.StatusCode, url: url}
	}

	pr := &progressReader{r: resp.Body, total: resp.ContentLength, cb: onProgress}
	gz, err := gzip.NewReader(pr)
	if err != nil {
		return "", err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		// Guard against path traversal.
		target := filepath.Join(dest, hdr.Name)
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode))
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return "", err
			}
			f.Close()
		case tar.TypeSymlink:
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.Remove(target)
			_ = os.Symlink(hdr.Linkname, target)
		}
	}

	bin := filepath.Join(dest, "bin", "ollama")
	if _, err := os.Stat(bin); err != nil {
		return "", &missingBinErr{path: bin}
	}
	_ = os.Chmod(bin, 0o755)
	return bin, nil
}

// startOllamaServe spawns `ollama serve` bound to base, tracked for shutdown.
func (s *Server) startOllamaServe(bin, base string) error {
	s.ollama.mu.Lock()
	defer s.ollama.mu.Unlock()
	if s.ollama.serveCmd != nil && s.ollama.serveCmd.Process != nil {
		return nil // already managing a daemon
	}
	hostHdr := strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://")
	cmd := exec.Command(bin, "serve")
	cmd.Env = append(os.Environ(), "OLLAMA_HOST="+hostHdr)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	s.ollama.serveCmd = cmd
	go func() { _ = cmd.Wait() }() // reap when it exits
	return nil
}

// ── pull ───────────────────────────────────────────────────────────────────

type ollamaPullReq struct {
	Model   string `json:"model"`
	BaseURL string `json:"baseUrl"`
}

type ollamaPullLine struct {
	Status    string `json:"status"`
	Digest    string `json:"digest"`
	Total     int64  `json:"total"`
	Completed int64  `json:"completed"`
	Error     string `json:"error"`
}

func (s *Server) handleOllamaPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req ollamaPullReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	base := normalizeOllamaBase(req.BaseURL)

	s.ollama.mu.Lock()
	if s.ollama.inFlight[model] {
		s.ollama.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": false, "alreadyRunning": true})
		return
	}
	s.ollama.inFlight[model] = true
	s.ollama.mu.Unlock()

	go s.runOllamaPull(base, model)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true})
}

func (s *Server) emitPull(model, status string, completed, total int64, done bool, errMsg string) {
	percent := 0
	if total > 0 {
		percent = int(completed * 100 / total)
	} else if done && errMsg == "" {
		percent = 100
	}
	s.events.Emit(ollamaPullProgressTopic, map[string]any{
		"model": model, "status": status, "completed": completed,
		"total": total, "percent": percent, "done": done, "error": errMsg,
	})
}

func (s *Server) runOllamaPull(base, model string) {
	defer func() {
		s.ollama.mu.Lock()
		delete(s.ollama.inFlight, model)
		s.ollama.mu.Unlock()
	}()

	s.emitPull(model, "starting", 0, 0, false, "")

	body, _ := json.Marshal(map[string]any{"model": model, "stream": true})
	client := &http.Client{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/pull", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(httpReq)
	if err != nil {
		s.emitPull(model, "failed", 0, 0, true, "connect: "+err.Error())
		return
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var lastStatus string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var pl ollamaPullLine
		if err := json.Unmarshal([]byte(line), &pl); err != nil {
			continue
		}
		if pl.Error != "" {
			s.emitPull(model, "failed", 0, 0, true, pl.Error)
			return
		}
		lastStatus = pl.Status
		if pl.Status == "success" {
			s.emitPull(model, "success", pl.Total, pl.Total, true, "")
			return
		}
		s.emitPull(model, pl.Status, pl.Completed, pl.Total, false, "")
	}
	if err := scanner.Err(); err != nil {
		s.emitPull(model, "failed", 0, 0, true, "stream: "+err.Error())
		return
	}
	s.emitPull(model, lastStatus, 0, 0, true, "")
}

// ── helpers ──────────────────────────────────────────────────────────────────

// progressReader wraps an io.Reader and reports cumulative bytes read.
type progressReader struct {
	r     io.Reader
	total int64
	read  int64
	cb    func(done, total int64)
	last  time.Time
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.read += int64(n)
	// Throttle callbacks to ~5/s to avoid flooding the event bus.
	now := time.Now()
	if p.cb != nil && (now.Sub(p.last) > 200*time.Millisecond || err != nil) {
		p.last = now
		p.cb(p.read, p.total)
	}
	return n, err
}

type httpStatusErr struct {
	code int
	url  string
}

func (e *httpStatusErr) Error() string {
	return "HTTP " + strings.TrimSpace(http.StatusText(e.code)) + " fetching " + e.url
}

type missingBinErr struct{ path string }

func (e *missingBinErr) Error() string { return "ollama binary not found after extract: " + e.path }
