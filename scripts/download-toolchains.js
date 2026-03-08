/**
 * download-toolchains.js
 *
 * Downloads and extracts cross-compilation toolchains into src-tauri/toolchains/.
 *
 * Usage:
 *   node scripts/download-toolchains.js                # auto-detect host OS
 *   node scripts/download-toolchains.js --host linux   # force Linux-hosted toolchains
 *   node scripts/download-toolchains.js --host windows # force Windows-hosted toolchains
 *
 * Toolchains installed:
 *   toolchains/mingw/                    - w64devkit (MinGW GCC for Windows targets)
 *   toolchains/arm-none-eabi/            - ARM bare-metal (Cortex-M targets)
 *   toolchains/aarch64-none-linux-gnu/   - AArch64 Linux cross-compiler
 *
 * Sources:
 *   MinGW:  skeeto/w64devkit on GitHub (Windows-hosted only)
 *   ARM:    ARM GNU Toolchain from developer.arm.com (official releases)
 */

import fs   from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const TC_BASE   = path.join(ROOT, 'src-tauri', 'toolchains');

// ---------------------------------------------------------------------------
// Detect or override host OS
// ---------------------------------------------------------------------------
let hostOS = process.platform === 'win32' ? 'windows' : 'linux';
const hostArg = process.argv.indexOf('--host');
if (hostArg !== -1 && process.argv[hostArg + 1]) {
    const v = process.argv[hostArg + 1].toLowerCase();
    if (v === 'linux' || v === 'windows') hostOS = v;
    else { console.error(`Unknown host: ${v}. Use "linux" or "windows".`); process.exit(1); }
}

console.log(`[toolchains] Host: ${hostOS}`);

// ---------------------------------------------------------------------------
// ARM GNU Toolchain version (pinned for reproducibility)
// ---------------------------------------------------------------------------
const ARM_VERSION = '14.2.rel1';
const ARM_BASE    = `https://developer.arm.com/-/media/Files/downloads/gnu/${ARM_VERSION}/binrel`;

// ---------------------------------------------------------------------------
// Toolchain definitions
// ---------------------------------------------------------------------------
// TC_DIR is host-specific: toolchains/linux/ or toolchains/windows/
const TC_DIR = path.join(TC_BASE, hostOS);

const TOOLCHAINS = {
    mingw: {
        description: 'MinGW (w64devkit) — cross-compile to Windows',
        dir:  path.join(TC_DIR, 'mingw'),
        check: () => fs.existsSync(
            path.join(TC_DIR, 'mingw', 'bin', hostOS === 'windows' ? 'gcc.exe' : 'gcc')
        ),
        // w64devkit is Windows-only — ships .exe binaries
        // For Linux host: we rely on system x86_64-w64-mingw32-gcc (skip download)
        skip: hostOS === 'linux',
        download: downloadMingw,
    },
    'arm-none-eabi': {
        description: 'ARM bare-metal (Cortex-M targets)',
        dir:  path.join(TC_DIR, 'arm-none-eabi'),
        check: () => hasGcc(TC_DIR, 'arm-none-eabi'),
        skip: false,
        download: () => downloadArmOfficial('arm-none-eabi', 'arm-none-eabi'),
    },
    'aarch64-none-linux-gnu': {
        description: 'AArch64 Linux cross-compiler (Raspberry Pi, etc.)',
        dir:  path.join(TC_DIR, 'aarch64-none-linux-gnu'),
        check: () => hasGcc(TC_DIR, 'aarch64-none-linux-gnu'),
        skip: false,
        download: () => downloadArmOfficial('aarch64-none-linux-gnu', 'aarch64-none-linux-gnu'),
    },
};

