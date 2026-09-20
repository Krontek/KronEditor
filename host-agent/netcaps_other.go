//go:build !linux

package main

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Capability handling is Linux-only; elsewhere the local sim never drives a
// real bus anyway (ecSimFlag always returns -DKRON_EC_SIM off Linux).
func hasNetRawCaps() bool                     { return false }
func netRawSysProcAttr() *syscall.SysProcAttr { return nil }
func netRawGrantHint() string                 { return "" }

// Windows/macOS: no polkit, and the local sim never drives a real bus there
// (ecSimFlag always stubs the master), so the runtime is spawned directly.
func runtimeLaunchCmd(bin string, args []string) (*exec.Cmd, string) {
	return exec.Command(bin, args...), ""
}

func stopRequestPath(buildDir string) string { return filepath.Join(buildDir, "stop_request") }

func privilegedKill(pid int) error { return fmt.Errorf("not supported on this OS") }

// ⚠️ Every symbol netcaps_linux.go exports needs a twin here or the
// GOOS=windows / GOOS=darwin builds break (CLAUDE.md §4). Both of these are
// reachable from platform-independent code: hasPrivilegedLauncher from
// announceEtherCATCaps and /api/host/health, grantNetRawCapsInteractive from
// the grant endpoint. false is the honest answer — there is no pkexec/sudo
// ladder and no file capabilities here — and the editor gates the setcap offer
// on health().platform === 'linux' anyway.
func hasPrivilegedLauncher() bool { return false }

func grantNetRawCapsInteractive() (bool, string) {
	return false, "capabilities are a Linux feature — nothing to grant on this OS"
}
