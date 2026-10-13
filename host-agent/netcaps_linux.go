//go:build linux

package main

// Raw-socket rights for the locally spawned runtime.
//
// SOEM opens an AF_PACKET socket on the developer PC's NIC, which needs
// CAP_NET_RAW (plus CAP_NET_ADMIN for the interface ioctls). The old answer was
// to setcap the freshly built plc_host / sim_runtime.bin, but that binary is
// REBUILT on every run — file capabilities die with the inode, so the user had
// to re-run a sudo command after every single build, and setcap itself needs
// root anyway, so it almost never succeeded.
//
// The agent is the stable file, so the rights are granted THERE once and handed
// to each spawned runtime through the AMBIENT capability set: the child gets
// them without any file capabilities of its own, and the sim keeps running as
// the user (no sudo), which matters because a root-spawned runtime would own a
// 0600 shm mirror the agent could not read and would not take the hot-swap
// SIGUSR1 (see host-agent/CLAUDE.md).

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Capability bit numbers (linux/capability.h). Not in x/sys, and pulling a
// module in for two constants is not worth it.
const (
	capNetAdmin uintptr = 12
	capNetRaw   uintptr = 13
)

// hasNetRawCaps reports whether this process could hand CAP_NET_RAW /
// CAP_NET_ADMIN to a child — i.e. it holds both in its PERMITTED set, either
// from file capabilities on the agent binary or by running as root.
//
// Read from /proc/self/status rather than capget(2): the permitted mask is what
// PR_CAP_AMBIENT_RAISE checks against, and the text form needs no syscall
// plumbing.
func hasNetRawCaps() bool {
	blob, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	return capPrmHasNetRaw(string(blob))
}

// capPrmHasNetRaw parses the CapPrm line of a /proc/<pid>/status dump and
// reports whether BOTH caps are set. Split out so it is testable without a
// privileged process.
func capPrmHasNetRaw(status string) bool {
	for _, line := range strings.Split(status, "\n") {
		rest, ok := strings.CutPrefix(line, "CapPrm:")
		if !ok {
			continue
		}
		mask, err := strconv.ParseUint(strings.TrimSpace(rest), 16, 64)
		if err != nil {
			return false
		}
		return mask&(1<<capNetRaw) != 0 && mask&(1<<capNetAdmin) != 0
	}
	return false
}

// netRawSysProcAttr returns the SysProcAttr that passes the raw-socket caps on
// to a spawned runtime, or nil when this agent has nothing to pass (the sim
// still starts — kron_ec_init just reports the bus as absent).
//
// ⚠️ Go raises AmbientCaps in the CHILD between fork and exec, which requires
// each cap to be in the child's permitted set at that moment — inherited from
// this process. Asking for one we do not hold makes Start() fail with EPERM and
// would take the whole simulation down with it, hence the guard.
func netRawSysProcAttr() *syscall.SysProcAttr {
	if !hasNetRawCaps() {
		return nil
	}
	return &syscall.SysProcAttr{AmbientCaps: []uintptr{capNetRaw, capNetAdmin}}
}

// netRawGrantHint is the one-time command that fixes a host which cannot drive
// the bus. It names the AGENT binary, not the build output: that one is stable,
// so the user runs this once instead of after every build.
func netRawGrantHint() string {
	self, err := os.Executable()
	if err != nil || self == "" {
		self = "kron-host-agent"
	}
	setcap, ok := lookupTool("setcap")
	if !ok {
		setcap = "setcap"
	}
	_ = ok
	return fmt.Sprintf("EtherCAT needs raw-socket rights. Run ONCE, then restart the agent:\n"+
		"    sudo %s cap_net_raw,cap_net_admin+eip %s\n"+
		"(needs libcap2-bin; every simulation started afterwards inherits the rights — no sudo per run)", setcap, self)
}