/** Check if a toolchain's gcc binary exists (handles both .exe and bare names). */
function hasGcc(tcDir, triplet) {
    const binDir = path.join(tcDir, triplet, 'bin');
    return fs.existsSync(path.join(binDir, `${triplet}-gcc`))
        || fs.existsSync(path.join(binDir, `${triplet}-gcc.exe`));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
fs.mkdirSync(TC_DIR, { recursive: true });

let allOk = true;
for (const [name, tc] of Object.entries(TOOLCHAINS)) {
    if (tc.skip) {
        console.log(`[${name}] SKIP (not needed for ${hostOS} host)`);
        continue;
    }
    if (tc.check()) {
        console.log(`[${name}] Already present, skipping.`);
        continue;
    }
    console.log(`[${name}] ${tc.description}`);
    try {
        await tc.download();
        if (!tc.check()) {
            // Diagnostics: list what ended up in bin/
            const binDir = path.join(tc.dir, 'bin');
            if (fs.existsSync(binDir)) {
                const files = fs.readdirSync(binDir);
                console.error(`  bin/ contains ${files.length} files: ${files.slice(0, 10).join(', ')}${files.length > 10 ? '...' : ''}`);
            } else {
                console.error(`  bin/ directory does not exist at ${binDir}`);
            }
            throw new Error('gcc binary not found after extraction');
        }
        console.log(`[${name}] OK`);
    } catch (e) {
        console.error(`[${name}] FAILED: ${e.message}`);
        allOk = false;
    }
}

if (!allOk) { console.error('\nSome toolchains failed to download.'); process.exit(1); }
console.log('[toolchains] All done.');

// ===========================================================================
// Download helpers
// ===========================================================================

/** Download a file using curl or wget (handles CDN redirects reliably). */
function downloadFile(url, dest) {
    // Try curl first, then wget
    try {
        execSync(`curl -fL --progress-bar -o "${dest}" "${url}"`, { stdio: 'inherit' });
    } catch {
        try {
            execSync(`wget --show-progress -O "${dest}" "${url}"`, { stdio: 'inherit' });
        } catch (e) {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            throw new Error(`Download failed (neither curl nor wget succeeded): ${e.message}`);
        }
    }
    if (!fs.existsSync(dest)) throw new Error(`Download produced no file: ${dest}`);
    return Promise.resolve();
}

/** Fetch JSON from a URL, following redirects. */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'KronEditor-build' } }, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchJson(res.headers.location).then(resolve, reject);
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// MinGW — w64devkit from GitHub (Windows-hosted only)
// ---------------------------------------------------------------------------
async function downloadMingw() {
    const destDir = path.join(TC_DIR, 'mingw');
    console.log('  Querying latest w64devkit release...');
    const release = await fetchJson('https://api.github.com/repos/skeeto/w64devkit/releases/latest');
    const asset =
        release.assets?.find(a => a.name.match(/^w64devkit-x64.*\.zip$/)) ||
        release.assets?.find(a => a.name.match(/^w64devkit-x64.*\.7z\.exe$/));
    if (!asset) throw new Error(`No x64 asset in ${release.tag_name}`);

    const tmpFile = path.join(TC_DIR, asset.name);
    console.log(`  Downloading ${asset.name} (${release.tag_name})...`);
    await downloadFile(asset.browser_download_url, tmpFile);

    console.log('  Extracting...');
    const extracted = path.join(TC_DIR, 'w64devkit');
    if (process.platform === 'win32') {
        execSync(
            `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpFile}' -DestinationPath '${TC_DIR}'"`,
            { stdio: 'inherit' }
        );
    } else if (asset.name.endsWith('.7z.exe') || asset.name.endsWith('.7z')) {
        execSync(`7z x "${tmpFile}" -o"${TC_DIR}" -y`, { stdio: 'inherit' });
    } else {
        execSync(`unzip -ooq "${tmpFile}" -d "${TC_DIR}"`, { stdio: 'inherit' });
    }

    if (fs.existsSync(extracted)) {
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
        fs.renameSync(extracted, destDir);
    }
    fs.unlinkSync(tmpFile);
}

