package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Path resolver — mirrors the layout that lived under src-tauri/.
//
// Layout (dev):
//
//	<project-root>/src-tauri/resources/<triple>/{include,lib,server}/
//	<project-root>/src-tauri/toolchains/{bin,lib/clang/<ver>,sysroots/<triple>}/
//
// Layout (production — host-agent binary alongside resources/toolchains/):
//
//	<exe-dir>/resources/<triple>/{include,lib,server}/
//	<exe-dir>/toolchains/{bin,lib/clang/<ver>,sysroots/<triple>}/
//
// `app-data-dir` is platform-specific (~/.local/share/com.plceditor.app/ on Linux),
// used for the build output (`build/`) and HMI layout state.
type Paths struct {
	ResourcesRoot  string
	ToolchainsRoot string
	AppDataDir     string
}

func NewPaths(resourcesRoot, toolchainsRoot, appDataDir string) (*Paths, error) {
	p := &Paths{
		ResourcesRoot:  resourcesRoot,
		ToolchainsRoot: toolchainsRoot,
		AppDataDir:     appDataDir,
	}
	if p.ResourcesRoot == "" {
		p.ResourcesRoot = guessResourcesRoot()
	}
	if p.ToolchainsRoot == "" {
		p.ToolchainsRoot = guessToolchainsRoot()
	}
	if p.AppDataDir == "" {
		p.AppDataDir = defaultAppDataDir()
	}
	if err := os.MkdirAll(p.BuildDir(), 0o755); err != nil {
		return nil, fmt.Errorf("create build dir: %w", err)
	}
	return p, nil
}

func (p *Paths) BuildDir() string {
	return filepath.Join(p.AppDataDir, "build")
}

func (p *Paths) HmiStateDir() string {
	return p.AppDataDir
}

// targetResourceKey maps a UI-facing target (e.g. "x86_64/linux") to the
// directory key used under resources/ (e.g. "x86_64-linux-gnu").
func targetResourceKey(target string) (string, error) {
	switch target {
	case "x86_64/linux":
		return "x86_64-linux-gnu", nil
	case "x86_64/win32":
		return "x86_64-w64-mingw32", nil
	case "x86_64/macos":
		return "x86_64-apple-darwin", nil
	case "arm64/macos":
		// Apple Silicon (M-series). Its own key because the Krontek static
		// archives are per-ABI — linking the x86_64 .a files into an arm64
		// build fails at link time, so an Intel Mac and an M-series Mac need
		// separate resources/<triple>/lib trees.
		return "aarch64-apple-darwin", nil
	case "arm/aarch64":
		return "aarch64-linux-gnu", nil
	case "arm/armv7":
		return "arm-linux-gnueabihf", nil
	case "server/linux/amd64":
		return "x86_64-linux-gnu", nil
	case "server/linux/arm64":
		return "aarch64-linux-gnu", nil
	case "server/linux/armv7":
		return "arm-linux-gnueabihf", nil
	default:
		return "", fmt.Errorf("unknown resource target key: %s", target)
	}
}

func (p *Paths) ResourceTargetDir(target string) (string, error) {
	key, err := targetResourceKey(target)
	if err != nil {
		return "", err
	}
	return filepath.Join(p.ResourcesRoot, key), nil
}

// ResourceTargetIncludeDir returns the Krontek library + HAL header include
// dir. These headers are architecture-independent (POSIX/Linux APIs gated by
// board #defines), so a single shared tree at resources/krontek-include serves
// every target instead of one duplicated copy per triple. The target is still
// validated so an unknown target key surfaces the same error as before.
func (p *Paths) ResourceTargetIncludeDir(target string) (string, error) {
	if _, err := targetResourceKey(target); err != nil {
		return "", err
	}
	return filepath.Join(p.ResourcesRoot, "krontek-include"), nil
}

func (p *Paths) ResourceTargetLibDir(target string) (string, error) {
	dir, err := p.ResourceTargetDir(target)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "lib"), nil
}

