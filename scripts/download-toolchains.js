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
import http  from 'http';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const TC_DIR    = path.join(ROOT, 'src-tauri', 'toolchains');
const HOST_FILE = path.join(TC_DIR, '.host');

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
        check: () => {
            const gcc = hostOS === 'windows' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc';
            return fs.existsSync(path.join(TC_DIR, 'arm-none-eabi', 'bin', gcc));
        },
        skip: false,
        download: () => downloadArmOfficial('arm-none-eabi', 'arm-none-eabi'),
    },
    'aarch64-none-linux-gnu': {
        description: 'AArch64 Linux cross-compiler (Raspberry Pi, etc.)',
        dir:  path.join(TC_DIR, 'aarch64-none-linux-gnu'),
        check: () => {
            const gcc = hostOS === 'windows' ? 'aarch64-none-linux-gnu-gcc.exe' : 'aarch64-none-linux-gnu-gcc';
            return fs.existsSync(path.join(TC_DIR, 'aarch64-none-linux-gnu', 'bin', gcc));
        },
        skip: false,
        download: () => downloadArmOfficial('aarch64-none-linux-gnu', 'aarch64-none-linux-gnu'),
    },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
fs.mkdirSync(TC_DIR, { recursive: true });

// Check if we already have the right host's toolchains
const existingHost = fs.existsSync(HOST_FILE)
    ? fs.readFileSync(HOST_FILE, 'utf8').trim()
    : null;

if (existingHost && existingHost !== hostOS) {
    console.log(`[toolchains] Host changed (${existingHost} → ${hostOS}), re-downloading...`);
    // Remove non-matching toolchains (keep directory structure)
    for (const [name, tc] of Object.entries(TOOLCHAINS)) {
        if (fs.existsSync(tc.dir)) {
            fs.rmSync(tc.dir, { recursive: true, force: true });
            console.log(`  Removed ${name}/`);
        }
    }
}

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
        if (!tc.check()) throw new Error('gcc binary not found after extraction');
        console.log(`[${name}] OK`);
    } catch (e) {
        console.error(`[${name}] FAILED: ${e.message}`);
        allOk = false;
    }
}

fs.writeFileSync(HOST_FILE, hostOS);
if (!allOk) { console.error('\nSome toolchains failed to download.'); process.exit(1); }
console.log('[toolchains] All done.');

// ===========================================================================
// Download helpers
// ===========================================================================

/** Follow redirects and download a file to disk. */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const get = url.startsWith('https') ? https.get : http.get;
        const doGet = (u) => {
            get(u, { headers: { 'User-Agent': 'KronEditor-build' } }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                    file.close();
                    fs.unlinkSync(dest);
                    return doGet(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    file.close();
                    fs.unlinkSync(dest);
                    return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (total > 0) {
                        const pct = ((downloaded / total) * 100).toFixed(0);
                        process.stdout.write(`\r  Downloading... ${pct}% (${(downloaded / 1048576).toFixed(1)} MB)`);
                    }
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); console.log(''); resolve(); });
            }).on('error', (e) => { file.close(); fs.unlinkSync(dest); reject(e); });
        };
        doGet(url);
    });
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
        execSync(`unzip -q "${tmpFile}" -d "${TC_DIR}"`, { stdio: 'inherit' });
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

    console.log('  Extracting (this may take a while)...');
    if (filename.endsWith('.tar.xz')) {
        // Linux: tar.xz
        fs.mkdirSync(destDir, { recursive: true });
        execSync(`tar xf "${tmpFile}" -C "${TC_DIR}"`, { stdio: 'inherit' });
        // Find extracted dir (arm-gnu-toolchain-VERSION-HOST-TRIPLET)
        const entries = fs.readdirSync(TC_DIR).filter(e =>
            e.startsWith(`arm-gnu-toolchain-${ARM_VERSION}`) && e.includes(triplet) &&
            fs.statSync(path.join(TC_DIR, e)).isDirectory()
        );
        if (entries.length > 0) {
            const extractedDir = path.join(TC_DIR, entries[0]);
            if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
            fs.renameSync(extractedDir, destDir);
        }
    } else {
        // Windows: .zip
        if (process.platform === 'win32') {
            execSync(
                `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpFile}' -DestinationPath '${TC_DIR}'"`,
                { stdio: 'inherit' }
            );
        } else {
            execSync(`unzip -q "${tmpFile}" -d "${TC_DIR}"`, { stdio: 'inherit' });
        }
        // Find and rename extracted directory
        const entries = fs.readdirSync(TC_DIR).filter(e =>
            e.startsWith(`arm-gnu-toolchain-${ARM_VERSION}`) && e.includes(triplet) &&
            fs.statSync(path.join(TC_DIR, e)).isDirectory()
        );
        if (entries.length > 0) {
            const extractedDir = path.join(TC_DIR, entries[0]);
            if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
            fs.renameSync(extractedDir, destDir);
        }
    }

    fs.unlinkSync(tmpFile);
}
