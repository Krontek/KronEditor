package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// buildRequest is the JSON payload accepted by POST /api/host/build.
//
// Sources is a map of filename → file content. Filenames must be simple
// basenames (no path separators) so the agent decides the on-disk location.
//
// Output is the name of the binary to produce. Defaults to "runtime.bin".
//
// CompilerArgs are passed verbatim to gcc, appended after the source files.
// Frontend controls -I, -l, -O, etc. — this keeps the agent generic during
// PoC. The cross-compile + sysroot logic will move server-side in a later
// stage.
type buildRequest struct {
	Sources      map[string]string `json:"sources"`
	Output       string            `json:"output"`
	CompilerArgs []string          `json:"compilerArgs"`
	Compiler     string            `json:"compiler"`
}

type buildResponse struct {
	OK         bool   `json:"ok"`
	BinaryPath string `json:"binaryPath,omitempty"`
	BuildDir   string `json:"buildDir,omitempty"`
	Log        string `json:"log"`
	Error      string `json:"error,omitempty"`
}

func handleBuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}

	var req buildRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if len(req.Sources) == 0 {
		writeError(w, http.StatusBadRequest, "sources is empty")
		return
	}
	if req.Output == "" {
		req.Output = "runtime.bin"
	}
	if req.Compiler == "" {
		req.Compiler = "gcc"
	}
	// Hardening: the compiler name is exec'd — restrict it to a small allowlist
	// of bare names (resolved via PATH), never a caller-supplied path.
	if strings.ContainsAny(req.Compiler, "/\\") || !allowedCompilers[req.Compiler] {
		writeError(w, http.StatusBadRequest, "compiler not allowed: "+req.Compiler)
		return
	}
	// Hardening: the output name must stay inside the build dir.
	if strings.Contains(req.Output, "..") || strings.ContainsAny(req.Output, "/\\") {
		writeError(w, http.StatusBadRequest, "output must be a plain filename: "+req.Output)
		return
	}

	buildDir, err := makeBuildDir()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create build dir: "+err.Error())
		return
	}

	var sourceFiles []string
	for name, content := range req.Sources {
		if strings.ContainsAny(name, "/\\") {
			writeError(w, http.StatusBadRequest, "source filename must not contain path separators: "+name)
			return
		}
		full := filepath.Join(buildDir, name)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			writeError(w, http.StatusInternalServerError, "write "+name+": "+err.Error())
			return
		}
		if strings.HasSuffix(name, ".c") {
			sourceFiles = append(sourceFiles, name)
		}
	}
	if len(sourceFiles) == 0 {
		writeError(w, http.StatusBadRequest, "no .c source files provided")
		return
	}

	if bad := rejectedCompilerArg(req.CompilerArgs); bad != "" {
		writeError(w, http.StatusBadRequest, "compiler argument not allowed: "+bad)
		return
	}

	outputPath := filepath.Join(buildDir, req.Output)

	// ⚠️ -o goes LAST, after the caller's args: gcc/clang honour the LAST -o,
	// so building the command the other way round let compilerArgs silently
	// undo the req.Output containment check above. rejectedCompilerArg is the
	// second half of that fix (a linker -o, or a flag that makes the compiler
	// load caller-chosen code, would slip past ordering alone).
	args := append([]string{}, sourceFiles...)
	args = append(args, req.CompilerArgs...)
	args = append(args, "-o", outputPath)

	cmd := exec.Command(req.Compiler, args...)
	cmd.Dir = buildDir
	var combined bytes.Buffer
	cmd.Stdout = &combined
	cmd.Stderr = &combined
	runErr := cmd.Run()

	resp := buildResponse{
		BuildDir: buildDir,
		Log:      combined.String(),
	}
	if runErr != nil {
		resp.OK = false
		resp.Error = runErr.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}

	resp.OK = true
	resp.BinaryPath = outputPath
	writeJSON(w, http.StatusOK, resp)
}

// rejectedCompilerArg returns the first caller-supplied compiler argument that
// must not be passed through, or "" when all of them are fine.
//
// The endpoint's entire sandbox is "the compiler may only write inside
// buildDir". Two classes of argument break that regardless of where -o sits on
// the command line, so they are refused by name:
//
//   - output redirection that outranks or bypasses the driver's own -o
//     (-o itself in any spelling, a linker -o smuggled through -Wl,/-Xlinker,
//     a GCC response file @args).
//   - anything that makes the compiler load and run caller-chosen code
//     (-fplugin=, -specs=, -B, -wrapper, -Xclang -load, a linker -plugin or
//     linker script).
//
// Everything else stays permissive — -I/-L/-l/-O/-D/-W/-f/-std and bare
// operands are what the frontend legitimately sends. A bare (non-flag) operand
// is always allowed: it is a source or library file, never an output path, and
// allowing it is what lets value-taking flags like `-isysroot /path` work.
func rejectedCompilerArg(args []string) string {
	for _, a := range args {
		if a == "" {
			continue
		}
		if strings.HasPrefix(a, "@") {
			return a // GCC response file: arbitrary extra args from a file
		}
		if !strings.HasPrefix(a, "-") {
			continue // an operand (source / library / a flag's value)
		}
		for _, bad := range deniedArgPrefixes {
			if strings.HasPrefix(a, bad) {
				return a
			}
		}
		// -Wl,/-Wa,/-Wp,/-Xlinker pass their payload straight to another tool,
		// so inspect the payload rather than trusting the wrapper.
		if strings.HasPrefix(a, "-Wl,") || strings.HasPrefix(a, "-Wa,") || strings.HasPrefix(a, "-Wp,") {
			for _, tok := range strings.Split(a[4:], ",") {
				for _, bad := range deniedPassthroughArgs {
					if tok == bad || strings.HasPrefix(tok, bad+"=") {
						return a
					}
				}
			}
		}
	}
	return ""
}

// deniedArgPrefixes are matched with HasPrefix so the fused spellings
// (-ofile, -fplugin=x, -Bdir) are caught alongside the separated ones.
// "-o" does not collide with "-O2": the match is case-sensitive.
var deniedArgPrefixes = []string{
	"-o", "--output",
	"-B", "-specs=", "--specs", "-wrapper", "--wrapper",
	"-fplugin", "-fuse-ld=",
	"-Xclang", "-Xlinker", "-Xpreprocessor",
	"-T", "--script",
}

// deniedPassthroughArgs are the tokens refused inside a -Wl,/-Wa,/-Wp, payload.
var deniedPassthroughArgs = []string{"-o", "--output", "-T", "--script", "-plugin", "--plugin"}

// allowedCompilers is the exec allowlist for POST /api/host/build.
var allowedCompilers = map[string]bool{
	"clang": true, "clang++": true, "gcc": true, "g++": true, "cc": true,
}

func makeBuildDir() (string, error) {
	var idBytes [6]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(idBytes[:])
	dir := filepath.Join(os.TempDir(), "host-build-"+id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// sweepStaleBuildDirs removes leftover host-build-* temp dirs from previous
// sessions. The build response returns BuildDir/BinaryPath to the caller, so
// dirs can't be removed right after a build — instead they are reaped on the
// NEXT agent start. An age guard (>1h) avoids clobbering a concurrently
// running second agent instance.
func sweepStaleBuildDirs() {
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-1 * time.Hour)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "host-build-") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(os.TempDir(), e.Name()))
	}
}
