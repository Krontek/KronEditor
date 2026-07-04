package main

import (
	"archive/tar"
	"archive/zip"
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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
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
	mu        sync.Mutex
	serveCmd  *exec.Cmd
	serveDone chan struct{} // closed by the reaper goroutine (the ONLY cmd.Wait caller)
	inFlight  map[string]bool
	setting   bool // a setup run is in progress

	// GPU totals parsed from the managed daemon's own startup logs — a fallback
	// for when nvidia-smi is absent or broken (e.g. driver/NVML mismatch) yet
	// Ollama itself still detects the GPU.
	gpuName       string
	gpuVramTotal  int64
}

func NewOllamaState() *OllamaState {
	return &OllamaState{inFlight: map[string]bool{}}
}

// Stop kills the managed daemon (if we started one) on agent shutdown.
// exec.Cmd.Wait must only ever be called once, so Stop never calls Wait —
// the reaper in startOllamaServe owns Wait and closes serveDone.
func (o *OllamaState) Stop() {
	o.mu.Lock()
	cmd, done := o.serveCmd, o.serveDone
	o.serveCmd, o.serveDone = nil, nil
	o.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		if done != nil {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}
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

// ollamaExeName is the executable's filename for the current OS.
func ollamaExeName() string {
	if runtime.GOOS == "windows" {
		return "ollama.exe"
	}
	return "ollama"
}

// findExtractedOllama locates the ollama executable inside a user-local install
// dir. Archive layouts differ per OS (linux tgz → bin/ollama; windows zip →
// ollama.exe at root), so we check the common spots first, then walk as a
// fallback so a layout change in a future Ollama release won't break detection.
func findExtractedOllama(dest string) string {
	name := ollamaExeName()
	for _, rel := range []string{name, filepath.Join("bin", name)} {
		p := filepath.Join(dest, rel)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	var found string
	_ = filepath.Walk(dest, func(p string, info os.FileInfo, err error) error {
		if err != nil || found != "" || info == nil || info.IsDir() {
			return nil
		}
		if info.Name() == name {
			found = p
		}
		return nil
	})
	return found
}

// localOllamaBinary returns the path to our user-local ollama install, if present.
func (s *Server) localOllamaBinary() string {
	return findExtractedOllama(filepath.Join(s.paths.AppDataDir, "ollama"))
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

// downloadOllama fetches the official user-local archive for the current OS and
// extracts it into {AppDataDir}/ollama. No sudo: we run the binary in place.
// Returns the bin path. Linux ships a `.tgz` (bin/ollama + lib/), Windows ships
// a `.zip` (ollama.exe + lib/) — both extract whole so the runners sit next to
// the executable.
func (s *Server) downloadOllama(onProgress func(done, total int64)) (string, error) {
	arch := runtime.GOARCH // "amd64" | "arm64" — matches Ollama's release naming
	dest := filepath.Join(s.paths.AppDataDir, "ollama")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return "", err
	}

	// Ollama's release assets: Windows ships a `.zip`, Linux a zstd-compressed
	// `.tar.zst` (it used to be gzip `.tgz` — the name changed, so we follow the
	// current scheme). ollama.com/download/<asset> redirects to the matching
	// GitHub release asset.
	var url, archiveName string
	if runtime.GOOS == "windows" {
		url = "https://ollama.com/download/ollama-windows-" + arch + ".zip"
		archiveName = "ollama-download.zip"
	} else {
		url = "https://ollama.com/download/ollama-linux-" + arch + ".tar.zst"
		archiveName = "ollama-download.tar.zst"
	}

	// Stream the archive to a temp file (progress reflects the download). zip
	// needs random access, and a temp file keeps both formats on one code path.
	client := &http.Client{Timeout: 0} // large file; no overall timeout
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &httpStatusErr{code: resp.StatusCode, url: url}
	}

	archivePath := filepath.Join(dest, archiveName)
	out, err := os.Create(archivePath)
	if err != nil {
		return "", err
	}
	pr := &progressReader{r: resp.Body, total: resp.ContentLength, cb: onProgress}
	if _, err := io.Copy(out, pr); err != nil {
		out.Close()
		return "", err
	}
	out.Close()
	defer os.Remove(archivePath)

	if runtime.GOOS == "windows" {
		err = extractZip(archivePath, dest)
	} else {
		err = extractTarZst(archivePath, dest)
	}
	if err != nil {
		return "", err
	}

	bin := findExtractedOllama(dest)
	if bin == "" {
		return "", &missingBinErr{path: filepath.Join(dest, ollamaExeName())}
	}
	_ = os.Chmod(bin, 0o755)
	return bin, nil
}

// withinDir reports whether target stays inside dir (path-traversal guard).
func withinDir(dir, target string) bool {
	return strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator))
}

