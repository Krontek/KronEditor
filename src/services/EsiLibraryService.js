/**
 * EsiLibraryService.js
 * Manages persistent ESI device library stored in the host-agent's app data dir.
 *
 * The host-agent exposes its app-data dir via /api/host/build-dir (returns the
 * parent dir under .appDataDir). ESI files live under <appDataDir>/esi/.
 */

import { host } from './HostClient';
import { parseEsiXml } from './EsiParser';

let _esiDirCache = null;
async function esiDir() {
  if (_esiDirCache) return _esiDirCache;
  const info = await host.buildDir();
  // buildDir is <appData>/build, so esi/ sits next to it
  const appData = (info.buildDir || '').replace(/\/build\/?$/, '');
  _esiDirCache = `${appData}/esi`;
  return _esiDirCache;
}

/** Save an ESI XML file to the library directory. Returns the stored filename. */
export async function saveEsiFile(filename, content) {
  const dir = await esiDir();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  await host.writeFile(`${dir}/${safe}`, content);
  return safe;
}

/** Returns list of stored ESI filenames. */
export async function listEsiFiles() {
  try {
    const dir = await esiDir();
    const entries = await host.listDir(dir);
    return entries
      .filter(e => !e.isDir && e.name?.toLowerCase().endsWith('.xml'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/** Loads and parses all ESI files from the library. Returns flat device array. */
export async function loadAllEsiDevices() {
  try {
    const dir = await esiDir();
    let entries;
    try {
      entries = await host.listDir(dir);
    } catch {
      return [];
    }
    const devices = [];
    for (const entry of entries) {
      if (entry.isDir || !entry.name?.toLowerCase().endsWith('.xml')) continue;
      try {
        const content = await host.readFile(`${dir}/${entry.name}`);
        const parsed = parseEsiXml(content);
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
