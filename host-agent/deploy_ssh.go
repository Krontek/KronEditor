package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ── deploy_server_to_target (SSH/SFTP) ───────────────────────────────────────
//
// Ports the old Tauri ssh2 implementation to Go: SCPs the prebuilt KronServer
// ("plc-agent") binary for the target board to <home>/plc/plc-agent over SFTP,
// then installs a supervisor (systemd unit when available, else a plain
// restart-on-crash script with best-effort boot persistence) and starts it. Progress is streamed to the editor over SSE on the
// "server-deploy-progress" topic (the frontend opens that stream before the POST).

type deployServerReq struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	BoardID  string `json:"boardId"`
}

// aarch64BoardPrefixes lists board-id prefixes that map to the aarch64 Linux
// server binary. The third-party SBC prefixes (opi_, radxa_, odroid_, bpi_,
// libre_, pine_ — Orange Pi, Radxa, Odroid, Banana Pi, Libre Computer,
// Pine64) reuse the generic Linux HAL (RPi family) and the arm64 binary.
var aarch64BoardPrefixes = []string{"rpi_", "jetson_", "opi_", "radxa_", "odroid_", "bpi_", "libre_", "pine_"}

// serverBinaryForBoard maps a board id to (resource-target key, binary file name).
// Mirrors the original Tauri selection: RPi/Jetson/BB-AI64 → arm64, other BB → armv7,
// everything else → amd64. Legacy rpi_pico projects are rejected outright
// (the board was removed; a Cortex-M part has no OS to host the server).
func serverBinaryForBoard(boardID string) (resourceTarget, binaryName string, err error) {
	isAarch64 := boardID == "bb_ai64"
	for _, p := range aarch64BoardPrefixes {
		if strings.HasPrefix(boardID, p) {
			isAarch64 = true
			break
		}
	}
	switch {
	case strings.HasPrefix(boardID, "rpi_pico"):
		return "", "", fmt.Errorf("Pico boards are no longer supported — reselect a Linux board in Board Config")
	case strings.HasPrefix(boardID, "bb_") && !strings.HasPrefix(boardID, "bb_ai64"):
		return "arm/armv7", "plc-agent_linux_armv7", nil
	case isAarch64:
		return "arm/aarch64", "plc-agent_linux_arm64", nil
	default:
		return "x86_64/linux", "plc-agent_linux_amd64", nil
	}
}

