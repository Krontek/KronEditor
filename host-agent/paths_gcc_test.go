package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The bundled sysroots name their GCC install dir with a "none" vendor
// (arm-none-linux-gnueabihf) while we compile with --target=arm-linux-gnueabihf.
// Building the path from the compile triple therefore finds nothing and -static
// fails on crtbeginT.o / -lgcc, which is exactly how armv7 Build & Send broke.
// This asserts the lookup is glob-based and vendor-agnostic.
func TestLLVMGCCInstallDirFindsNoneVendorTriple(t *testing.T) {
	root := t.TempDir()
	want := filepath.Join(root, "toolchains", "sysroots", "arm-linux-gnueabihf",
		"lib", "gcc", "arm-none-linux-gnueabihf", "10.2.1")
	if err := os.MkdirAll(want, 0o755); err != nil {
		t.Fatal(err)
	}
	p := &Paths{ToolchainsRoot: filepath.Join(root, "toolchains")}
	if got := p.LLVMGCCInstallDir("arm-linux-gnueabihf"); got != want {
		t.Errorf("LLVMGCCInstallDir = %q, want %q", got, want)
	}
	if got := p.LLVMGCCInstallDir("aarch64-linux-gnu"); got != "" {
		t.Errorf("missing sysroot should yield \"\", got %q", got)
	}
}

// Newest version wins when several GCC versions ship side by side.
func TestLLVMGCCInstallDirPicksHighestVersion(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "toolchains", "sysroots", "aarch64-linux-gnu",
		"lib", "gcc", "aarch64-none-linux-gnu")
	for _, v := range []string{"9.3.0", "10.2.1"} {
		if err := os.MkdirAll(filepath.Join(base, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	p := &Paths{ToolchainsRoot: filepath.Join(root, "toolchains")}
	want := filepath.Join(base, "10.2.1")
	if got := p.LLVMGCCInstallDir("aarch64-linux-gnu"); got != want {
		t.Errorf("LLVMGCCInstallDir = %q, want %q", got, want)
	}
}
