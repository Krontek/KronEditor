import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const targetDir = path.join(projectRoot, 'src-tauri', 'target', 'release', 'bundle');
const releaseDir = path.join(projectRoot, 'Releases');

// Formats: Linux (appimage), Windows (msi, nsis), macOS (dmg)
// Adjust based on what your machine builds.
const formats = ['appimage', 'msi', 'nsis', 'dmg'];

if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
}

// Helper to move files
const moveArtifacts = (baseDir) => {
    if (!fs.existsSync(baseDir)) return;

    console.log(`Checking for artifacts in ${baseDir}...`);
    formats.forEach(format => {
        const formatDir = path.join(baseDir, format);
        if (fs.existsSync(formatDir)) {
            const files = fs.readdirSync(formatDir);
            files.forEach(file => {
                // Check for relevant extensions
                if (file.endsWith(`.${format}`) || file.endsWith(`.AppImage`) || file.endsWith(`.exe`) || file.endsWith(`.dmg`) || file.endsWith(`.msi`)) {
                    const srcPath = path.join(formatDir, file);
                    const destPath = path.join(releaseDir, file);
                    try {
                        fs.copyFileSync(srcPath, destPath);
                        console.log(`Moved: ${file} -> Releases/`);
                    } catch (e) {
                        console.error(`Failed to move ${file}:`, e);
                    }
                }
            });
        }
    });
}

// Check default release dir (Linux default)
moveArtifacts(targetDir);

// Check Windows cross-compile dir
const windowsTargetDir = path.join(projectRoot, 'src-tauri', 'target', 'x86_64-pc-windows-gnu', 'release', 'bundle');
moveArtifacts(windowsTargetDir);