func (p *Paths) ResourceTargetServerDir(target string) (string, error) {
	dir, err := p.ResourceTargetDir(target)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "server"), nil
}

// LLVMBin returns the path to a bundled LLVM binary, accounting for .exe on Windows.
func (p *Paths) LLVMBin(name string) string {
	exe := name
	if runtime.GOOS == "windows" {
		exe = name + ".exe"
	}
	return filepath.Join(p.ToolchainsRoot, "bin", exe)
}

// LLVMSysroot returns the harvested sysroot directory for a triple.
// `triple` here is the LLVM triple (e.g. "x86_64-linux-gnu"), NOT the UI target key.
func (p *Paths) LLVMSysroot(triple string) string {
	return filepath.Join(p.ToolchainsRoot, "sysroots", triple)
}

// macSDKOnce caches the macOS SDK path — resolving it shells out to xcrun,
// and every local-sim compile (sim binary, loader-host, each logic module)
// would otherwise pay for that.
var macSDKOnce struct {
	sync.Once
	path string
	err  error
}

// MacOSSDKPath returns the macOS SDK root for the HOST compile (darwin only).
//
// ⚠️ Unlike every other target, macOS has no sysroot bundled under
// toolchains/sysroots/: Apple does not permit redistributing the SDK, so the
// libc/framework headers must come from the user's Xcode Command Line Tools.
// The bundled upstream LLVM clang is not Apple's clang and does not reliably
// infer the SDK on its own, so the driver is given an explicit -isysroot.
// A missing CLT is reported here with the exact command to fix it — otherwise
// it surfaces much later as a wall of "stdio.h file not found".
func (p *Paths) MacOSSDKPath() (string, error) {
	macSDKOnce.Do(func() {
		if sdk := os.Getenv("SDKROOT"); sdk != "" {
			if _, err := os.Stat(sdk); err == nil {
				macSDKOnce.path = sdk
				return
			}
		}
		out, err := exec.Command("xcrun", "--sdk", "macosx", "--show-sdk-path").Output()
		if err != nil {
			macSDKOnce.err = fmt.Errorf(
				"macOS SDK not found: xcrun failed (%v). Install the Xcode Command Line Tools with:\n"+
					"    xcode-select --install", err)
			return
		}
		sdk := strings.TrimSpace(string(out))
		if sdk == "" {
			macSDKOnce.err = fmt.Errorf("macOS SDK not found: `xcrun --show-sdk-path` returned nothing")
			return
		}
		macSDKOnce.path = sdk
	})
	return macSDKOnce.path, macSDKOnce.err
}

// LLVMClangResourceDir returns the highest-version Clang resource dir.
// Version dirs are compared NUMERICALLY component-by-component ("18" > "9"),
// not lexicographically — sort.Strings would pick "9" over "18".
func (p *Paths) LLVMClangResourceDir() (string, error) {
	base := filepath.Join(p.ToolchainsRoot, "lib", "clang")
	entries, err := os.ReadDir(base)
	if err != nil {
		return "", fmt.Errorf("LLVM resource dir not found (%s): %w", base, err)
	}
	var versions []string
	for _, e := range entries {
		if e.IsDir() {
			versions = append(versions, e.Name())
		}
	}
	if len(versions) == 0 {
		return "", fmt.Errorf("no Clang resource version under %s", base)
	}
	sort.Slice(versions, func(i, j int) bool {
		return compareVersionStrings(versions[i], versions[j]) < 0
	})
	return filepath.Join(base, versions[len(versions)-1]), nil
}

// compareVersionStrings compares dotted version strings numerically per
// component ("18.1.8" vs "9.0.1"); non-numeric components fall back to a
// string comparison for that component.
func compareVersionStrings(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var ac, bc string
		if i < len(as) {
			ac = as[i]
		}
		if i < len(bs) {
			bc = bs[i]
		}
		an, aerr := strconv.Atoi(ac)
		bn, berr := strconv.Atoi(bc)
		switch {
		case aerr == nil && berr == nil:
			if an != bn {
				if an < bn {
					return -1
				}
				return 1
			}
		default:
			if ac != bc {
				if ac < bc {
					return -1
				}
				return 1
			}
		}
	}
	return 0
}

