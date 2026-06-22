// process.go - PLC Runtime Process Management
//
// Responsibilities:
//   - Start the newly deployed runtime.bin in the background
//   - Stop the running process with SIGTERM; send SIGKILL if it does not exit in time
//   - Track PID and log unexpected process termination
//   - When AutoRun is enabled, automatically restart the runtime on crash
//     using exponential backoff (1s → 2s → 5s → 10s → 30s, reset after 60s stable)
//   - Guard all operations with mutexes for concurrency safety

package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/krontek/hotswaplib"
)

const (
	// Time to wait for graceful exit after sending SIGTERM.
	gracefulStopTimeout = 5 * time.Second

	// If the runtime stays alive for at least this long after Start(),
	// the crash-restart backoff resets to its initial value.
	backoffResetThreshold = 60 * time.Second
)

// restartBackoffDelays is the exponential backoff schedule for crash-restart.
// On consecutive crashes the delay walks down this list and stays at the
// last entry. A stable run (>backoffResetThreshold) resets to index 0.
var restartBackoffDelays = []time.Duration{
	1 * time.Second,
	2 * time.Second,
	5 * time.Second,
	10 * time.Second,
	30 * time.Second,
}

// RuntimeEvent records the outcome of the last swap/cold-start/crash, so the
// existing /status poll (the editor's only channel back from the field side
// for this kind of event — there is no persistent SSE connection here) can
// surface it without a new streaming mechanism.
type RuntimeEvent struct {
	Kind   string    `json:"kind"`   // "swap" | "coldstart" | "crashed"
	Status string    `json:"status"` // "OK" | "FAIL" | "unknown"
	Detail string    `json:"detail,omitempty"`
	At     time.Time `json:"at"`
}

// ProcessManager controls the lifecycle of the PLC runtime binary.
type ProcessManager struct {
	mu sync.Mutex
	// swapMu is DELIBERATELY separate from mu: SwapLogic holds it for the
	// entire compile-free swap operation (write request → signal → poll for
	// confirmation, up to swapResultTimeout) so two concurrent swap requests
	// can never interleave — but an operator's Stop() only ever needs mu,
	// briefly, so it is never blocked behind a hung swap poll.
	swapMu     sync.Mutex
	deployDir  string
	cmd        *exec.Cmd
	done       chan struct{} // Closed when the process exits
	stdoutFile *os.File
	stderrFile *os.File
	lastEvent  *RuntimeEvent // guarded by mu; last swap/coldstart/crash outcome

	// AutoRun crash-restart state. All fields below are guarded by mu.
	intentionalStop    bool        // set by Stop() so watchProcess won't auto-restart
	autoRunGetter      func() bool // queried after a crash to decide whether to respawn
	restartTimer       *time.Timer // pending auto-restart, nil if none scheduled
	lastStartedAt      time.Time   // for backoff reset logic
	consecutiveCrashes int         // current index into restartBackoffDelays
}

// swapResultTimeout bounds how long SwapLogic/Start wait for the loader-host
// to report a swap/cold-start outcome. Mirrors host-agent/hotswap.go's
// identical constant — both wrap the same loader-host binary.
const swapResultTimeout = 5 * time.Second

// LastEvent returns the last recorded swap/cold-start/crash outcome, or nil
// if none has happened yet this agent run. Thread-safe.
func (pm *ProcessManager) LastEvent() *RuntimeEvent {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	return pm.lastEvent
}

func (pm *ProcessManager) recordEvent(kind, status, detail string) {
	pm.mu.Lock()
	pm.lastEvent = &RuntimeEvent{Kind: kind, Status: status, Detail: detail, At: time.Now()}
	pm.mu.Unlock()
}

func NewProcessManager(deployDir string) *ProcessManager {
	return &ProcessManager{deployDir: deployDir}
}

// SetAutoRunGetter wires up the callback used by the crash-restart watchdog
// to decide whether AutoRun is currently enabled. The getter is read each
// time the runtime exits unexpectedly and again right before the restart
// timer fires, so toggling AutoRun off via UpdateRuntimeConfig is honored
// even while a restart is pending.
func (pm *ProcessManager) SetAutoRunGetter(f func() bool) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.autoRunGetter = f
}

