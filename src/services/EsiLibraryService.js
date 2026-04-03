/**
 * EsiLibraryService.js
 * Manages persistent ESI device library stored in the app's local data directory.
 * Dev mode:     ~/.local/share/com.plceditor.app/esi/
 * Installed:    same (AppLocalData resolves to the OS app-data folder)
 */

import { readDir, mkdir, writeTextFile, readTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parseEsiXml } from './EsiParser';

const ESI_DIR = 'esi';
const BASE    = BaseDirectory.AppLocalData;

async function ensureEsiDir() {
  const ok = await exists(ESI_DIR, { baseDir: BASE });
  if (!ok) await mkdir(ESI_DIR, { baseDir: BASE, recursive: true });
}

/** Save an ESI XML file to the library directory. Returns the stored filename. */
export async function saveEsiFile(filename, content) {
  await ensureEsiDir();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  await writeTextFile(`${ESI_DIR}/${safe}`, content, { baseDir: BASE });
  return safe;
}

/** Returns list of stored ESI filenames. */
export async function listEsiFiles() {
  try {
    await ensureEsiDir();
    const entries = await readDir(ESI_DIR, { baseDir: BASE });
    return entries
      .filter(e => !e.isDirectory && e.name?.toLowerCase().endsWith('.xml'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/** Loads and parses all ESI files from the library. Returns flat device array. */
export async function loadAllEsiDevices() {
  try {
    await ensureEsiDir();
    const entries = await readDir(ESI_DIR, { baseDir: BASE });
    const devices = [];
    for (const entry of entries) {
      if (entry.isDirectory || !entry.name?.toLowerCase().endsWith('.xml')) continue;
      try {
        const content = await readTextFile(`${ESI_DIR}/${entry.name}`, { baseDir: BASE });
        const parsed  = parseEsiXml(content);
        devices.push(...parsed.map(d => ({ ...d, _esiFile: entry.name })));
      } catch (e) {
        console.warn(`[EsiLibrary] Skipped ${entry.name}:`, e.message);
      }
    }
    return devices;
  } catch (e) {
    console.error('[EsiLibrary] Load failed:', e);
    return [];
  }
}