// LLVMTargetIncludeDirs returns extra `-isystem` directories for a given triple.
func (p *Paths) LLVMTargetIncludeDirs(triple string) ([]string, error) {
	sysroot := p.LLVMSysroot(triple)
	clangRes, err := p.LLVMClangResourceDir()
	if err != nil {
		return nil, err
	}
	dirs := []string{filepath.Join(clangRes, "include")}
	switch triple {
	case "x86_64-linux-gnu":
		dirs = append(dirs,
			filepath.Join(sysroot, "usr/include"),
			filepath.Join(sysroot, "include"),
			filepath.Join(sysroot, "usr/include/x86_64-linux-gnu"),
		)
	case "aarch64-linux-gnu":
		dirs = append(dirs,
			filepath.Join(sysroot, "usr/include"),
			filepath.Join(sysroot, "include"),
			filepath.Join(sysroot, "usr/include/aarch64-linux-gnu"),
		)
	case "arm-linux-gnueabihf":
		dirs = append(dirs,
			filepath.Join(sysroot, "usr/include"),
			filepath.Join(sysroot, "include"),
			filepath.Join(sysroot, "usr/include/arm-linux-gnueabihf"),
		)
	case "x86_64-w64-mingw32":
		dirs = append(dirs,
			filepath.Join(sysroot, "include"),
			filepath.Join(sysroot, "x86_64-w64-mingw32/include"),
			filepath.Join(sysroot, "generic-w64-mingw32/include"),
		)
	}
	return filterExisting(dirs), nil
}

// LLVMTargetLibraryDirs returns -L directories for a given triple.
func (p *Paths) LLVMTargetLibraryDirs(triple string) []string {
	sysroot := p.LLVMSysroot(triple)
	var dirs []string
	switch triple {
	case "x86_64-linux-gnu":
		dirs = []string{
			filepath.Join(sysroot, "lib"),
			filepath.Join(sysroot, "lib64"),
			filepath.Join(sysroot, "usr/lib"),
			filepath.Join(sysroot, "usr/lib/x86_64-linux-gnu"),
		}
	case "aarch64-linux-gnu":
		dirs = []string{
			filepath.Join(sysroot, "lib"),
			filepath.Join(sysroot, "usr/lib"),
			filepath.Join(sysroot, "usr/lib/aarch64-linux-gnu"),
		}
	case "arm-linux-gnueabihf":
		dirs = []string{
			filepath.Join(sysroot, "lib"),
			filepath.Join(sysroot, "usr/lib"),
			filepath.Join(sysroot, "usr/lib/arm-linux-gnueabihf"),
		}
	case "x86_64-w64-mingw32":
		dirs = []string{
			filepath.Join(sysroot, "lib"),
			filepath.Join(sysroot, "x86_64-w64-mingw32/lib"),
		}
	}
	// libgcc/libgcc_eh live in the bundled GCC install dir, which -static needs.
	if gcc := p.LLVMGCCInstallDir(triple); gcc != "" {
		dirs = append(dirs, gcc)
	}
	return filterExisting(dirs)
}