func (s *Server) handleDeployServerToTarget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req deployServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Port == 0 {
		req.Port = 22
	}
	progress := func(msg string) { s.events.Emit("server-deploy-progress", msg) }

	// Locate the prebuilt server binary for this board.
	resourceTarget, binaryName, err := serverBinaryForBoard(req.BoardID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	serverDir, err := s.paths.ResourceTargetServerDir(resourceTarget)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	binaryPath := filepath.Join(serverDir, binaryName)
	binaryData, err := os.ReadFile(binaryPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf(
			"Server binary not found: %s\nBuild the server first (server/build.sh).", binaryPath))
		return
	}

	progress("Connecting via SSH...")
	hostKeyCb, hkErr := s.tofuHostKeyCallback(progress)
	if hkErr != nil {
		writeError(w, http.StatusInternalServerError, "known_hosts init: "+hkErr.Error())
		return
	}
	// Answer keyboard-interactive prompts with the same password. Many SSH
	// servers (PAM) only offer keyboard-interactive, not the raw "password"
	// method — without this, a correct password still fails to authenticate.
	kbInteractive := ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
		answers := make([]string, len(questions))
		for i := range questions {
			answers[i] = req.Password
		}
		return answers, nil
	})
	cfg := &ssh.ClientConfig{
		User:            req.Username,
		Auth:            []ssh.AuthMethod{ssh.Password(req.Password), kbInteractive},
		HostKeyCallback: hostKeyCb,
		Timeout:         10 * time.Second,
	}
	addr := fmt.Sprintf("%s:%d", req.Host, req.Port)
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SSH connection/auth to "+addr+" failed: "+err.Error())
		return
	}
	defer client.Close()

	progress("Connected. Detecting home directory...")
	home := strings.TrimSpace(sshRunLogged(client, "echo $HOME", progress, "home-dir detection"))
	if home == "" {
		home = "/home/" + req.Username
	}
	remoteDir := home + "/plc"
	remoteBin := remoteDir + "/plc-agent"

	// sudo prefix: root or empty password → no sudo. Otherwise pipe the password
	// into `sudo -S`. Single quotes in the password are shell-escaped.
	sudo := ""
	if req.Username != "root" && req.Password != "" {
		sudo = "echo '" + strings.ReplaceAll(req.Password, "'", `'\''`) + "' | sudo -S "
	}

	progress("Stopping existing plc-agent...")
	stopScript := killPatternPrologue +
		"systemctl stop plc-agent 2>/dev/null\n" +
		"killpat plc-agent-supervisor\n" +
		"killpat " + remoteBin + "\n" +
		"sleep 1\n" +
		"killpat plc-agent-supervisor KILL\n" +
		"killpat " + remoteBin + " KILL\n" +
		"rm -f " + remoteBin + "\n" +
		"exit 0\n"
	// Best-effort by design (nothing may be installed yet) — but log failures.
	if out, err := runStagedScript(client, sudo, "/tmp/kron-stop.sh", stopScript); err != nil {
		progress("warning: stopping existing agent failed: " + err.Error() + "\n" + out)
	}

	progress("Uploading server binary via SFTP...")
	sc, err := sftp.NewClient(client)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SFTP init failed: "+err.Error())
		return
	}
	defer sc.Close()
	_ = sc.MkdirAll(remoteDir)
	rf, err := sc.OpenFile(remoteBin, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SFTP create failed: "+err.Error())
		return
	}
	if _, err := rf.Write(binaryData); err != nil {
		rf.Close()
		writeError(w, http.StatusBadGateway, "SFTP write failed: "+err.Error())
		return
	}
	rf.Close()
	_ = sc.Chmod(remoteBin, 0o755)
	_ = sshRunLogged(client, "chmod +x "+remoteBin, progress, "chmod") // belt-and-suspenders

	// Install + start a supervisor: systemd when the target actually boots
	// under it, else a restart-on-crash script plus every boot hook the image
	// really runs (works on BusyBox/Alpine/Yocto/OpenWRT — see installBootHook).
	systemd := strings.TrimSpace(sshRunLogged(client,
		"if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then echo systemd; else echo cron; fi",
		progress, "init-system detection")) == "systemd"
	var mode string
	if systemd {
		progress("systemd detected — installing service unit...")
		if out, err := installSystemdUnit(client, sudo, remoteBin, remoteDir); err != nil {
			writeError(w, http.StatusBadGateway, "systemd unit install failed: "+err.Error()+"\n"+out)
			return
		}
		progress("Starting plc-agent (systemd)...")
		if out, err := sshRun(client, sudo+"systemctl restart plc-agent"); err != nil {
			writeError(w, http.StatusBadGateway, "systemctl restart failed: "+err.Error()+"\n"+out)
			return
		}
		mode = "systemd"
	} else {
		progress("systemd not found — installing script supervisor...")
		if out, err := installSupervisorScript(client, remoteBin, remoteDir); err != nil {
			writeError(w, http.StatusBadGateway, "supervisor install failed: "+err.Error()+"\n"+out)
			return
		}
		// Boot persistence is BEST-EFFORT: a minimal image may have neither
		// systemd nor crontab nor a writable rc.local, and that must not fail a
		// deploy — the agent still runs now, it just won't come back on reboot.
		hook := installBootHook(client, sudo, remoteDir, progress)
		progress("Starting plc-agent supervisor...")
		if out, err := startSupervisorScript(client, sudo, remoteDir); err != nil {
			writeError(w, http.StatusBadGateway, "supervisor start failed: "+err.Error()+"\n"+out)
			return
		}
		mode = "script supervisor, autostart: " + hook
	}

	// Verify the agent answers /status (ARM boards can take 10+ s to come up).
	checkAddr := fmt.Sprintf("%s:7070", req.Host)
	var lastErr string
	for attempt := 1; attempt <= 5; attempt++ {
		time.Sleep(2 * time.Second)
		progress(fmt.Sprintf("Verifying agent is running (attempt %d/5)...", attempt))
		if err := httpStatusOK("http://" + checkAddr + "/status"); err == nil {
			progress(fmt.Sprintf("plc-agent deployed and running (%s supervision)!", mode))
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Server deployed successfully"})
			return
		} else {
			lastErr = err.Error()
		}
	}

	// Did not come up — gather init-system-aware diagnostics for the user.
	var diagCmd string
	if systemd {
		diagCmd = fmt.Sprintf(
			"systemctl status plc-agent 2>&1 | head -30; echo '---'; "+
				"journalctl -u plc-agent -n 20 2>&1; echo '---'; tail -20 %s/plc-agent.log 2>&1", remoteDir)
	} else {
		diagCmd = fmt.Sprintf(
			"{ ps -ef 2>/dev/null || ps; } | grep -E 'plc-agent(-supervisor)?' | grep -v grep; echo '---'; "+
				"command -v crontab >/dev/null 2>&1 && %scrontab -l 2>&1 | grep plc-agent; echo '---'; "+
				"tail -40 %s/plc-agent.log 2>&1", sudo, remoteDir)
	}
	if diag := strings.TrimSpace(sshRunLogged(client, diagCmd, progress, "diagnostics collection")); diag != "" {
		progress("Agent did not start. Diagnostics:\n" + diag)
	}
	writeError(w, http.StatusBadGateway, "Server deployed but agent did not respond after 10s: "+lastErr)
}