// CancelPendingRestart stops any pending auto-restart timer.
// Called by the server when AutoRun is toggled off while the runtime is
// down but a respawn is scheduled. Running processes are untouched.
func (pm *ProcessManager) CancelPendingRestart() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.cancelRestartLocked()
}

// pidFilePath returns the location of the runtime PID file.
// This is a recovery hint, not the source of truth — used at agent
// startup to detect runtimes left behind by a previous agent crash.
func (pm *ProcessManager) pidFilePath() string {
	return filepath.Join(pm.deployDir, "plc-runtime.pid")
}

// writePIDFile records the current runtime PID. Failures are logged
// but non-fatal: the file is best-effort orphan detection.
func (pm *ProcessManager) writePIDFile(pid int) {
	if err := os.WriteFile(pm.pidFilePath(), []byte(strconv.Itoa(pid)), 0644); err != nil {
		slog.Warn("Failed to write runtime PID file", "err", err)
	}
}

// removePIDFile clears the PID file. Safe when no file is present.
func (pm *ProcessManager) removePIDFile() {
	_ = os.Remove(pm.pidFilePath())
}

// CleanupOrphanRuntime terminates any runtime process left behind by a
// previous agent crash. Identifies orphans via the PID file and confirms
// /proc/<pid>/exe still points to our runtime binary (defends against
// PID recycling). Brief PLC interruption is the cost; the upside is a
// single supervised runtime with intact logs after every agent restart.
//
// Must be called BEFORE the first pm.Start() at agent startup. Safe to
// call when no orphan exists.
func (pm *ProcessManager) CleanupOrphanRuntime() {
	pidPath := pm.pidFilePath()
	data, err := os.ReadFile(pidPath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("Failed to read runtime PID file", "err", err)
		}
		return
	}
	pidStr := strings.TrimSpace(string(data))
	pid, err := strconv.Atoi(pidStr)
	if err != nil || pid <= 0 {
		slog.Warn("Runtime PID file contains invalid PID", "value", pidStr)
		pm.removePIDFile()
		return
	}

	if !pm.processIsOurRuntime(pid) {
		slog.Info("Runtime PID file stale — process gone or recycled", "pid", pid)
		pm.removePIDFile()
		return
	}

	slog.Warn("Orphan PLC runtime detected — terminating before start", "pid", pid)
	pm.terminateOrphan(pid)
	pm.removePIDFile()
}

// processIsOurRuntime reports whether the given PID is alive AND its
// /proc/<pid>/exe symlink resolves to <deploy-dir>/runtime.bin. False on
// any error (process gone, permission denied, mismatched binary).
func (pm *ProcessManager) processIsOurRuntime(pid int) bool {
	expected := filepath.Join(pm.deployDir, "runtime.bin")
	actual, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return false
	}
	// Kernel suffixes the symlink with " (deleted)" if the binary file
	// was removed since spawn (common during redeploy). Strip and compare.
	actual = strings.TrimSuffix(actual, " (deleted)")
	return actual == expected
}

