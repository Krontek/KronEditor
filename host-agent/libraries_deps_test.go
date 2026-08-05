package main

// Tests for the third-party dependency builds and the server build.
//
// The SOEM and CANopen tests clone from GitHub and compile the full upstream
// source for every target, so they are gated behind -short and skip cleanly
// when the network is unavailable.

import (
	"debug/elf"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func requireNetwork(t *testing.T) {
	t.Helper()
	c, err := net.DialTimeout("tcp", "github.com:443", 5*time.Second)
	if err != nil {
		t.Skipf("github.com unreachable: %v", err)
	}
	_ = c.Close()
}

func TestWriteSoemOptionsHeader(t *testing.T) {
	dir := t.TempDir()
	if err := writeSoemOptionsHeader(dir); err != nil {
		t.Fatalf("writeSoemOptionsHeader: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "include", "soem", "ec_options.h"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	s := string(b)
	// ⚠️ EC_BUFSIZE must stay the lazily-resolved macro, not a literal — see
	// the comment on writeSoemOptionsHeader.
	if !strings.Contains(s, "#define EC_BUFSIZE             (EC_MAXECATFRAME)") {
		t.Error("EC_BUFSIZE must be (EC_MAXECATFRAME), resolved lazily from ec_type.h")
	}
	for _, want := range []string{"EC_MAXSLAVE", "EC_TIMEOUTRXM", "_ec_options_"} {
		if !strings.Contains(s, want) {
			t.Errorf("generated header missing %s", want)
		}
	}
}

func TestPatchSoemWin32Osal(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "osal.c")
	orig := "#include <osal.h>\nvoid f(void){\n   timespec_get(&ts, TIME_UTC);\n}\n"
	if err := os.WriteFile(p, []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := patchSoemWin32Osal(p); err != nil {
		t.Fatalf("patch: %v", err)
	}
	b, _ := os.ReadFile(p)
	s := string(b)
	if strings.Contains(s, "timespec_get(") {
		t.Error("timespec_get call survived the patch — mingw/MSVCRT does not provide it")
	}
	if !strings.Contains(s, "_ftime64_s") || !strings.Contains(s, "sys/timeb.h") {
		t.Error("replacement _ftime64_s implementation not written")
	}

	// Idempotent: a second pass must not double-prepend the include.
	if err := patchSoemWin32Osal(p); err != nil {
		t.Fatalf("second patch: %v", err)
	}
	b2, _ := os.ReadFile(p)
	if strings.Count(string(b2), "sys/timeb.h") != 1 {
		t.Error("patch is not idempotent")
	}

	// A missing file is reported, not panicked on.
	if err := patchSoemWin32Osal(filepath.Join(dir, "nope.c")); err == nil {
		t.Error("expected an error for a missing file")
	}
}

func TestRunBuildSoemEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("clones and compiles all of SOEM")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	requireNetwork(t)

	s, resources := newTestServer(t)
	if err := s.runBuildSoem(); err != nil {
		t.Fatalf("runBuildSoem: %v", err)
	}

	// Headers land in their own subtree of the shared include dir.
	inc := filepath.Join(resources, "krontek-include", "soem")
	for _, want := range []string{
		filepath.Join("include", "soem", "soem.h"),
		filepath.Join("include", "soem", "ec_options.h"),
		filepath.Join("osal", "osal.h"),
	} {
		if _, err := os.Stat(filepath.Join(inc, want)); err != nil {
			t.Errorf("SOEM header %s not installed: %v", want, err)
		}
	}

	// libsoem.a for every Linux/Windows target; macOS is deliberately absent.
	for _, triple := range []string{
		"x86_64-linux-gnu", "x86_64-w64-mingw32", "aarch64-linux-gnu", "arm-linux-gnueabihf",
	} {
		st, err := os.Stat(filepath.Join(resources, triple, "lib", "libsoem.a"))
		if err != nil {
			t.Errorf("%s: libsoem.a missing: %v", triple, err)
			continue
		}
		if st.Size() < 1024 {
			t.Errorf("%s: libsoem.a suspiciously small (%d bytes)", triple, st.Size())
		}
	}
}

func TestRunBuildCanopenEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("clones and compiles all of CANopenNode")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	requireNetwork(t)

	s, resources := newTestServer(t)
	if err := s.runBuildCanopen(); err != nil {
		t.Fatalf("runBuildCanopen: %v", err)
	}

	inc := filepath.Join(resources, "krontek-include", "canopen")
	if _, err := os.Stat(filepath.Join(inc, "CANopen.h")); err != nil {
		t.Errorf("CANopen.h not installed: %v", err)
	}
	// The reference driver binding must ship too — it defines the struct
	// layouts the archive was compiled against, so a consumer cannot use
	// libcanopen.a without it.
	if _, err := os.Stat(filepath.Join(inc, "example", "CO_driver_target.h")); err != nil {
		t.Errorf("example/CO_driver_target.h not installed: %v", err)
	}
	// The binding needs only freestanding C headers, so every target builds.
	for _, triple := range []string{
		"x86_64-linux-gnu", "x86_64-w64-mingw32", "aarch64-linux-gnu", "arm-linux-gnueabihf",
	} {
		st, err := os.Stat(filepath.Join(resources, triple, "lib", "libcanopen.a"))
		if err != nil {
			t.Errorf("%s: libcanopen.a missing: %v", triple, err)
			continue
		}
		if st.Size() < 1024 {
			t.Errorf("%s: libcanopen.a suspiciously small (%d bytes)", triple, st.Size())
		}
	}
}

func TestRunUpdateServerEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("cross-compiles the server for three architectures")
	}
	s, resources := newTestServer(t)

	if _, err := findServerSourceDir(); err != nil {
		t.Skipf("in-tree server/ not found: %v", err)
	}
	if err := s.runUpdateServer(); err != nil {
		t.Fatalf("runUpdateServer: %v", err)
	}

	// ⚠️ Binary names are the contract with deploy_ssh.go serverBinaryForBoard.
	//
	// ⚠️ The ELF MACHINE is checked, not just the size: an earlier version of
	// runWithTimeout reset cmd.Env and silently dropped GOOS/GOARCH, so all
	// three "cross-compiled" binaries came out as identical host-arch
	// executables. Size and the executable bit both looked perfectly fine —
	// only the architecture exposed it.
	for _, c := range []struct {
		triple, bin string
		machine     elf.Machine
	}{
		{"arm-linux-gnueabihf", "plc-agent_linux_armv7", elf.EM_ARM},
		{"aarch64-linux-gnu", "plc-agent_linux_arm64", elf.EM_AARCH64},
		{"x86_64-linux-gnu", "plc-agent_linux_amd64", elf.EM_X86_64},
	} {
		p := filepath.Join(resources, c.triple, "server", c.bin)
		st, err := os.Stat(p)
		if err != nil {
			t.Errorf("%s: %v", c.bin, err)
			continue
		}
		if st.Size() < 1024*1024 {
			t.Errorf("%s: suspiciously small (%d bytes)", c.bin, st.Size())
		}
		if st.Mode()&0o111 == 0 {
			t.Errorf("%s: not executable", c.bin)
		}

		f, err := elf.Open(p)
		if err != nil {
			t.Errorf("%s: not a valid ELF: %v", c.bin, err)
			continue
		}
		if f.Machine != c.machine {
			t.Errorf("%s: built for %v, want %v — GOARCH did not reach the compiler",
				c.bin, f.Machine, c.machine)
		}
		// CGO_ENABLED=0 must hold: the agent has to be fully static because
		// target boards carry no guaranteed shared libraries (server/build.sh).
		for _, prog := range f.Progs {
			if prog.Type == elf.PT_INTERP {
				t.Errorf("%s: dynamically linked — CGO_ENABLED=0 did not reach the compiler", c.bin)
				break
			}
		}
		_ = f.Close()
	}
}