// ---------------------------------------------------------------------------
// ARM Official Toolchain (arm-none-eabi or aarch64-none-linux-gnu)
// ---------------------------------------------------------------------------
async function downloadArmOfficial(toolchainName, triplet) {
    const destDir = path.join(TC_DIR, toolchainName);

    // Build filename based on host
    let filename;
    if (hostOS === 'linux') {
        filename = `arm-gnu-toolchain-${ARM_VERSION}-x86_64-${triplet}.tar.xz`;
    } else {
        filename = `arm-gnu-toolchain-${ARM_VERSION}-mingw-w64-i686-${triplet}.zip`;
    }

    const url = `${ARM_BASE}/${filename}`;
    const tmpFile = path.join(TC_DIR, filename);

    console.log(`  Downloading ${filename}...`);
    await downloadFile(url, tmpFile);

    // Extract into a temporary directory to handle both layouts:
    //   Linux tar.xz: single root dir (arm-gnu-toolchain-VERSION-HOST-TRIPLET/)
    //   Windows zip:  flat layout (bin/, lib/, libexec/, <triplet>/, share/, ...)
    const tmpExtract = path.join(TC_DIR, `_extract_${toolchainName}`);
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.mkdirSync(tmpExtract, { recursive: true });

    console.log('  Extracting (this may take a while)...');
    if (filename.endsWith('.tar.xz')) {
        execSync(`tar xf "${tmpFile}" -C "${tmpExtract}"`, { stdio: 'inherit' });
    } else if (process.platform === 'win32') {
        execSync(
            `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpFile}' -DestinationPath '${tmpExtract}'"`,
            { stdio: 'inherit' }
        );
    } else {
        execSync(`unzip -oq "${tmpFile}" -d "${tmpExtract}"`, { stdio: 'inherit' });
    }

    // Determine the actual toolchain root inside tmpExtract.
    // If extraction created a single directory wrapper (tar.xz), unwrap it.
    // If it's a flat layout (Windows zip), tmpExtract itself is the root.
    const entries = fs.readdirSync(tmpExtract).filter(e => {
        try { return fs.statSync(path.join(tmpExtract, e)).isDirectory(); }
        catch { return false; }
    });
    let toolchainRoot = tmpExtract;
    if (entries.length === 1 && fs.existsSync(path.join(tmpExtract, entries[0], 'bin'))) {
        // Single wrapper directory (tar.xz layout) — unwrap
        toolchainRoot = path.join(tmpExtract, entries[0]);
    }

    // Move to final destination
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(toolchainRoot, destDir);
    // Clean up temp dir (may still exist if we unwrapped a subdirectory)
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });

    fs.unlinkSync(tmpFile);

    // Strip to minimal compile/link toolset
    console.log('  Pruning unnecessary files...');
    pruneToolchain(destDir, triplet);
}

