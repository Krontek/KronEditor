package main

// runUpdateServer — the "Build Server" action.
//
// ⚠️ Despite sitting next to the repo checkboxes in the UI, this does NOT clone
// anything: KronServer is not a separate repository, it is the in-tree
// server/ module. So this is the Go equivalent of running server/build.sh —
// cross-compile the agent for the three PLC architectures and drop the
// binaries where "Deploy Server to Target" reads them from
// (resources/<triple>/server/, per deploy_ssh.go serverBinaryForBoard).
//
// It is a DEV-mode action: a packaged artifact ships no server/ source, and
// says so rather than failing obscurely.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// serverBuildTarget is one cross-compiled server binary.
//
// ⚠️ The binary NAMES are a contract with deploy_ssh.go serverBinaryForBoard,
// which picks one by board-id prefix. Renaming here silently makes every
// deploy fall back to the wrong architecture.
type serverBuildTarget struct {
	GOARCH      string
	GOARM       string // only meaningful for GOARCH=arm
	BinName     string
	ResourceKey string
	Label       string
}

func serverBuildTargets() []serverBuildTarget {
	return []serverBuildTarget{
		{GOARCH: "arm", GOARM: "7", BinName: "plc-agent_linux_armv7", ResourceKey: "server/linux/armv7", Label: "Linux ARM32 (ARMv7)"},
		{GOARCH: "arm64", BinName: "plc-agent_linux_arm64", ResourceKey: "server/linux/arm64", Label: "Linux ARM64 (AArch64)"},
		{GOARCH: "amd64", BinName: "plc-agent_linux_amd64", ResourceKey: "server/linux/amd64", Label: "Linux x86_64"},
	}
}

func (s *Server) serverLog(format string, a ...any) {
	s.events.Emit(topicServerProgress, fmt.Sprintf(format, a...))
}

func (s *Server) runUpdateServer() error {
	s.serverLog("=== Build KronServer ===")

	srcDir, err := findServerSourceDir()
	if err != nil {
		return err
	}
	s.serverLog("Source: %s", srcDir)

	goBin, err := exec.LookPath("go")
	if err != nil {
		return fmt.Errorf("Go toolchain not found on PATH — install Go from https://go.dev to build the server")
	}
	if out, err := runWithTimeout(exec.Command(goBin, "version"), 30*time.Second); err != nil {
		return fmt.Errorf("go version failed: %v: %s", err, strings.TrimSpace(out))
	} else {
		s.serverLog("Toolchain: %s", strings.TrimSpace(out))
	}

	version := serverVersionString(srcDir)
	s.serverLog("Version: %s", version)

	// Build into a temp dir first, then install — same rule as the library
	// builds: a failed cross-compile must not leave resources/ holding a mix
	// of old and new server binaries for different architectures.
	stage, err := os.MkdirTemp("", "kroneditor_server_")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)

	targets := serverBuildTargets()
	for i, t := range targets {
		s.serverLog("[%d/%d] %s...", i+1, len(targets), t.Label)
		out := filepath.Join(stage, t.BinName)

		cmd := exec.Command(goBin, "build", "-trimpath",
			"-ldflags", "-s -w -X main.Version="+version,
			"-o", out, ".")
		cmd.Dir = srcDir
		// CGO_ENABLED=0 is what makes the agent a fully static binary with no
		// .so dependency on the target board (see server/build.sh).
		env := append(os.Environ(),
			"CGO_ENABLED=0",
			"GOOS=linux",
			"GOARCH="+t.GOARCH,
		)
		if t.GOARM != "" {
			env = append(env, "GOARM="+t.GOARM)
		}
		cmd.Env = env

		if outStr, err := runWithTimeout(cmd, 10*time.Minute); err != nil {
			msg := strings.TrimSpace(outStr)
			s.serverLog("      ✗ %s", msg)
			return fmt.Errorf("[%s] build failed: %v: %s", t.Label, err, msg)
		}
		if st, err := os.Stat(out); err != nil {
			return fmt.Errorf("[%s] build produced no binary", t.Label)
		} else {
			s.serverLog("      ✓ %s (%.1f MB)", t.BinName, float64(st.Size())/(1024*1024))
		}
	}

	// ── install ─────────────────────────────────────────────────────────────
	s.serverLog("Installing into resources/...")
	for _, t := range targets {
		dstDir, err := s.paths.ResourceTargetServerDir(t.ResourceKey)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(dstDir, 0o755); err != nil {
			return err
		}
		src := filepath.Join(stage, t.BinName)
		dst := filepath.Join(dstDir, t.BinName)
		b, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		// tmp+rename so a concurrent deploy never reads a half-written binary.
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, b, 0o755); err != nil {
			return err
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		s.serverLog("  %s → %s", t.BinName, dstDir)
	}

	// Mirror into server/dist/ too, so the tree looks exactly like a
	// server/build.sh run and the two paths cannot drift.
	distDir := filepath.Join(srcDir, "dist")
	if err := os.MkdirAll(distDir, 0o755); err == nil {
		for _, t := range targets {
			if b, err := os.ReadFile(filepath.Join(stage, t.BinName)); err == nil {
				_ = os.WriteFile(filepath.Join(distDir, t.BinName), b, 0o755)
			}
		}
		s.serverLog("  mirrored into %s", distDir)
	}

	s.serverLog("=== Build KronServer complete ===")
	s.serverLog("Deploy Server to Target will now ship these binaries.")
	return nil
}

// findServerSourceDir locates the in-tree server/ module.
//
// Mirrors paths.guessSiblingDir's search order (cwd, cwd/.., exe dir, exe
// dir/..) because the agent runs from host-agent/ under `go run .` in dev and
// from its install dir in production.
func findServerSourceDir() (string, error) {
	try := func(base string) string {
		c := filepath.Join(base, "server")
		if _, err := os.Stat(filepath.Join(c, "go.mod")); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
		return ""
	}
	var bases []string
	if cwd, err := os.Getwd(); err == nil {
		bases = append(bases, cwd, filepath.Join(cwd, ".."), filepath.Join(cwd, "..", ".."))
	}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		bases = append(bases, d, filepath.Join(d, ".."), filepath.Join(d, "..", ".."))
	}
	for _, b := range bases {
		if hit := try(b); hit != "" {
			return hit, nil
		}
	}
	return "", fmt.Errorf(
		"server source not found: Build Server is a development action and needs the in-tree server/ module " +
			"(a packaged KronEditor ships only the prebuilt binaries under resources/<triple>/server/)")
}

// serverVersionString mirrors server/build.sh's `git describe --tags --always
// --dirty`, falling back to "dev" outside a git checkout.
func serverVersionString(srcDir string) string {
	cmd := exec.Command("git", "describe", "--tags", "--always", "--dirty")
	cmd.Dir = srcDir
	out, err := runWithTimeout(cmd, 15*time.Second)
	v := strings.TrimSpace(out)
	if err != nil || v == "" {
		return "dev"
	}
	return v
}