// serverBinaryForBoard (deploy_ssh.go) picks a binary by board prefix; every
// (directory, name) pair it can return must be one runUpdateServer actually
// writes. Drift here silently deploys a wrong-architecture agent — and the two
// sides reach the same directories through DIFFERENT resource keys
// ("arm/armv7" vs "server/linux/armv7"), so comparing the keys would not catch
// it. Compare the resolved paths.
func TestServerBuildTargetsMatchDeployDestinations(t *testing.T) {
	paths, err := NewPaths(t.TempDir(), t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatalf("NewPaths: %v", err)
	}

	produced := map[string]bool{} // absolute path → written by runUpdateServer
	for _, bt := range serverBuildTargets() {
		dir, err := paths.ResourceTargetServerDir(bt.ResourceKey)
		if err != nil {
			t.Fatalf("build target %s: %v", bt.ResourceKey, err)
		}
		produced[filepath.Join(dir, bt.BinName)] = true
	}

	for _, board := range []string{"rpi_5", "bb_black", "bb_ai64", "jetson_nano", "opi_5", "radxa_rock5", "unknown_board"} {
		target, name, err := serverBinaryForBoard(board)
		if err != nil {
			t.Errorf("board %q: %v", board, err)
			continue
		}
		dir, err := paths.ResourceTargetServerDir(target)
		if err != nil {
			t.Errorf("board %q resolves to an unknown resource target %q: %v", board, target, err)
			continue
		}
		if !produced[filepath.Join(dir, name)] {
			t.Errorf("board %q deploys %s from %s, which the server build never writes", board, name, dir)
		}
	}
}