// sshRunTimeout bounds every remote command — a wedged target (dead sudo
// prompt, hung service manager) must not hang the deploy handler forever.
const sshRunTimeout = 30 * time.Second

// sshRun runs one command and returns its combined stdout+stderr plus any
// error (session failure, non-zero exit, or timeout).
func sshRun(client *ssh.Client, cmd string) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()
	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := sess.CombinedOutput(cmd)
		ch <- result{out, err}
	}()
	select {
	case res := <-ch:
		return string(res.out), res.err
	case <-time.After(sshRunTimeout):
		_ = sess.Close() // unblocks the goroutine's CombinedOutput
		return "", fmt.Errorf("ssh command timed out after %s", sshRunTimeout)
	}
}

// sshRunLogged is the best-effort variant: it logs a failure via progress and
// returns the output (used where the old code deliberately ignored errors).
func sshRunLogged(client *ssh.Client, cmd string, progress func(string), what string) string {
	out, err := sshRun(client, cmd)
	if err != nil {
		progress(fmt.Sprintf("warning: %s failed: %v", what, err))
	}
	return out
}

// killPatternPrologue is a POSIX-sh replacement for `pkill -f`. Minimal images
// (BusyBox/Yocto) ship neither pkill nor pgrep, and the old `pkill -f ...
// 2>/dev/null` was therefore a SILENT no-op: "Stopping existing plc-agent"
// stopped nothing, deploys accumulated supervisors, and each surplus agent
// killed the live runtime as an "orphan" every 2 s.
//
// It matches /proc/<pid>/cmdline with shell globbing only (no grep child) and
// ⚠️ skips its OWN process ancestry, walking PPIDs up from $$. Without that it
// signals the shell running it — every deploy command line necessarily
// contains the pattern it is about to kill. Ancestry is used rather than a
// sentinel string in the script, which only ever protected callers whose
// command line happened to carry it. The PPID is read past the last ")"
// because /proc/<pid>/stat's comm field is itself parenthesised and may hold
// spaces ("(plc-agent-super)").
const killPatternPrologue = "#!/bin/sh\n" +
	"kron_skip=\" \"\n" +
	"kron_p=$$\n" +
	"while [ \"$kron_p\" -gt 1 ] 2>/dev/null; do\n" +
	"  kron_skip=\"$kron_skip$kron_p \"\n" +
	"  kron_p=$(sed 's/.*) //' /proc/$kron_p/stat 2>/dev/null | cut -d' ' -f2)\n" +
	"  [ -n \"$kron_p\" ] || break\n" +
	"done\n" +
	"killpat() {\n" +
	"  for d in /proc/[0-9]*; do\n" +
	"    pid=${d#/proc/}\n" +
	"    case \"$kron_skip\" in *\" $pid \"*) continue ;; esac\n" +
	"    cl=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null) || continue\n" +
	"    case \"$cl\" in *\"$1\"*) kill -\"${2:-TERM}\" \"$pid\" 2>/dev/null ;; esac\n" +
	"  done\n" +
	"}\n"

