// Package hotswaplib implements the disk-truth generation-discovery and
// confirmed-success-before-delete protocol shared by the local-simulation
// loader-host supervisor (host-agent) and the field/remote loader-host
// supervisor (server) — both wrap the SAME hotswaphost/host.c binary, so the
// bookkeeping around it (which generation is current, when it's safe to
// delete an old one) must behave identically in both places.
//
// Generation files are named logic_<N>.so. The generation number is NEVER
// trusted from an in-memory counter across a process restart — it is always
// re-derived by scanning the directory, which is what makes this package the
// single fix for the "in-memory counter desynced from what's actually on disk"
// class of bug (the root cause of the field-path's logic_0.so vs logic_1.so
// mismatch this package replaces).
//
// SUSTAINABLE NAMING — 2-slot ping-pong. Hot reload uses exactly TWO on-disk
// slots that alternate: logic_0.so <-> logic_1.so. Each swap compiles/uploads
// into the slot that is NOT the currently-running one (PingPongGeneration),
// dlopen's it, and — only after the loader-host CONFIRMS it is running — deletes
// the other slot (CleanupExcept). This means the generation number never grows
// unboundedly (the old "highest+1" scheme produced logic_0, logic_1, ...,
// logic_57 forever, and on a long-lived field device it never reset), while
// PlcState is still preserved (the loader-host re-binds the same arena
// regardless of the filename). At most two files ever exist.
//
// ⚠️ Because a slot filename is REUSED, whoever writes a slot MUST do so
// atomically (write a temp file, then rename over the slot) so a currently
// mmap'd .so is never truncated in place — rename swaps the directory entry to
// a fresh inode while the old inode stays mapped by the running loader-host.
// TempGenerationPath gives the conventional temp name for that pattern; the
// server's saveUpload already renames atomically.
package hotswaplib

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrTimeout is returned by PollSwapResult when no result appears within the
// given timeout. Callers MUST treat this as "outcome unknown" — never assume
// success or failure, and never delete either the old or the candidate new
// generation file on this outcome.
var ErrTimeout = errors.New("hotswaplib: timed out waiting for swap result")

var logicNameRe = regexp.MustCompile(`^logic_(\d+)\.so$`)

// GenerationPath returns the canonical filename for a given generation,
// joined under dir.
func GenerationPath(dir string, gen int) string {
	return filepath.Join(dir, fmt.Sprintf("logic_%d.so", gen))
}

// TempGenerationPath returns the conventional temp filename to compile/write a
// slot into before renaming it over GenerationPath(dir, gen). Because slot
// names are REUSED in the ping-pong scheme, writing a slot in place could
// truncate a .so the running loader-host still has mmap'd; writing here first
// and then os.Rename onto the real path gives the slot a fresh inode while the
// old inode stays mapped. It matches logicNameRe's "logic_<N>.so" prefix but
// with a .tmp suffix so DiscoverGeneration never mistakes it for a real slot.
func TempGenerationPath(dir string, gen int) string {
	return filepath.Join(dir, fmt.Sprintf("logic_%d.so.tmp", gen))
}

// PingPongGeneration returns the slot to use for the NEXT logic build/upload
// given the CONFIRMED currently-running generation `cur`: the OTHER of the two
// fixed slots {0, 1}. Callers MUST pass the generation they are CERTAIN is
// running (the one they launched at cold start, or the one a swap was last
// CONFIRMED "OK" for) — never a value guessed from a directory listing, which
// is ambiguous while two slots briefly coexist. This is what guarantees we are
// always sure which slot is running and which slot we are about to send.
//
// Any even `cur` maps to slot 1 and any odd `cur` to slot 0, so a legacy value
// left over from the old monotonic scheme still resolves to a valid {0,1} slot
// on the first swap after upgrade.
func PingPongGeneration(cur int) int {
	if cur%2 == 0 {
		return 1
	}
	return 0
}

// ParseGenFromName extracts N from a "logic_<N>.so" basename (a full path
// works too — only the basename is matched). ok=false if it doesn't match.
func ParseGenFromName(name string) (gen int, ok bool) {
	m := logicNameRe.FindStringSubmatch(filepath.Base(name))
	if m == nil {
		return 0, false
	}
	v, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return v, true
}

// DiscoverGeneration scans dir for logic_<N>.so files and returns the highest
// N found, its full path, and ok=true. ok=false means no logic_*.so exists in
// dir yet (a fresh build/deploy dir). Malformed filenames are ignored rather
// than causing an error — a stray file should never crash discovery.
func DiscoverGeneration(dir string) (gen int, path string, ok bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, "", false
	}
	best := -1
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := logicNameRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		v, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		if v > best {
			best = v
		}
	}
	if best < 0 {
		return 0, "", false
	}
	return best, GenerationPath(dir, best), true
}

// NextGeneration returns one past whatever is currently on disk.
//
// Deprecated: this "highest + 1" scheme makes the generation number grow
// without bound (logic_0, logic_1, ..., logic_57) and, on a long-lived field
// device, it never resets. Hot reload now uses the bounded 2-slot ping-pong
// (PingPongGeneration off the CONFIRMED-running generation). Kept only so an
// older build/deploy dir can still be read; do not use it for new swaps.
func NextGeneration(dir string) int {
	if gen, _, ok := DiscoverGeneration(dir); ok {
		return gen + 1
	}
	return 0
}

// CleanupExcept deletes every logic_*.so in dir except the one matching
// keepGen. Call this ONLY after a swap/cold-start has been CONFIRMED running
// that generation (via PollSwapResult) — never optimistically right after a
// compile, since the compile succeeding says nothing about whether the
// loader-host actually adopted it.
func CleanupExcept(dir string, keepGen int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var firstErr error
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := logicNameRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		v, err := strconv.Atoi(m[1])
		if err != nil || v == keepGen {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// ClearResultFile removes any stale swap_result before a new swap/run is
// requested, so a leftover result from a PREVIOUS attempt can never be
// misread as the outcome of the one about to be requested. Missing file is
// not an error.
func ClearResultFile(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// PollSwapResult polls path (the plain-text "<STATUS> <gen> [<detail>]" file
// written by hotswaphost/host.c's write_swap_result) until it reports an
// outcome for expectGen, or timeout elapses.
//
// Returns:
//   - status="OK", detail="" or a coldstart/extra token, err=nil   → confirmed running expectGen
//   - status="FAIL", detail=<reason>, err=nil                      → expectGen was rejected; the
//     PREVIOUS generation is still running (the loader-host rolls back itself)
//   - err=ErrTimeout                                               → outcome unknown; do not
//     delete anything, the running generation may be expectGen, the previous one, or unclear
//
// A result line naming a DIFFERENT generation than expectGen is ignored and
// polling continues (it can only be a stale leftover ClearResultFile failed
// to remove, or — defensively — a race with another in-flight swap; either
// way it must never be mistaken for this swap's outcome).
func PollSwapResult(path string, expectGen int, timeout time.Duration) (status, detail string, err error) {
	deadline := time.Now().Add(timeout)
	for {
		if st, gen, det, ok := readSwapResult(path); ok && gen == expectGen {
			return st, det, nil
		}
		if time.Now().After(deadline) {
			return "", "", ErrTimeout
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func readSwapResult(path string) (status string, gen int, detail string, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, "", false
	}
	line := strings.TrimSpace(string(data))
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", 0, "", false
	}
	g, err := strconv.Atoi(fields[1])
	if err != nil {
		return "", 0, "", false
	}
	d := ""
	if len(fields) > 2 {
		d = strings.Join(fields[2:], " ")
	}
	return fields[0], g, d, true
}