// extractTarZst decompresses a zstd `.tar.zst` archive (current Linux release).
func extractTarZst(archivePath, dest string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := zstd.NewReader(f)
	if err != nil {
		return err
	}
	defer zr.Close()
	return extractTarStream(zr, dest)
}

// extractTarGz decompresses a gzip `.tgz` archive (kept for older release URLs).
func extractTarGz(archivePath, dest string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	return extractTarStream(gz, dest)
}

// extractTarStream walks a decompressed tar stream into dest (path-traversal safe).
func extractTarStream(r io.Reader, dest string) error {
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dest, hdr.Name)
		if !withinDir(dest, target) {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		case tar.TypeSymlink:
			// Symlink-slip guard: reject absolute targets and relative targets
			// that resolve outside dest — a hostile archive must not be able to
			// plant a link that later writes/reads outside the install dir.
			link := hdr.Linkname
			if filepath.IsAbs(link) {
				continue
			}
			if resolved := filepath.Join(filepath.Dir(target), link); !withinDir(dest, resolved) {
				continue
			}
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.Remove(target)
			_ = os.Symlink(link, target)
		}
	}
	return nil
}

func extractZip(archivePath, dest string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()

	for _, zf := range zr.File {
		target := filepath.Join(dest, zf.Name)
		if !withinDir(dest, target) {
			continue
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, zf.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		if _, err := io.Copy(f, rc); err != nil {
			f.Close()
			rc.Close()
			return err
		}
		f.Close()
		rc.Close()
	}
	return nil
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
	// Ollama may log GPU detection to either stream; tap both (tee + scrape).
	cmd.Stdout = &gpuLogTap{o: s.ollama, dst: os.Stdout}
	cmd.Stderr = &gpuLogTap{o: s.ollama, dst: os.Stderr}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	s.ollama.serveCmd = cmd
	s.ollama.serveDone = done
	// Reaper: the ONLY cmd.Wait caller (Stop() waits on `done`).
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
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

// ── runtime stats (CPU/GPU placement + VRAM) ─────────────────────────────────
//
// Answers "is this model running on CPU or GPU, and how much VRAM is in use".
// Model placement comes from Ollama's `GET /api/ps` (size_vram vs size). Total
// GPU VRAM has no Ollama HTTP surface, so we read it best-effort from
// `nvidia-smi` — present on NVIDIA hosts (incl. Jetson), absent elsewhere, in
// which case the caller just gets the CPU/GPU badge without a used/total bar.

type ollamaRuntimeReq struct {
	Model   string `json:"model"`
	BaseURL string `json:"baseUrl"`
	Load    bool   `json:"load"` // preload the model so /api/ps can report it
}

type psModel struct {
	Name     string `json:"name"`
	Model    string `json:"model"`
	Size     int64  `json:"size"`
	SizeVRAM int64  `json:"size_vram"`
}

type ollamaPSResp struct {
	Models []psModel `json:"models"`
}

type gpuInfo struct {
	Name      string `json:"name"`
	VramTotal int64  `json:"vramTotal"`
}

func (s *Server) handleOllamaRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req ollamaRuntimeReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	base := normalizeOllamaBase(req.BaseURL)
	model := strings.TrimSpace(req.Model)

	// Preload into memory so placement is observable (idempotent if resident).
	if req.Load && model != "" {
		loadOllamaModel(base, model)
	}

	resp := map[string]any{"ok": true, "loaded": false}
	if model != "" {
		if m, found := ollamaModelPS(base, model); found {
			proc, pct := classifyProcessor(m.Size, m.SizeVRAM)
			resp["loaded"] = true
			resp["modelSize"] = m.Size
			resp["modelVram"] = m.SizeVRAM
			resp["processor"] = proc
			resp["gpuPercent"] = pct
		}
	}
	if g := s.detectGPU(); g != nil {
		resp["gpu"] = g
	}
	writeJSON(w, http.StatusOK, resp)
}

// detectGPU reports the GPU name + total VRAM, preferring nvidia-smi and falling
// back to what the managed daemon logged at startup.
func (s *Server) detectGPU() *gpuInfo {
	if g := queryNvidiaGPU(); g != nil {
		return g
	}
	s.ollama.mu.Lock()
	name, total := s.ollama.gpuName, s.ollama.gpuVramTotal
	s.ollama.mu.Unlock()
	if total > 0 {
		return &gpuInfo{Name: name, VramTotal: total}
	}
	return nil
}

// loadOllamaModel asks Ollama to resident the model (empty-prompt generate is
// the documented preload). Best-effort: errors/timeouts are swallowed, the
// caller still reads whatever /api/ps reports.
func loadOllamaModel(base, model string) {
	body, _ := json.Marshal(map[string]any{"model": model, "keep_alive": "5m"})
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/generate", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
}

// unloadOllamaModel evicts a model from memory now (keep_alive:0), freeing VRAM.
// Without this Ollama keeps it resident until the keep_alive timeout (~5m).
func unloadOllamaModel(base, model string) error {
	body, _ := json.Marshal(map[string]any{"model": model, "keep_alive": 0})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	httpReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/generate", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

type ollamaUnloadReq struct {
	Model   string `json:"model"`
	BaseURL string `json:"baseUrl"`
}

func (s *Server) handleOllamaUnload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req ollamaUnloadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	if err := unloadOllamaModel(normalizeOllamaBase(req.BaseURL), model); err != nil {
		writeError(w, http.StatusBadGateway, "unload failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "unloaded": model})
}

func ollamaModelPS(base, model string) (psModel, bool) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(base + "/api/ps")
	if err != nil {
		return psModel{}, false
	}
	defer resp.Body.Close()
	var ps ollamaPSResp
	if json.NewDecoder(resp.Body).Decode(&ps) != nil {
		return psModel{}, false
	}
	for _, m := range ps.Models {
		if m.Name == model || m.Model == model {
			return m, true
		}
	}
	if len(ps.Models) == 1 { // only one resident → it's ours
		return ps.Models[0], true
	}
	return psModel{}, false
}

// classifyProcessor maps the VRAM-resident fraction to a label + GPU percent.
func classifyProcessor(size, vram int64) (string, int) {
	if vram <= 0 {
		return "CPU", 0
	}
	if size <= 0 || vram >= size {
		return "GPU", 100
	}
	return "GPU/CPU", int(vram * 100 / size)
}

// queryNvidiaGPU reads the first GPU's name + total VRAM via nvidia-smi.
// Returns nil when nvidia-smi is absent or broken (non-NVIDIA / CPU-only hosts,
// or a driver/NVML version mismatch) — the daemon-log fallback covers that.
func queryNvidiaGPU() *gpuInfo {
	out, err := exec.Command("nvidia-smi",
		"--query-gpu=name,memory.total", "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}
	line := strings.TrimSpace(string(out))
	if line == "" {
		return nil
	}
	line = strings.SplitN(line, "\n", 2)[0] // first GPU
	parts := strings.Split(line, ",")
	if len(parts) < 2 {
		return nil
	}
	totalMiB, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	if totalMiB <= 0 {
		return nil
	}
	return &gpuInfo{Name: strings.TrimSpace(parts[0]), VramTotal: totalMiB * 1024 * 1024}
}

// gpuLogTap tees the daemon's stderr through while scraping its GPU-detection
// line ("inference compute ... description=\"...\" ... total=\"6.0 GiB\"") so we
// know the card's total VRAM even when nvidia-smi can't be invoked.
type gpuLogTap struct {
	o   *OllamaState
	dst io.Writer
	buf []byte
}

func (w *gpuLogTap) Write(p []byte) (int, error) {
	n, err := w.dst.Write(p)
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		w.o.parseGPULogLine(string(w.buf[:i]))
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) > 64*1024 { // bound a pathological no-newline stream
		w.buf = w.buf[len(w.buf)-64*1024:]
	}
	return n, err
}

func (o *OllamaState) parseGPULogLine(line string) {
	if !strings.Contains(line, "inference compute") {
		return
	}
	total := parseSizeString(extractQuoted(line, "total="))
	if total <= 0 {
		return
	}
	name := extractQuoted(line, "description=")
	o.mu.Lock()
	o.gpuVramTotal = total
	if name != "" {
		o.gpuName = name
	}
	o.mu.Unlock()
}

// extractQuoted pulls the value of a `key="value"` token out of a log line.
func extractQuoted(s, key string) string {
	i := strings.Index(s, key+"\"")
	if i < 0 {
		return ""
	}
	rest := s[i+len(key)+1:]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		return ""
	}
	return rest[:j]
}

// parseSizeString turns "6.0 GiB" / "16384 MiB" / "6.4 GB" into bytes.
func parseSizeString(s string) int64 {
	parts := strings.Fields(strings.TrimSpace(s))
	if len(parts) == 0 {
		return 0
	}
	val, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || val <= 0 {
		return 0
	}
	unit := ""
	if len(parts) > 1 {
		unit = strings.ToLower(parts[1])
	}
	switch {
	case strings.HasPrefix(unit, "gi"):
		return int64(val * (1 << 30))
	case strings.HasPrefix(unit, "g"):
		return int64(val * 1e9)
	case strings.HasPrefix(unit, "mi"):
		return int64(val * (1 << 20))
	case strings.HasPrefix(unit, "m"):
		return int64(val * 1e6)
	default:
		return int64(val)
	}
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