// runStagedScript uploads body to remotePath and executes it (under sudo when
// given), so no script has to survive nested shell quoting.
func runStagedScript(client *ssh.Client, sudo, remotePath, body string) (string, error) {
	return sshRun(client, fmt.Sprintf(
		"cat > %[1]s << 'KRONSTAGED'\n%[2]sKRONSTAGED\nchmod +x %[1]s && %[3]ssh %[1]s",
		remotePath, body, sudo))
}

// installSystemdUnit writes /etc/systemd/system/plc-agent.service and enables it.
// Restart=always keeps the agent up across crashes.
func installSystemdUnit(client *ssh.Client, sudo, remoteBin, remoteDir string) (string, error) {
	unit := fmt.Sprintf("[Unit]\nDescription=PLC Agent (KronServer)\nAfter=network.target\n\n"+
		"[Service]\nExecStart=%s -addr :7070 -deploy-dir %s -shm-name plc_runtime -shm-size 65536\n"+
		"Restart=always\nRestartSec=3\nWorkingDirectory=%s\nUser=root\n\n"+
		"[Install]\nWantedBy=multi-user.target\n", remoteBin, remoteDir, remoteDir)
	cmd := fmt.Sprintf(
		"cat > /tmp/plc-agent.service << 'UNIT'\n%sUNIT\n"+
			"%[2]scp /tmp/plc-agent.service /etc/systemd/system/plc-agent.service && "+
			"%[2]ssystemctl daemon-reload && %[2]ssystemctl enable plc-agent", unit, sudo)
	return sshRun(client, cmd)
}

// supervisorBody is the supervisor script text (split out so it can be
// exercised by a test without an SSH connection).
func supervisorBody(remoteBin, remoteDir string) string {
	return "#!/bin/sh\n" +
		"# plc-agent supervisor — restarts the agent on crash.\n" +
		"BIN=" + remoteBin + "\n" +
		"DIR=" + remoteDir + "\n" +
		"LOG=$DIR/plc-agent.log\n" +
		"PIDF=$DIR/plc-agent-supervisor.pid\n" +
		// Second line of defence against a doubled supervisor (rc.local plus a
		// manual start): a live supervisor owns the pidfile, a newcomer exits.
		// The cmdline is re-checked so a recycled PID cannot lock us out.
		"if [ -f \"$PIDF\" ]; then\n" +
		"  OLD=$(cat \"$PIDF\" 2>/dev/null)\n" +
		"  if [ -n \"$OLD\" ] && [ -r /proc/$OLD/cmdline ] && " +
		"tr '\\0' ' ' < /proc/$OLD/cmdline | grep -q plc-agent-supervisor; then exit 0; fi\n" +
		"fi\n" +
		"echo $$ > \"$PIDF\"\n" +
		"trap 'rm -f \"$PIDF\"; kill -TERM \"$CHILD\" 2>/dev/null; exit 0' TERM INT\n" +
		"while true; do\n" +
		"  \"$BIN\" -addr :7070 -deploy-dir \"$DIR\" -shm-name plc_runtime -shm-size 65536 >> \"$LOG\" 2>&1 &\n" +
		"  CHILD=$!\n" +
		"  wait \"$CHILD\"\n" +
		"  sleep 2\n" +
		"done\n"
}