// terminateOrphan sends SIGTERM, waits up to gracefulStopTimeout, then
// SIGKILL if still alive. When the agent runs as non-root the orphan is
// root-owned (sudo-spawned originally), so we route signals through
// `sudo -n kill` — same path used to launch the runtime.
func (pm *ProcessManager) terminateOrphan(pid int) {
	send := func(sig syscall.Signal) error {
		if os.Getuid() == 0 {
			return syscall.Kill(pid, sig)
		}
		sigArg := "-TERM"
		if sig == syscall.SIGKILL {
			sigArg = "-KILL"
		}
		return exec.Command("sudo", "-n", "kill", sigArg, strconv.Itoa(pid)).Run()
	}

	if err := send(syscall.SIGTERM); err != nil {
		slog.Warn("Orphan SIGTERM failed", "pid", pid, "err", err)
	} else {
		deadline := time.Now().Add(gracefulStopTimeout)
		for time.Now().Before(deadline) {
			if !pm.processIsOurRuntime(pid) {
				slog.Info("Orphan exited after SIGTERM", "pid", pid)
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		slog.Warn("Orphan still alive after SIGTERM — sending SIGKILL", "pid", pid)
	}

	if err := send(syscall.SIGKILL); err != nil {
		slog.Error("Orphan SIGKILL failed", "pid", pid, "err", err)
		return
	}
	time.Sleep(200 * time.Millisecond) // brief grace for kernel cleanup
}

// Start launches /opt/plc/runtime.bin.
// If a process is already running, it stops it first.
// Any pending auto-restart timer is canceled (a manual Start supersedes it).
func (pm *ProcessManager) Start() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	// A manual start always supersedes a pending auto-restart.
	pm.cancelRestartLocked()

	// Stop the previous process safely if it is still running.
	if pm.isRunning() {
		slog.Info("Stopping current runtime (redeploy)")
		if err := pm.stopLocked(); err != nil {
			return fmt.Errorf("failed to stop previous process: %w", err)
		}
	}

	binPath := filepath.Join(pm.deployDir, "runtime.bin")
	if _, err := os.Stat(binPath); errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("runtime binary not found: %s", binPath)
	}

	// Redirect PLC outputs to log files for persistent records and debugging.
	logDir := filepath.Join(pm.deployDir, "logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return fmt.Errorf("failed to create log directory: %w", err)
	}
	timestamp := time.Now().Format("20060102_150405")
	stdoutPath := filepath.Join(logDir, "runtime_"+timestamp+"_stdout.log")
	stderrPath := filepath.Join(logDir, "runtime_"+timestamp+"_stderr.log")

	stdoutF, err := os.Create(stdoutPath)
	if err != nil {
		return fmt.Errorf("failed to create stdout log file: %w", err)
	}
	stderrF, err := os.Create(stderrPath)
	if err != nil {
		stdoutF.Close()
		return fmt.Errorf("failed to create stderr log file: %w", err)
	}

	// Hot-swap (online change) mode: if ANY logic_<n>.so is present, runtime.bin
	// is the loader-host and takes the highest-generation logic .so as its
	// argument. Otherwise it is a classic self-contained binary. Discovered
	// from disk (never a hardcoded "logic_0.so" literal, and never an
	// in-memory counter) — this is what makes the switch correct after an
	// agent restart or when generation 0 has since been cleaned up.
	hotSwapGen, logicPath, hotSwap := hotswaplib.DiscoverGeneration(pm.deployDir)

	// SOEM requires CAP_NET_RAW (raw socket access for EtherCAT).
	// If this process is already root (uid=0), spawn directly.
	// Otherwise wrap with "sudo -n" — requires a passwordless sudoers entry:
	//   plc ALL=(root) NOPASSWD: /opt/plc/runtime.bin
	var cmd *exec.Cmd
	var binArgs []string
	if hotSwap {
		binArgs = []string{logicPath}
		// Clear any stale result from a previous run BEFORE spawning, so a
		// leftover file can never be misread as THIS run's cold-start outcome.
		_ = hotswaplib.ClearResultFile(filepath.Join(pm.deployDir, "swap_result"))
	}
	if os.Getuid() == 0 {
		cmd = exec.Command(binPath, binArgs...)
	} else {
		slog.Warn("plc-agent not running as root; using sudo -n for runtime (ensure NOPASSWD sudoers entry)")
		cmd = exec.Command("sudo", append([]string{"-n", binPath}, binArgs...)...)
	}
	cmd.Dir = pm.deployDir
	cmd.Stdout = stdoutF
	cmd.Stderr = stderrF
	// Put the process in a new process group so it is not affected when the agent exits.
	// This behavior is intentional: PLC runtime should continue autonomously once started.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		stdoutF.Close()
		stderrF.Close()
		return fmt.Errorf("failed to start runtime: %w", err)
	}

	pm.cmd = cmd
	pm.stdoutFile = stdoutF
	pm.stderrFile = stderrF
	pm.done = make(chan struct{})
	pm.lastStartedAt = time.Now()
	pm.writePIDFile(cmd.Process.Pid)

	// Process watcher goroutine catches unexpected exits.
	go pm.watchProcess(cmd, pm.done)

	slog.Info("PLC Runtime started",
		"pid", cmd.Process.Pid,
		"binary", binPath,
		"stdout_log", stdoutPath,
		"stderr_log", stderrPath,
	)

	if hotSwap {
		// Confirm the loader-host actually bound its first logic module
		// before returning — a fresh start that can't even bind logic_<gen>
		// (e.g. a stale/mismatched upload) exits almost immediately; without
		// this poll that would look identical to a normal successful start
		// until the NEXT /status check. Informational only: a timeout here
		// does not fail Start() (the process did spawn), just records the
		// outcome for /status to surface.
		resultPath := filepath.Join(pm.deployDir, "swap_result")
		status, detail, perr := hotswaplib.PollSwapResult(resultPath, hotSwapGen, swapResultTimeout)
		if perr != nil {
			slog.Warn("hot-swap cold-start outcome unknown", "gen", hotSwapGen)
			pm.lastEvent = &RuntimeEvent{Kind: "coldstart", Status: "unknown", At: time.Now()}
		} else {
			if status != "OK" {
				slog.Error("hot-swap cold-start failed", "gen", hotSwapGen, "reason", detail)
			}
			pm.lastEvent = &RuntimeEvent{Kind: "coldstart", Status: status, Detail: detail, At: time.Now()}
		}
	}
	return nil
}

