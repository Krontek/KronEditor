//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCapPrmHasNetRaw(t *testing.T) {
	const head = "Name:\tkron-host-agent\nUid:\t1000\t1000\t1000\n"
	cases := []struct {
		name   string
		status string
		want   bool
	}{
		// CAP_NET_RAW (13) | CAP_NET_ADMIN (12) = 0x3000
		{"both granted", head + "CapPrm:\t0000000000003000\nCapEff:\t0000000000003000\n", true},
		{"root, all caps", head + "CapPrm:\t000001ffffffffff\n", true},
		{"net_raw only", head + "CapPrm:\t0000000000002000\n", false},
		{"net_admin only", head + "CapPrm:\t0000000000001000\n", false},
		{"plain user", head + "CapPrm:\t0000000000000000\n", false},
		{"no CapPrm line", head, false},
		{"garbage mask", head + "CapPrm:\tnot-a-number\n", false},
	}
	for _, c := range cases {
		if got := capPrmHasNetRaw(c.status); got != c.want {
			t.Errorf("%s: capPrmHasNetRaw = %v, want %v", c.name, got, c.want)
		}
	}
}

// A process that cannot pass the caps on must hand exec.Cmd a nil SysProcAttr:
// asking for an ambient cap you do not hold makes Start() fail with EPERM, which
// would take down a simulation that is otherwise perfectly able to run without
// a bus.
func TestNetRawSysProcAttrMatchesCaps(t *testing.T) {
	attr := netRawSysProcAttr()
	if hasNetRawCaps() {
		if attr == nil || len(attr.AmbientCaps) != 2 {
			t.Fatalf("holding the caps but SysProcAttr = %+v", attr)
		}
	} else if attr != nil {
		t.Fatalf("not holding the caps but SysProcAttr = %+v", attr)
	}
}

// The escalation ladder must never hand back a command that cannot run. In
// particular a `sudo -A` launch is useless without SUDO_ASKPASS in its env, and
// an unprivileged fallback must not carry ambient caps this process lacks
// (Start would fail EPERM and take the whole simulation with it).
func TestRuntimeLaunchCmdIsCoherent(t *testing.T) {
	cmd, note := runtimeLaunchCmd("/bin/true", []string{"arg1"})
	if cmd == nil || note == "" {
		t.Fatalf("runtimeLaunchCmd returned cmd=%v note=%q", cmd, note)
	}
	// The program must always be reachable by absolute path — sudo and pkexec
	// both reject a bare name, and the fallback should not depend on PATH.
	if !filepath.IsAbs(cmd.Path) {
		t.Errorf("launch path is not absolute: %q", cmd.Path)
	}
	// The target binary and its args must survive whichever wrapper was chosen.
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "/bin/true") || !strings.Contains(joined, "arg1") {
		t.Errorf("target or args lost through the wrapper: %v", cmd.Args)
	}
	if strings.Contains(note, "askpass") {
		found := false
		for _, e := range cmd.Env {
			if strings.HasPrefix(e, "SUDO_ASKPASS=") {
				found = true
			}
		}
		if !found {
			t.Error("sudo -A launch without SUDO_ASKPASS in the environment")
		}
	}
	if strings.HasPrefix(note, "unprivileged") && cmd.SysProcAttr != nil && !hasNetRawCaps() {
		t.Error("ambient caps requested while this process holds none — Start would fail EPERM")
	}
}

// lookupTool has to find helpers that live outside a desktop user's PATH
// (/sbin, /usr/sbin on Debian) — the bug that made the agent claim setcap was
// not installed on a machine that had it.
func TestLookupToolFindsSbinTools(t *testing.T) {
	if _, err := os.Stat("/sbin/setcap"); err == nil {
		if p, ok := lookupTool("setcap"); !ok || p == "" {
			t.Errorf("setcap exists at /sbin/setcap but lookupTool said %q, %v", p, ok)
		}
	}
	if _, ok := lookupTool("this-binary-does-not-exist-xyzzy"); ok {
		t.Error("lookupTool invented a path for a nonexistent tool")
	}
}
