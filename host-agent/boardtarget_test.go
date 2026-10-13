package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// Build & Send and the field hot-swap build used to map board ids separately,
// and the hot-swap copy sent generic_linux_x64/_armv7 to aarch64.
func TestBoardTargetFor(t *testing.T) {
	cases := map[string]string{
		"generic_linux_x64":   "x86_64-linux-gnu",
		"generic_linux_armv7": "arm-linux-gnueabihf",
		"generic_linux_arm64": "aarch64-linux-gnu",
		"bb_black":            "arm-linux-gnueabihf",
		"bb_ai64":             "aarch64-linux-gnu",
		"rpi_5":               "aarch64-linux-gnu",
		"jetson_orin_nano":    "aarch64-linux-gnu",
	}
	for id, want := range cases {
		bt, err := boardTargetFor(id)
		if err != nil || bt.llvmTarget != want {
			t.Errorf("boardTargetFor(%q) = %q, %v; want %q", id, bt.llvmTarget, err, want)
		}
	}
	if bt, _ := boardTargetFor("generic_linux_armv7"); !strings.Contains(strings.Join(bt.flags, " "), "-march=armv7-a") {
		t.Errorf("armv7 flags missing: %v", bt.flags)
	}
	if _, err := boardTargetFor("rpi_pico"); err == nil {
		t.Error("rpi_pico must be refused")
	}
}

func TestTargetBuildDirStaysInside(t *testing.T) {
	p := &Paths{AppDataDir: t.TempDir()}
	base := filepath.Join(p.BuildDir(), "target") + string(filepath.Separator)
	for _, id := range []string{"../../etc", "a/b", `c:\x`, "", "rpi_5"} {
		d := p.TargetBuildDir(id)
		if !strings.HasPrefix(d, base) || strings.Contains(d[len(base):], string(filepath.Separator)) {
			t.Errorf("TargetBuildDir(%q) = %q escapes %q", id, d, base)
		}
	}
	if p.SimBuildDir() == p.TargetBuildDir("sim") {
		t.Error("sim and target dirs must differ")
	}
}