// SwapLogic pushes an ONLINE CHANGE to the running loader-host: it writes the
// new logic .so path to deploy-dir/swap_request and sends SIGUSR1 so the host
// swaps it at the next scan boundary, preserving PlcState (it rolls back a bad
// .so itself) — then BLOCKS until the loader-host's swap_result file confirms
// the outcome, and only then cleans up (the confirmed-running generation's
// siblings on success, or just the rejected candidate on failure — never the
// still-running old one). Only valid when the runtime was started in
// hot-swap mode.
//
// Returns (status, detail, nil) for a definite outcome ("OK"/"" or
// "FAIL"/<reason>), or ("", "", err) when the runtime isn't running, the file
// is missing, signaling failed, or the outcome timed out (err is then
// hotswaplib.ErrTimeout — the caller must treat this as UNKNOWN, never as
// success or failure, and must not delete anything).
//
// Uses pm.swapMu (NOT pm.mu) for the poll, so a hung swap can never block an
// operator's Stop() — see the swapMu field comment.
//
// NOTE: when the agent runs the runtime via "sudo -n", the tracked process is
// sudo, which does not forward SIGUSR1 — for field hot-swap the agent should
// run as root (or be granted the runtime via setcap), so the signal reaches the
// loader-host directly.
func (pm *ProcessManager) SwapLogic(logicFile string) (status, detail string, err error) {
	pm.swapMu.Lock()
	defer pm.swapMu.Unlock()

	pm.mu.Lock()
	if !pm.isRunning() || pm.cmd == nil || pm.cmd.Process == nil {
		pm.mu.Unlock()
		return "", "", fmt.Errorf("runtime is not running")
	}
	proc := pm.cmd.Process
	pm.mu.Unlock()

	abs := filepath.Join(pm.deployDir, logicFile)
	if _, statErr := os.Stat(abs); statErr != nil {
		return "", "", fmt.Errorf("logic not found: %s", abs)
	}
	gen, ok := hotswaplib.ParseGenFromName(logicFile)
	if !ok {
		return "", "", fmt.Errorf("unrecognized logic filename: %s", logicFile)
	}

	resultPath := filepath.Join(pm.deployDir, "swap_result")
	// Clear any stale result BEFORE requesting this swap, so a leftover
	// outcome from a PREVIOUS attempt can never be misattributed to this one.
	_ = hotswaplib.ClearResultFile(resultPath)

	reqPath := filepath.Join(pm.deployDir, "swap_request")
	if writeErr := os.WriteFile(reqPath, []byte(abs+"\n"), 0644); writeErr != nil {
		return "", "", fmt.Errorf("write swap_request: %w", writeErr)
	}
	if sigErr := proc.Signal(syscall.SIGUSR1); sigErr != nil {
		return "", "", fmt.Errorf("signal SIGUSR1: %w", sigErr)
	}
	slog.Info("Hot-swap signaled", "logic", logicFile, "generation", gen)

	st, det, pollErr := hotswaplib.PollSwapResult(resultPath, gen, swapResultTimeout)
	if pollErr != nil {
		pm.recordEvent("swap", "unknown", "")
		slog.Warn("hot-swap outcome unknown (timeout)", "generation", gen)
		return "", "", pollErr
	}
	pm.recordEvent("swap", st, det)
	if st == "OK" {
		_ = hotswaplib.CleanupExcept(pm.deployDir, gen)
		slog.Info("Hot-swap confirmed", "generation", gen)
	} else {
		_ = os.Remove(abs) // only the rejected candidate; the previous generation is still running
		slog.Error("Hot-swap rejected by loader-host", "generation", gen, "reason", det)
	}
	return st, det, nil
}