// grantNetRawCapsInteractive stamps the AGENT binary with the raw-socket caps
// through pkexec, so the desktop's own polkit agent asks for the password
// instead of the user finding a terminal. Returns (granted, message).
//
// ⚠️ The target is always THIS executable, never a path from the request: the
// endpoint runs a privileged helper, and taking the binary from the caller
// would turn an origin-gated convenience into "setcap anything".
//
// ⚠️ File capabilities take effect at exec(2), so the RUNNING agent does not
// gain them — the caller has to restart. Nothing here re-execs on its own: a
// live simulation is a child of this process and would be orphaned.
func grantNetRawCapsInteractive() (bool, string) {
	self, err := os.Executable()
	if err != nil || self == "" {
		return false, "cannot locate the agent binary to grant rights to"
	}
	if hasNetRawCaps() {
		return true, "already granted"
	}
	setcap, ok := lookupTool("setcap")
	if !ok {
		return false, "setcap not found — install libcap2-bin (Debian/Ubuntu) or libcap (Fedora/Arch), then try again"
	}
	pkexec, ok := lookupTool("pkexec")
	if !ok {
		return false, "pkexec not found — run this once in a terminal:\n    sudo " + setcap + " cap_net_raw,cap_net_admin+eip " + self
	}
	// Generous: the user has to read a dialog and type a password.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, pkexec, setcap, "cap_net_raw,cap_net_admin+eip", self)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return true, "granted — restart the editor for it to take effect"
	}
	txt := strings.TrimSpace(string(out))
	switch {
	case ctx.Err() != nil:
		return false, "the authorization dialog timed out"
	// pkexec's own exit codes: 126 = not authorized / dismissed, 127 = could
	// not run the helper (no polkit agent in this session, e.g. a bare WM).
	case cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 126:
		return false, "authorization was dismissed or denied"
	case cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 127:
		return false, "no polkit agent is running in this session — run this once in a terminal:\n    sudo " + setcap + " cap_net_raw,cap_net_admin+eip " + self
	// squashfs (AppImage), NFS, some overlay mounts: the filesystem cannot
	// carry file capabilities at all, so no amount of privilege helps.
	case strings.Contains(txt, "not supported") || strings.Contains(txt, "Operation not supported"):
		return false, "this filesystem cannot store file capabilities (AppImage/squashfs/NFS). Install the editor on a normal disk, or start it with sudo, to drive a real EtherCAT bus"
	}
	if txt == "" {
		txt = err.Error()
	}
	return false, "setcap failed: " + txt
}

// lookupTool resolves a helper binary by name.
//
// ⚠️ exec.LookPath searches PATH only, and on Debian/Ubuntu a desktop session's
// PATH excludes /sbin and /usr/sbin for non-root users — where setcap actually
// lives. The agent therefore reported "setcap not found — install libcap2-bin"
// on a machine that had it installed all along, and `sudo setcap` worked from a
// terminal only because root's PATH does include those directories.
func lookupTool(name string) (string, bool) {
	if p, err := exec.LookPath(name); err == nil {
		return p, true
	}
	for _, dir := range []string{"/usr/sbin", "/sbin", "/usr/local/sbin", "/usr/bin", "/bin"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, true
		}
	}
	return "", false
}

// hasPrivilegedLauncher reports whether a runtime can be started with a password
// prompt (the normal path). When false, the ambient-capability fallback is all
// there is, and only THEN is granting caps to the agent worth offering.
func hasPrivilegedLauncher() bool {
	if _, ok := lookupTool("pkexec"); ok {
		return true
	}
	if sudo, ok := lookupTool("sudo"); ok {
		return sudoNoPasswordWorks(sudo) || findAskpass() != ""
	}
	return false
}

// askpassCandidates are the GUI password prompters sudo -A can drive, best
// first: ksshaskpass integrates with KDE's wallet, the ssh-askpass variants are
// what a plain X11/Wayland desktop ships.
var askpassCandidates = []string{
	"ksshaskpass",
	"ssh-askpass",
	"lxqt-openssh-askpass",
	"/usr/lib/openssh/gnome-ssh-askpass",
	"/usr/libexec/openssh/gnome-ssh-askpass",
	"x11-ssh-askpass",
}

func findAskpass() string {
	for _, c := range askpassCandidates {
		if p, ok := lookupTool(c); ok {
			return p
		}
	}
	return ""
}

// sudoNoPasswordWorks probes whether sudo would run without prompting — either a
// NOPASSWD sudoers rule or a still-valid timestamp from an earlier prompt. Cheap
// (a few ms) and re-probed per launch, since a timestamp expires.
func sudoNoPasswordWorks(sudo string) bool {
	cmd := exec.Command(sudo, "-n", "true")
	cmd.Stdin = nil
	return cmd.Run() == nil
}