// ---------------------------------------------------------------------------
// Prune ARM toolchain to minimal compile-and-link set
// ---------------------------------------------------------------------------
function pruneToolchain(tcDir, triplet) {
    const gccVer = '14.2.1';

    // --- 1. bin/: keep only what we need for C compilation and linking ---
    // Include both bare and .exe names so pruning works regardless of host
    const binNames = [
        `${triplet}-gcc`, `${triplet}-gcc-${gccVer}`,
        `${triplet}-ar`, `${triplet}-as`,
        `${triplet}-ld`, `${triplet}-ld.bfd`,
        `${triplet}-ranlib`, `${triplet}-objcopy`,
        `${triplet}-size`, `${triplet}-cpp`,
    ];
    const keepBins = new Set();
    for (const n of binNames) { keepBins.add(n); keepBins.add(n + '.exe'); }
    const binDir = path.join(tcDir, 'bin');
    if (fs.existsSync(binDir)) {
        const before = fs.readdirSync(binDir);
        for (const f of before) {
            if (!keepBins.has(f)) rmPath(path.join(binDir, f));
        }
        const after = fs.readdirSync(binDir);
        if (after.length === 0 && before.length > 0) {
            console.error(`  WARNING: pruning removed ALL ${before.length} files from bin/`);
            console.error(`  Actual names: ${before.slice(0, 5).join(', ')}${before.length > 5 ? '...' : ''}`);
            console.error(`  Expected names like: ${[...keepBins].slice(0, 4).join(', ')}`);
        }
    }

    // --- 2. libexec/gcc/<triplet>/<ver>/: keep cc1, collect2; drop cc1plus, f951, etc. ---
    const libexecDir = path.join(tcDir, 'libexec', 'gcc', triplet, gccVer);
    if (fs.existsSync(libexecDir)) {
        const leNames = ['cc1', 'collect2', 'liblto_plugin.so', 'liblto_plugin-0.dll', 'lto-wrapper', 'lto1'];
        const keepLibexec = new Set();
        for (const n of leNames) { keepLibexec.add(n); keepLibexec.add(n + '.exe'); }
        for (const f of fs.readdirSync(libexecDir)) {
            if (!keepLibexec.has(f)) rmPath(path.join(libexecDir, f));
        }
    }

    // --- 3. Remove entire top-level dirs we never need ---
    for (const sub of ['share', 'include', 'data']) {
        rmPath(path.join(tcDir, sub));
    }
    // Remove manifest/license text files
    for (const f of fs.readdirSync(tcDir)) {
        if (f.endsWith('.txt')) rmPath(path.join(tcDir, f));
    }

    // --- 4. lib/gcc/<triplet>/<ver>/: prune multilib dirs (arm-none-eabi only) ---
    const gccLibDir = path.join(tcDir, 'lib', 'gcc', triplet, gccVer);
    if (fs.existsSync(gccLibDir)) {
        // Remove Fortran includes, install-tools, plugin, gcov
        for (const sub of ['finclude', 'install-tools', 'plugin']) {
            rmPath(path.join(gccLibDir, sub));
        }
        rmByName(gccLibDir, 'libgcov.a');
        rmByName(gccLibDir, 'libcaf_single.a');

        if (triplet === 'arm-none-eabi') {
            // Remove arm/ mode multilib (we only use thumb)
            rmPath(path.join(gccLibDir, 'arm'));
            // Keep only needed thumb variants
            pruneMultilib(path.join(gccLibDir, 'thumb'));
        }
    }

    // --- 5. <triplet>/lib/: prune sysroot multilib (arm-none-eabi only) ---
    const sysLib = path.join(tcDir, triplet, 'lib');
    if (fs.existsSync(sysLib) && triplet === 'arm-none-eabi') {
        rmPath(path.join(sysLib, 'arm'));
        pruneMultilib(path.join(sysLib, 'thumb'));
        // Remove Fortran library from sysroot root
        rmByName(sysLib, 'libgfortran.a');
        rmByName(sysLib, 'libgfortran.spec');
    }

    // --- 6. Remove python/gdb support libraries ---
    const pyDir = path.join(tcDir, 'lib', 'python3.8');
    rmPath(pyDir);
    // lib64/ (aarch64 toolchain) — contains gdb python libs
    rmPath(path.join(tcDir, 'lib64'));

    const sizeMB = getDirSizeMB(tcDir);
    console.log(`  Pruned to ${sizeMB.toFixed(0)} MB`);
}

/** For arm-none-eabi: keep only Cortex-M multilib variants we use */
function pruneMultilib(thumbDir) {
    if (!fs.existsSync(thumbDir)) return;
    // v6-m = Cortex-M0, v7e-m+fp = Cortex-M4F, v7e-m+dp = Cortex-M7F, nofp = default fallback
    const keep = new Set(['v6-m', 'v7e-m+fp', 'v7e-m+dp', 'nofp']);
    for (const d of fs.readdirSync(thumbDir)) {
        if (!keep.has(d)) rmPath(path.join(thumbDir, d));
    }
}

function rmPath(p) {
    try {
        const st = fs.lstatSync(p);
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
    } catch { /* does not exist, ignore */ }
}

function rmByName(dir, name) {
    rmPath(path.join(dir, name));
}

function getDirSizeMB(dir) {
    let total = 0;
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() || entry.isSymbolicLink()) {
                try { total += fs.statSync(full).size; } catch {}
            }
        }
    };
    walk(dir);
    return total / (1024 * 1024);
}
