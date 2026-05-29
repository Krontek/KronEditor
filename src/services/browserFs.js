/**
 * browserFs.js — drop-in replacements for the @tauri-apps/plugin-fs and
 * @tauri-apps/plugin-dialog APIs that the editor used to call.
 *
 * In Tauri the host process owned a real filesystem path, so `open()`
 * returned a path string and `readTextFile(path)` read it. In a browser
 * there is no implicit path concept; instead we surface a small handle
 * object that carries either:
 *   - a File (chosen via <input type="file">), or
 *   - a path string (when the user explicitly types one and the host-agent
 *     can read/write it on their behalf).
 *
 * Callers receive a `{ path, name, content }` shape for opens so existing
 * code that only needed the textual content keeps working with minimal
 * changes; for saves we trigger a browser download instead of writing to
 * a server-side path.
 */

import { host } from './HostClient';

/**
 * Show an "open file" picker. Returns `null` if the user cancelled, otherwise
 * `{ name, path, content }`. `path` is the display name in browser mode
 * (browsers do not expose real paths) — pass it to processFileContent as the
 * filePath argument; it's only used for display + the "current file" label.
 */
export async function openFile({ accept = '.xml' } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) =>
        resolve({ name: file.name, path: file.name, content: String(e.target.result) });
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsText(file);
    };
    input.click();
  });
}

/**
 * Trigger a download of `content` as `filename`. Replaces the old
 * `save() + writeTextFile()` pair.
 */
export function downloadFile(filename, content, mime = 'application/xml') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save the current project. Tries the File System Access API for an in-place
 * write when available; falls back to a triggered download. Returns the chosen
 * filename (or null if the user cancelled the picker).
 */
export async function saveFile({ suggestedName = 'project.xml', content }) {
  // Modern browsers (Chromium): showSaveFilePicker — allows real overwrite UX.
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'KronEditor project', accept: { 'application/xml': ['.xml'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) return null;
      // Fall through to download path
    }
  }
  downloadFile(suggestedName, content);
  return suggestedName;
}

/**
 * Confirm dialog. The Tauri ask() returned a Promise<bool>; window.confirm
 * is synchronous, so we wrap it for API compatibility.
 */
export async function ask(message, _opts = {}) {
  return Promise.resolve(window.confirm(message));
}

// ── path-based read/write for code paths that have an absolute path ──────────
//
// These delegate to the local host-agent. The host-agent has no sandbox so
// callers should only pass paths they trust (the editor stays on the user's
// own machine, same trust model as Tauri's plugin-fs default scope).

export async function readTextFile(path) {
  return host.readFile(path);
}

export async function writeTextFile(path, content) {
  await host.writeFile(path, content);
}

// File System Access API helpers for ESI / library directories (used by
// EsiLibraryService etc). Browser mode lets users pick a directory once and
// reuse the handle; falls back to host-agent listDir when unavailable.

export async function pickDirectory() {
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      return await window.showDirectoryPicker();
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) return null;
      throw err;
    }
  }
  return null;
}