// runtimeLaunchCmd builds the command that starts a locally spawned runtime.
//
// Policy (decided deliberately): the runtime ALWAYS runs privileged, simulation
// included. EtherCAT needs a raw socket, the scan threads need SCHED_FIFO, and a
// partially privileged runtime fails in ways that look like PLC bugs rather than
// permission errors.
//
// ⚠️ The mechanism ADAPTS to the machine instead of requiring one package. An
// HTTP agent has no controlling terminal, so plain `sudo` dies with "no tty
// present and no askpass program specified" — hence a prompter is always
// involved. In order:
//
//	pkexec     — polkit's helper. Not installed by default on Debian (it is
//	             setuid-root, the PwnKit CVE lived here), so it cannot be a
//	             requirement, only a preference where it already exists.
//	sudo -n    — a NOPASSWD sudoers rule, or a still-valid sudo timestamp.
//	             Silent, and the same model KronServer uses on the target.
//	sudo -A    — sudo driving a GUI askpass; the desktop asks for the password.
//	direct     — last resort, with ambient capabilities if the agent has any.
//
// ⚠️ The returned command may be a ROOT child of an unprivileged agent, which
// cannot be signalled or killed by it. Everything that used to ride
// SIGUSR1/SIGTERM has a file trigger in hotswaphost/host.c; do not add a new
// control path that assumes kill(2) works.
func runtimeLaunchCmd(bin string, args []string) (*exec.Cmd, string) {
	abs := bin
	if p, err := filepath.Abs(bin); err == nil {
		abs = p
	}
	if pkexec, ok := lookupTool("pkexec"); ok {
		return exec.Command(pkexec, append([]string{abs}, args...)...), "privileged (pkexec)"
	}
	if sudo, ok := lookupTool("sudo"); ok {
		if sudoNoPasswordWorks(sudo) {
			return exec.Command(sudo, append([]string{"-n", abs}, args...)...), "privileged (sudo, no password needed)"
		}
		if askpass := findAskpass(); askpass != "" {
			cmd := exec.Command(sudo, append([]string{"-A", abs}, args...)...)
			// ⚠️ sudo sanitizes the environment but honours SUDO_ASKPASS, and the
			// helper itself runs before privileges change, so it inherits this
			// process's DISPLAY/WAYLAND_DISPLAY and can actually draw a dialog.
			// ⚠️ SUDO_PROMPT too: sudo's default "[sudo] password for %p: " is not a
			// phrase ksshaskpass knows, so it logged "Unable to parse phrase" and
			// showed a bare box. A plain prompt also tells the user WHY a password
			// is suddenly being asked for by a PLC editor.
			cmd.Env = append(os.Environ(),
				"SUDO_ASKPASS="+askpass,
				"SUDO_PROMPT=KronEditor needs administrator rights to start the PLC runtime (real-time scheduling and EtherCAT). Password:")
			return cmd, "privileged (sudo, password prompt via " + filepath.Base(askpass) + ")"
		}
	}
	cmd := exec.Command(abs, args...)
	cmd.SysProcAttr = netRawSysProcAttr()
	if cmd.SysProcAttr != nil {
		return cmd, "unprivileged, with inherited raw-socket capabilities (no pkexec, no askpass)"
	}
	return cmd, "unprivileged — no EtherCAT and no real-time scheduling (no pkexec, no sudo askpass, no capabilities on the agent)"
}

// stopRequestPath is the file a privileged runtime watches for a graceful stop,
// since the agent cannot signal it. host.c removes it on the way out.
func stopRequestPath(buildDir string) string { return filepath.Join(buildDir, "stop_request") }

// privilegedKill is the last resort when a root runtime ignores stop_request and
// cannot be killed by an unprivileged agent. It prompts for a password again, so
// it only ever runs after the graceful path has already timed out.
func privilegedKill(pid int) error {
	killBin, ok := lookupTool("kill")
	if !ok {
		return fmt.Errorf("kill binary not found")
	}
	if sudo, ok := lookupTool("sudo"); ok && sudoNoPasswordWorks(sudo) {
		return exec.Command(sudo, "-n", killBin, "-KILL", strconv.Itoa(pid)).Run()
	}
	pkexec, ok := lookupTool("pkexec")
	if !ok {
		return fmt.Errorf("no way to kill a privileged runtime (no passwordless sudo, no pkexec)")
	}
	// ⚠️ An absolute path, not "kill": these run a program, and `kill` is a
	// shell builtin — /bin/kill is the binary that actually exists.
	return exec.Command(pkexec, killBin, "-KILL", strconv.Itoa(pid)).Run()
}
