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

// Retained File System Access handle for the currently-open project file. When
// set, Save (saveAs=false) writes straight back to it with no picker — a real
// in-place Save. Cleared on New Project / Pull-from-Target so the next Save
// correctly behaves as Save As. null when the browser lacks the FSA API
// (e.g. Firefox) — there we fall back to activeAgentPath below.
let activeHandle = null;

// Absolute path of the currently-open project file, used when the browser has
// no File System Access API (Firefox). Save (saveAs=false) writes straight
// back to this path via the host-agent, with no prompt — the in-place Save
// equivalent of activeHandle. Set by openFile()/saveFile() in the agent-path
// branch; cleared together with activeHandle.
let activeAgentPath = null;

export function clearActiveFileHandle() {
  activeHandle = null;
  activeAgentPath = null;
}

// A modal UI (registered by the app shell) that lets the user browse the
// local filesystem via the host-agent and pick/confirm a path. Needed because
// Firefox implements neither showOpenFilePicker nor showSaveFilePicker, so
// there is no native dialog to fall back to.
let pathPickerImpl = null;

export function registerPathPicker(fn) {
  pathPickerImpl = fn;
}

// opts: { mode: 'open'|'save', suggestedName?, initialPath? }
// Resolves to an absolute path string, or null if the user cancelled.
async function promptForPath(opts) {
  if (!pathPickerImpl) return null;
  return pathPickerImpl(opts);
}

// Ensure we hold the requested permission on a handle, prompting once if needed.
async function verifyPermission(handle, writable) {
  if (!handle || typeof handle.queryPermission !== 'function') return true;
  const opts = { mode: writable ? 'readwrite' : 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/**
 * Show an "open file" picker. Returns `null` if the user cancelled, otherwise
 * `{ name, path, content }`. `path` is an absolute filesystem path when
 * available (FSA handle name, or the host-agent browse dialog on Firefox) —
 * pass it to processFileContent as the filePath argument.
 *
 * Prefers showOpenFilePicker so the returned handle can be reused for in-place
 * Save. Falls back to the host-agent browse dialog (registerPathPicker) which
 * also yields a real path, so Save still works in-place afterwards. Falls
 * back further to <input type=file> only if no picker is registered (no
 * handle, no path → Save acts as Save As via a download).
 */
export async function openFile({ accept = '.xml' } = {}) {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'KronEditor project', accept: { 'application/xml': ['.xml'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      const content = await file.text();
      activeHandle = handle; // reuse for subsequent in-place Save
      activeAgentPath = null;
      return { name: handle.name, path: handle.name, content };
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) return null;
      // Fall through to the host-agent / <input> path on any other failure.
    }
  }

  if (pathPickerImpl) {
    const path = await promptForPath({ mode: 'open' });
    if (!path) return null;
    const content = await host.readFile(path);
    activeHandle = null;
    activeAgentPath = path;
    return { name: path.split(/[/\\]/).pop(), path, content };
  }

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
      reader.onload = (e) => {
        activeHandle = null; // no writable handle from <input> → Save = Save As
        activeAgentPath = null;
        resolve({ name: file.name, path: file.name, content: String(e.target.result) });
      };
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

// Write content to an already-held handle. Returns its name, or null if the
// permission was denied / the write failed (caller then falls back to picker).
async function writeToHandle(handle, content) {
  try {
    if (!(await verifyPermission(handle, true))) return null;
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return handle.name;
  } catch {
    return null;
  }
}

/**
 * Save the current project.
 *  - saveAs=false (Save): if we hold the open file's handle or a known agent
 *    path, write straight back to it with NO picker (true in-place Save).
 *    Otherwise behaves like Save As.
 *  - saveAs=true (Save As): always shows a picker and adopts the chosen target.
 * Falls back to a triggered download only when neither the File System Access
 * API nor the host-agent browse dialog is available.
 * Returns the saved filename/path (or null if the user cancelled the picker).
 */
export async function saveFile({ suggestedName = 'project.xml', content, saveAs = false }) {
  // Plain Save with a known target → overwrite it silently.
  if (!saveAs && activeHandle) {
    const name = await writeToHandle(activeHandle, content);
    if (name) return name;
    // Permission lost / handle stale → fall through to the picker below.
  }
  if (!saveAs && activeAgentPath) {
    try {
      await host.writeFile(activeAgentPath, content);
      return activeAgentPath;
    } catch {
      // Path no longer writable → fall through to the picker below.
    }
  }

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
      activeHandle = handle; // remember it so later Saves overwrite in place
      activeAgentPath = null;
      return handle.name;
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) return null;
      // Fall through to the host-agent / download path
    }
  }

  // Firefox (no FSA API): browse + confirm a real path via the host-agent,
  // then write directly to disk — this is what fixes Save/Save As always
  // landing in the Downloads folder.
  if (pathPickerImpl) {
    const path = await promptForPath({ mode: 'save', suggestedName, initialPath: activeAgentPath });
    if (!path) return null;
    await host.writeFile(path, content);
    activeHandle = null;
    activeAgentPath = path;
    return path;
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