// Stop terminates the running PLC runtime safely.
// Also cancels any pending auto-restart and disables the next watchdog
// respawn so the runtime stays down until an explicit Start.
func (pm *ProcessManager) Stop() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	// User intent: keep it down. Affects both the in-flight watchProcess
	// decision and any timer that hasn't fired yet.
	pm.cancelRestartLocked()
	pm.consecutiveCrashes = 0
	pm.intentionalStop = true
	if !pm.isRunning() {
		slog.Debug("No active PLC process to stop")
		return nil
	}
	return pm.stopLocked()
}

// Status returns current PID and running state. Thread-safe.
func (pm *ProcessManager) Status() (pid int, running bool) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if !pm.isRunning() {
		return 0, false
	}
	return pm.cmd.Process.Pid, true
}

// Internal helpers (must be called with mutex held)

// isRunning checks whether the process is alive.
// Note: pm.mu must be held by caller.
func (pm *ProcessManager) isRunning() bool {
	if pm.cmd == nil || pm.cmd.Process == nil {
		return false
	}
	// If done channel is closed, process has exited.
	select {
	case <-pm.done:
		return false
	default:
		return true
	}
}

// stopLocked terminates process with SIGTERM -> wait -> SIGKILL cycle.
// Note: pm.mu must be held by caller.
func (pm *ProcessManager) stopLocked() error {
	pid := pm.cmd.Process.Pid

	// Step 1: SIGTERM - give process a chance to exit cleanly.
	slog.Info("Sending SIGTERM", "pid", pid)
	if err := pm.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		// Process may already be dead; do not treat that as an error.
		if !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("failed to send SIGTERM: %w", err)
		}
	}

	// Step 2: Wait for graceful shutdown timeout.
	select {
	case <-pm.done:
		slog.Info("PLC process exited after SIGTERM", "pid", pid)
	case <-time.After(gracefulStopTimeout):
		// Step 3: Timeout exceeded -> force SIGKILL.
		slog.Warn("Graceful stop timeout, sending SIGKILL", "pid", pid)
		if err := pm.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("failed to send SIGKILL: %w", err)
		}
		<-pm.done // Also wait for completion after kill.
	}

	pm.closeLogFiles()
	pm.cmd = nil
	pm.done = nil
	pm.removePIDFile()
	return nil
}