// installSupervisorScript writes a POSIX-sh restart-on-crash supervisor into
// the deploy dir. It touches nothing outside remoteDir, so it works on any
// image (BusyBox/Alpine/Yocto/OpenWRT) regardless of the init system.
func installSupervisorScript(client *ssh.Client, remoteBin, remoteDir string) (string, error) {
	sup := remoteDir + "/plc-agent-supervisor.sh"
	cmd := fmt.Sprintf("cat > %[1]s << 'SUPERVISOR'\n%[2]sSUPERVISOR\nchmod +x %[1]s", sup, supervisorBody(remoteBin, remoteDir))
	return sshRun(client, cmd)
}

// bootCaps is the one-round-trip probe of what the target's init system can
// actually be hooked into. ⚠️ Each field means "this hook is RUN AT BOOT", not
// merely "this file can be written" — the previous version installed an
// /etc/rc.local line on a Yocto/BusyBox image and reported success, but that
// image runs /etc/init.d/rcS → /etc/rc<N>.d/S* symlinks and nothing there ever
// reads rc.local, so the agent silently never came back after a power cycle.
type bootCaps struct {
	initd   bool   // /etc/init.d/rcS exists → an init.d script is run at boot
	rcDir   string // runlevel dir whose S* symlinks are run ("" = none; sysvinit)
	crontab bool   // crontab(1) present → @reboot entry
	rcLocal bool   // something actually EXECUTES /etc/rc.local
}

// probeBootCaps asks the target once, in POSIX sh, which boot hooks are real.
// ⚠️ The runlevel dir comes from inittab's `initdefault`, not a guess: this
// Yocto image defaults to runlevel 5, so a symlink dropped in rc3.d (the
// conventional choice) would never be executed.
func probeBootCaps(client *ssh.Client) bootCaps {
	script := "#!/bin/sh\n" +
		// BusyBox/Buildroot inittab runs rcS, which either executes
		// /etc/init.d/S??* directly or the S* symlinks of a runlevel dir.
		"if [ -d /etc/init.d ] && { [ -f /etc/init.d/rcS ] || " +
		"grep -q 'init.d/rcS' /etc/inittab 2>/dev/null; }; then echo initd; fi\n" +
		"RL=$(sed -n 's/^[a-zA-Z0-9]*:\\([0-9]\\):initdefault.*/\\1/p' /etc/inittab 2>/dev/null | head -n 1)\n" +
		"for d in /etc/rc$RL.d /etc/rc5.d /etc/rc3.d /etc/rc2.d /etc/rcS.d; do\n" +
		"  [ -d \"$d\" ] && { echo \"rcdir=$d\"; break; }\n" +
		"done\n" +
		"command -v crontab >/dev/null 2>&1 && echo crontab\n" +
		// rc.local is only honoured by sysvinit's own init script, systemd's
		// rc-local generator unit, or an explicit inittab line.
		"if [ -f /etc/init.d/rc.local ] || ls /etc/rc*.d/*rc.local >/dev/null 2>&1 || " +
		"[ -f /lib/systemd/system/rc-local.service ] || " +
		"[ -f /usr/lib/systemd/system/rc-local.service ] || " +
		"grep -q 'rc.local' /etc/inittab 2>/dev/null; then echo rclocal; fi\n" +
		"exit 0\n"
	out := sshRun2(client, fmt.Sprintf(
		"cat > /tmp/kron-bootprobe.sh << 'PROBE'\n%sPROBE\nsh /tmp/kron-bootprobe.sh; rm -f /tmp/kron-bootprobe.sh", script))
	var c bootCaps
	for _, ln := range strings.Split(out, "\n") {
		switch ln = strings.TrimSpace(ln); {
		case ln == "initd":
			c.initd = true
		case ln == "crontab":
			c.crontab = true
		case ln == "rclocal":
			c.rcLocal = true
		case strings.HasPrefix(ln, "rcdir="):
			c.rcDir = strings.TrimPrefix(ln, "rcdir=")
		}
	}
	return c
}