// MinGWResourceDir returns the clang resource dir that carries the mingw-w64
// compiler-rt builtins (<sysroot>/lib/clang/<ver>), or "" if absent.
//
// ⚠️ It must come from the MINGW SYSROOT, not from ToolchainsRoot/lib/clang.
// The bundled LLVM's own resource dir ships only the MSVC-flavoured
// clang_rt.builtins-x86_64.LIB, which does not satisfy a
// --target=x86_64-w64-windows-gnu link: clang looks for
// libclang_rt.builtins.a and dies with "unable to find library -lgcc"
// (it falls back to a libgcc that llvm-mingw does not ship). The llvm-mingw
// sysroot we harvest DOES contain the right .a, under its own lib/clang tree.
func (p *Paths) MinGWResourceDir() string {
	matches, err := filepath.Glob(filepath.Join(p.LLVMSysroot("x86_64-w64-mingw32"), "lib", "clang", "*"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	sort.Slice(matches, func(i, j int) bool {
		return compareVersionStrings(filepath.Base(matches[i]), filepath.Base(matches[j])) < 0
	})
	return matches[len(matches)-1]
}

// MinGWLibDir returns the mingw-w64 target library dir (libwinpthread etc.).
func (p *Paths) MinGWLibDir() string {
	return filepath.Join(p.LLVMSysroot("x86_64-w64-mingw32"), "x86_64-w64-mingw32", "lib")
}

// LLVMGCCInstallDir locates the bundled GCC installation inside a sysroot
// (<sysroot>/lib/gcc/<vendor-triple>/<version>), or "" when absent.
//
// ⚠️ It must be discovered by GLOB, not built from the compile triple: the
// bundled sysroots name this directory with a "none" vendor
// (arm-none-linux-gnueabihf, aarch64-none-linux-gnu) while we compile with
// --target=arm-linux-gnueabihf. Clang's own GCC auto-detection happens to
// include the aarch64 "none" spelling in its candidate list but NOT the arm
// one, so armv7 static links failed with "cannot open crtbeginT.o" and
// "unable to find library -lgcc" — i.e. Build & Send was broken for every
// armv7 BeagleBone while aarch64 worked by luck. Passing this dir explicitly
// as -B (crt objects) and -L (libgcc) makes both targets deterministic.
func (p *Paths) LLVMGCCInstallDir(triple string) string {
	matches, err := filepath.Glob(filepath.Join(p.LLVMSysroot(triple), "lib", "gcc", "*", "*"))
	if err != nil {
		return ""
	}
	var dirs []string
	for _, m := range matches {
		if st, err := os.Stat(m); err == nil && st.IsDir() {
			dirs = append(dirs, m)
		}
	}
	if len(dirs) == 0 {
		return ""
	}
	// Highest version wins, compared NUMERICALLY per component — sort.Strings
	// would rank "9.3.0" above "10.2.1" and silently select the older GCC.
	sort.Slice(dirs, func(i, j int) bool {
		return compareVersionStrings(filepath.Base(dirs[i]), filepath.Base(dirs[j])) < 0
	})
	return dirs[len(dirs)-1]
}

// CollectStaticArchives returns all .a files in a directory (no recursion).
func CollectStaticArchives(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".a" {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(out)
	return out
}

func filterExisting(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func guessResourcesRoot() string {
	return guessSiblingDir("resources")
}

func guessToolchainsRoot() string {
	return guessSiblingDir("toolchains")
}

// guessSiblingDir looks for a "resources" or "toolchains" directory in:
//   cwd, cwd/..  (running from host-agent/ during dev)
//   exe dir, exe dir/.. (production binary alongside the data dir)
// Returns the first match (absolute path) or the bare name as fallback.
func guessSiblingDir(name string) string {
	tryAt := func(base string) string {
		c := filepath.Join(base, name)
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
		return ""
	}
	if cwd, err := os.Getwd(); err == nil {
		for _, base := range []string{cwd, filepath.Join(cwd, "..")} {
			if hit := tryAt(base); hit != "" {
				return hit
			}
		}
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		for _, base := range []string{exeDir, filepath.Join(exeDir, "..")} {
			if hit := tryAt(base); hit != "" {
				return hit
			}
		}
	}
	return name
}

func defaultAppDataDir() string {
	// Match Tauri's app_local_data_dir for Linux/macOS/Windows.
	const bundleID = "com.plceditor.app"
	if runtime.GOOS == "linux" {
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			return filepath.Join(xdg, bundleID)
		}
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".local", "share", bundleID)
	}
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", bundleID)
	}
	if runtime.GOOS == "windows" {
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, bundleID)
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", bundleID)
}