// watchProcess waits for cmd.Wait() and closes done when finished.
// On unexpected exit, if AutoRun is enabled and the stop was not requested
// by the user, schedules a restart with exponential backoff.
func (pm *ProcessManager) watchProcess(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()

	// Close done BEFORE acquiring the mutex.
	// stopLocked() holds pm.mu while blocking on <-done, so closing done
	// first prevents a deadlock between watchProcess and stopLocked.
	select {
	case <-done:
		// Already closed; avoid double-close.
	default:
		close(done)
	}

	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Only clean up if this goroutine's cmd is still the active one.
	// stopLocked() or a subsequent Start() may have already replaced pm.cmd.
	if pm.cmd != cmd {
		return
	}

	if err != nil {
		// Use warning level for expected process exit errors.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			slog.Warn("PLC Runtime exited unexpectedly",
				"pid", cmd.Process.Pid,
				"exit_code", exitErr.ExitCode(),
			)
			if !pm.intentionalStop {
				// pm.mu is already held by this function — direct field
				// write, NOT recordEvent() (which would self-deadlock).
				pm.lastEvent = &RuntimeEvent{Kind: "crashed", Status: "unknown", Detail: fmt.Sprintf("exit code %d", exitErr.ExitCode()), At: time.Now()}
			}
		} else {
			slog.Error("PLC Runtime wait error", "err", err)
		}
	} else {
		slog.Info("PLC Runtime exited normally", "pid", cmd.Process.Pid)
	}

	pm.closeLogFiles()
	pm.cmd = nil
	pm.done = nil
	pm.removePIDFile()

	// Auto-restart decision.
	// - intentionalStop=true → user requested Stop; consume the flag and stay down.
	// - else if AutoRun is on → schedule a respawn with backoff.
	// - else → leave the runtime down for the user to start manually.
	if pm.intentionalStop {
		pm.intentionalStop = false
		return
	}
	if pm.autoRunGetter != nil && pm.autoRunGetter() {
		pm.scheduleRestartLocked()
	}
}

// scheduleRestartLocked arms a one-shot timer to restart the runtime after
// a backoff delay. The timer callback re-checks AutoRun before starting so
// that a toggle-off during the wait is honored. Caller must hold pm.mu.
func (pm *ProcessManager) scheduleRestartLocked() {
	// Reset backoff if the previous run stayed alive long enough.
	if !pm.lastStartedAt.IsZero() && time.Since(pm.lastStartedAt) >= backoffResetThreshold {
		pm.consecutiveCrashes = 0
	}

	idx := pm.consecutiveCrashes
	if idx >= len(restartBackoffDelays) {
		idx = len(restartBackoffDelays) - 1
	}
	delay := restartBackoffDelays[idx]
	pm.consecutiveCrashes++

	slog.Warn("AutoRun: scheduling PLC runtime restart",
		"delay", delay,
		"consecutive_crashes", pm.consecutiveCrashes,
	)

	pm.restartTimer = time.AfterFunc(delay, func() {
		pm.mu.Lock()
		pm.restartTimer = nil
		autoRun := pm.autoRunGetter != nil && pm.autoRunGetter()
		pm.mu.Unlock()

		if !autoRun {
			slog.Info("AutoRun: restart canceled (AutoRun is now off)")
			return
		}
		if err := pm.Start(); err != nil {
			slog.Error("AutoRun: restart attempt failed", "err", err)
			// Schedule another retry — the cycle continues until AutoRun
			// is toggled off, the user calls Stop, or Start finally succeeds.
			pm.mu.Lock()
			retry := pm.autoRunGetter != nil && pm.autoRunGetter()
			if retry {
				pm.scheduleRestartLocked()
			}
			pm.mu.Unlock()
		}
	})
}

// cancelRestartLocked stops a pending restart timer if one is armed.
// Idempotent: safe to call when no timer is pending. Caller must hold pm.mu.
func (pm *ProcessManager) cancelRestartLocked() {
	if pm.restartTimer != nil {
		pm.restartTimer.Stop()
		pm.restartTimer = nil
	}
}

func (pm *ProcessManager) closeLogFiles() {
	if pm.stdoutFile != nil {
		pm.stdoutFile.Close()
		pm.stdoutFile = nil
	}
	if pm.stderrFile != nil {
		pm.stderrFile.Close()
		pm.stderrFile = nil
	}
}