// installBootHook installs EVERY boot hook the target actually runs (an
// init.d/runlevel script, a @reboot crontab entry, an /etc/rc.local line) so
// the supervisor comes back after a power cycle. Installing more than one is
// safe: the supervisor's pidfile guard makes a second start a no-op.
//
// Every step is best-effort — it returns a human-readable list of what stuck
// (or "none") and never an error, see the caller. ⚠️ A step counts as
// installed only when the target is known to EXECUTE it at boot
// (probeBootCaps) AND a read-back confirms the hook is in place: both of the
// bugs this replaced reported success while doing nothing.
func installBootHook(client *ssh.Client, sudo, remoteDir string, progress func(string)) string {
	sup := remoteDir + "/plc-agent-supervisor.sh"
	caps := probeBootCaps(client)
	var installed []string

	// 1. init.d script (+ runlevel symlink) — the only hook a Yocto/Buildroot
	//    image runs. rcS/rc invokes it as `S99plc-agent start`, so it must
	//    background the supervisor and return at once or it hangs the boot.
	if caps.initd {
		if out, err := installInitdHook(client, sudo, remoteDir, caps.rcDir); err == nil {
			where := "/etc/init.d/S99plc-agent"
			if caps.rcDir != "" {
				where += " (+ " + caps.rcDir + " symlink)"
			}
			progress("Autostart: " + where + " installed.")
			installed = append(installed, where)
		} else {
			progress("warning: init.d hook install failed: " + err.Error() + "\n" + out)
		}
	}

	// 2. @reboot crontab entry (Alpine/OpenWRT/anything shipping cron).
	if caps.crontab {
		cmd := fmt.Sprintf("( %[2]scrontab -l 2>/dev/null | grep -v plc-agent-supervisor ; echo '@reboot %[1]s >/dev/null 2>&1' ) | %[2]scrontab -", sup, sudo)
		if out, err := sshRun(client, cmd); err == nil {
			progress("Autostart: @reboot crontab entry installed.")
			installed = append(installed, "cron @reboot")
		} else {
			progress("warning: crontab install failed: " + err.Error() + "\n" + out)
		}
	} else {
		progress("crontab not found — skipping @reboot entry.")
	}

	// 3. /etc/rc.local, only when something actually runs the file.
	if caps.rcLocal {
		if out, err := installRcLocalHook(client, sudo, remoteDir); err == nil {
			progress("Autostart: /etc/rc.local entry installed.")
			installed = append(installed, "/etc/rc.local")
		} else {
			progress("warning: /etc/rc.local install failed: " + err.Error() + "\n" + out)
		}
	} else {
		progress("/etc/rc.local is not executed by this image — skipping.")
	}

	if len(installed) == 0 {
		progress("warning: no autostart could be installed — the agent runs now but will NOT restart after a reboot.")
		return "none"
	}
	return strings.Join(installed, " + ")
}

