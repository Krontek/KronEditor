package main

// Capturing what a spawned runtime says.
//
// The loader-host and the code generated into it are not silent: host.c reports
// its cold start, refused real-time scheduling and every swap, and the EtherCAT
// master prints a precise reason whenever the bus does not come up
// ("[kronec] No EtherCAT slaves found on %s", "Could not reach OP state",
// "PO2SO SDO failed: slave %d 0x%04X:%02X", a PDO size mismatch). None of it
// reached anyone, because os/exec sends a nil Stdout to /dev/null.
//
// ⚠️ This is a DIAGNOSTIC channel, not a logging API for PLC programs — see
// src/services/CLAUDE.md: a program still publishes values through SHM, never printf.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// runtimeLogMaxLines caps what one run may push into the editor. The file keeps
// everything; only the UI stream is bounded, so a runaway printf in a library
// cannot wedge the editor.
const runtimeLogMaxLines = 500

// repeatWindow is how long an identical line is folded into a repeat counter
// instead of being sent again. The bus watchdog alone can emit the same
// "not OP / recovery failed" pair for as long as a drive stays unreachable, and
// a hundred identical entries say nothing the first one did not.
const repeatWindow = 10 * time.Second

type runtimeLogWriter struct {
	mu      sync.Mutex
	file    *os.File
	buf     []byte
	emitted int
	events  *Events

	lastLine string
	lastAt   time.Time
	repeats  int
}

// newRuntimeLogWriter truncates <buildDir>/runtime.log for this run and returns
// a writer that tees to it and to the editor.
func (s *Server) newRuntimeLogWriter(buildDir string) *runtimeLogWriter {
	w := &runtimeLogWriter{events: s.events}
	// A failed open is not fatal: the SSE half still works, and a run must never
	// be blocked by its own logging.
	if f, err := os.Create(filepath.Join(buildDir, "runtime.log")); err == nil {
		w.file = f
	}
	return w
}

// runtimeLogLevel classifies a runtime line so the editor can route it.
//
// ⚠️ Routine chatter must NOT land in the Messages tab. A bus that cannot come
// up narrates itself indefinitely, and mixing that into the same list as
// "project loaded" and "build successful" buried every message the user
// actually needed. Trouble goes to Warnings/Errors, the few lines that report
// progress stay informational, and everything else lives in runtime.log only.
func runtimeLogLevel(line string) string {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "double free"), strings.Contains(l, "segmentation"),
		strings.Contains(l, "could not"), strings.Contains(l, "cannot"),
		strings.Contains(l, "failed"), strings.Contains(l, "error"),
		// "No EtherCAT slaves found on enp7s0" matched nothing and was hidden —
		// the single most important line a bus-less run can produce.
		strings.Contains(l, "no ethercat slaves"), strings.Contains(l, "not found"),
		strings.Contains(l, "abort"):
		return "error"
	case strings.Contains(l, "not op"), strings.Contains(l, "recovering"),
		strings.Contains(l, "refused"), strings.Contains(l, "backing off"),
		strings.Contains(l, "unavailable"), strings.Contains(l, "jitter"),
		strings.Contains(l, "without dc"):
		return "warning"
	// The handful of lines worth seeing in Messages: the bus came up, the host
	// started, a swap happened.
	case strings.Contains(l, "bus running"), strings.Contains(l, "[host] started"),
		strings.Contains(l, "hot-swapped"), strings.Contains(l, "back in op"),
		strings.Contains(l, "slave(s)"), strings.Contains(l, "sync0 armed"):
		return "info"
	}
	return "" // file only
}

func (w *runtimeLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file != nil {
		_, _ = w.file.Write(p)
	}
	// Split on newlines so the editor gets whole lines; a partial tail waits for
	// the rest rather than arriving as its own entry.
	w.buf = append(w.buf, p...)
	for {
		i := strings.IndexByte(string(w.buf), '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(w.buf[:i]), "\r")
		w.buf = w.buf[i+1:]
		if line == "" || w.events == nil {
			continue
		}
		level := runtimeLogLevel(line)
		if level == "" {
			continue // diagnostics that belong in the file, not in front of the user
		}
		now := time.Now()
		if line == w.lastLine && now.Sub(w.lastAt) < repeatWindow {
			w.repeats++
			continue
		}
		if w.repeats > 0 {
			w.events.Emit("runtime-log", map[string]any{
				"level": level,
				"line":  fmt.Sprintf("(previous line repeated %d more time(s))", w.repeats),
			})
			w.repeats = 0
		}
		w.lastLine, w.lastAt = line, now
		if w.emitted < runtimeLogMaxLines {
			w.events.Emit("runtime-log", map[string]any{"level": level, "line": line})
			w.emitted++
			if w.emitted == runtimeLogMaxLines {
				w.events.Emit("runtime-log", map[string]any{
					"level": "warning",
					"line":  "(further runtime output only in runtime.log)",
				})
			}
		}
	}
	return len(p), nil
}

func (w *runtimeLogWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file != nil {
		return w.file.Close()
	}
	return nil
}