// initdHookBody is the /etc/init.d/S99plc-agent text (split out so a test can
// exercise it without an SSH connection). BusyBox's rcS and sysvinit's rc both
// call it with "start" and WAIT for it to exit — hence the background launch.
func initdHookBody(remoteDir string) string {
	return "#!/bin/sh\n" +
		"# plc-agent boot hook — starts the KronServer supervisor at boot.\n" +
		"# Installed by KronEditor \"Deploy Server to Target\".\n" +
		"SUP=" + remoteDir + "/plc-agent-supervisor.sh\n" +
		"PIDF=" + remoteDir + "/plc-agent-supervisor.pid\n" +
		"case \"$1\" in\n" +
		"  start|'')\n" +
		"    [ -x \"$SUP\" ] || exit 0\n" +
		// A stale pidfile from the power cut would make the supervisor's own
		// guard bail; the cmdline re-check there handles a recycled PID, but
		// clearing it here keeps the common case unambiguous.
		"    [ -f \"$PIDF\" ] && [ ! -r /proc/$(cat \"$PIDF\" 2>/dev/null)/cmdline ] && rm -f \"$PIDF\"\n" +
		"    \"$SUP\" >/dev/null 2>&1 &\n" +
		"    ;;\n" +
		"  stop)\n" +
		"    [ -f \"$PIDF\" ] && kill -TERM \"$(cat \"$PIDF\" 2>/dev/null)\" 2>/dev/null\n" +
		"    ;;\n" +
		"  restart)\n" +
		"    \"$0\" stop; sleep 1; \"$0\" start\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 0\n"
}

// installInitdHook writes /etc/init.d/S99plc-agent and, when the image runs
// runlevel directories (Yocto/Debian sysvinit run the rc<N>.d S* symlinks, NOT
// every init.d file), symlinks it there too. It read-back-verifies and returns
// an error when the hook is not in place.
func installInitdHook(client *ssh.Client, sudo, remoteDir, rcDir string) (string, error) {
	body := "#!/bin/sh\n" +
		"cat > /etc/init.d/S99plc-agent << 'INITD'\n" + initdHookBody(remoteDir) + "INITD\n" +
		"chmod +x /etc/init.d/S99plc-agent\n"
	if rcDir != "" {
		body += "ln -sf /etc/init.d/S99plc-agent " + rcDir + "/S99plc-agent\n" +
			"[ -x " + rcDir + "/S99plc-agent ] || { echo 'runlevel symlink missing'; exit 1; }\n"
	}
	body += "[ -x /etc/init.d/S99plc-agent ] || { echo 'init.d script missing'; exit 1; }\nexit 0\n"
	return runStagedScript(client, sudo, remoteDir+"/plc-initd-hook.sh", body)
}

// installRcLocalHook inserts the supervisor launch before rc.local's final
// "exit 0" (creating the file when absent) and verifies the result.
// ⚠️ Insertion uses awk, NOT sed's `0,/re/` first-match address: that is a GNU
// extension BusyBox sed rejects, so the old one-line edit failed on every
// BusyBox image while the deploy still reported "rc.local entry installed".
func installRcLocalHook(client *ssh.Client, sudo, remoteDir string) (string, error) {
	body := "#!/bin/sh\n" +
		"LINE='" + remoteDir + "/plc-agent-supervisor.sh >/dev/null 2>&1 &'\n" +
		"[ -f /etc/rc.local ] || printf '#!/bin/sh\\nexit 0\\n' > /etc/rc.local\n" +
		"sed -i '/plc-agent-supervisor/d' /etc/rc.local\n" +
		"if grep -q '^exit 0' /etc/rc.local; then\n" +
		"  awk -v L=\"$LINE\" '!d && /^exit 0/ { print L; d=1 } { print }' /etc/rc.local > /tmp/kron-rc.local && \n" +
		"    cat /tmp/kron-rc.local > /etc/rc.local && rm -f /tmp/kron-rc.local\n" +
		"else\n" +
		"  printf '%s\\n' \"$LINE\" >> /etc/rc.local\n" +
		"fi\n" +
		"chmod +x /etc/rc.local\n" +
		"grep -q plc-agent-supervisor /etc/rc.local || { echo 'rc.local edit did not stick'; exit 1; }\n" +
		"exit 0\n"
	return runStagedScript(client, sudo, remoteDir+"/plc-rc-hook.sh", body)
}

// startSupervisorScript (re)launches the supervisor detached so it survives our
// SSH disconnect.
func startSupervisorScript(client *ssh.Client, sudo, remoteDir string) (string, error) {
	sup := remoteDir + "/plc-agent-supervisor.sh"
	body := killPatternPrologue +
		"killpat plc-agent-supervisor\n" +
		"sleep 1\n" +
		"rm -f " + remoteDir + "/plc-agent-supervisor.pid\n" +
		"nohup " + sup + " >/dev/null 2>&1 &\n" +
		"exit 0\n"
	return runStagedScript(client, sudo, remoteDir+"/plc-agent-start.sh", body)
}

// sshRun2 runs a probe command and returns its output, ignoring the exit status
// (a failing `command -v` is a normal answer, not an error).
func sshRun2(client *ssh.Client, cmd string) string {
	out, _ := sshRun(client, cmd)
	return out
}

// tofuHostKeyCallback returns a trust-on-first-use host-key verifier backed by
// an agent-managed known_hosts file (AppDataDir/known_hosts):
//   - unknown host       → accept and remember (first deploy to a new device just works)
//   - known host, same key → accept
//   - known host, DIFFERENT key → remove the stale entry, persist the new key, and
//     accept (device was reinstalled/re-imaged; auto-retrust is intentional)
func (s *Server) tofuHostKeyCallback(progress func(string)) (ssh.HostKeyCallback, error) {
	path := filepath.Join(s.paths.AppDataDir, "known_hosts")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			return nil, err
		}
	}
	verify, err := knownhosts.New(path)
	if err != nil {
		return nil, err
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := verify(hostname, remote, key)
		if err == nil {
			return nil
		}
		var keyErr *knownhosts.KeyError
		if !errors.As(err, &keyErr) {
			return err
		}
		norm := knownhosts.Normalize(hostname)
		if len(keyErr.Want) > 0 {
			// Stale key (device reinstalled) — remove old line(s) for this host,
			// then fall through to append the new key below.
			if rerr := removeKnownHostsEntry(path, norm); rerr != nil {
				return fmt.Errorf("could not update known_hosts for %s: %w", hostname, rerr)
			}
			progress(fmt.Sprintf("Host %s key changed (device reinstalled?) — updating stored key.", hostname))
		}
		// First-use or just-cleared entry → trust and persist the new key.
		line := knownhosts.Line([]string{norm}, key)
		f, oerr := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
		if oerr != nil {
			return oerr
		}
		defer f.Close()
		if _, werr := f.WriteString(line + "\n"); werr != nil {
			return werr
		}
		if len(keyErr.Want) == 0 {
			progress(fmt.Sprintf("New host %s — trusting its key (%s) on first use.", hostname, key.Type()))
		}
		return nil
	}, nil
}

// removeKnownHostsEntry removes all lines that match the given normalized
// hostname from the known_hosts file (rewrites in place).
func removeKnownHostsEntry(path, norm string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var kept []byte
	for _, raw := range bytes.Split(data, []byte("\n")) {
		line := string(raw)
		// A known_hosts line starts with the hostname (possibly hashed or
		// comma-separated). Skip any line whose first field contains our host.
		fields := strings.Fields(line)
		if len(fields) >= 3 {
			for _, h := range strings.Split(fields[0], ",") {
				if strings.EqualFold(h, norm) {
					goto skip
				}
			}
		}
		kept = append(kept, raw...)
		kept = append(kept, '\n')
	skip:
	}
	return os.WriteFile(path, bytes.TrimRight(kept, "\n"), 0o600)
}

// httpStatusOK GETs a URL and returns nil only on a 2xx response.
func httpStatusOK(url string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
