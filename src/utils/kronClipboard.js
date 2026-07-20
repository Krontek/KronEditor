// Cross-instance clipboard for KronEditor.
//
// Uses navigator.clipboard (the browser's async clipboard API) so two
// separate browser tabs can exchange POUs, rungs, blocks, and variables.
// Falls back to an in-process cache so copy/paste still works even when
// clipboard permissions are denied entirely.

import { useEffect, useState } from 'react';

const MARKER = '__KRONEDITOR_CLIPBOARD_V1__';

export const CLIP_KIND = {
    POU: 'POU',
    RUNG: 'RUNG',
    BLOCK: 'BLOCK',
    VARIABLE: 'VARIABLE',
    GLOBALS: 'GLOBALS', // the whole global-variable set (sidebar "Global Variables" node)
};

// The current entry is mirrored into localStorage so every same-origin
// window/tab shares it: Firefox never allows a SILENT OS-clipboard read
// (readText() always pops its native "Paste" chip), so cross-window paste
// there rides this mirror instead — the 'storage' event syncs it live and
// permission-free. The OS clipboard is still written on every copy, so
// pasting into external programs (or another browser) keeps working.
const STORE_KEY = '__KRONEDITOR_CLIPBOARD_STORE_V1__';

let fallbackEntry = null;
try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (stored && stored.kind) fallbackEntry = stored;
} catch { /* storage unavailable — in-memory cache still works */ }

const setCache = (entry) => {
    fallbackEntry = entry;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(entry)); } catch { /* ignore */ }
};

const listeners = new Set();

const notify = (entry) => listeners.forEach(cb => { try { cb(entry); } catch { /* ignore */ } });

// Live cross-window sync: 'storage' fires in every OTHER same-origin window
// when setCache writes the mirror.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key !== STORE_KEY) return;
        try {
            const entry = JSON.parse(e.newValue || 'null');
            if (entry && entry.kind) { fallbackEntry = entry; notify(entry); }
        } catch { /* ignore */ }
    });
}

const encode = (kind, payload, meta = {}) =>
    JSON.stringify({ __marker: MARKER, kind, meta, payload });

const decode = (text) => {
    if (!text || typeof text !== 'string' || text.indexOf(MARKER) < 0) return null;
    try {
        const obj = JSON.parse(text);
        if (obj && obj.__marker === MARKER && obj.kind) return obj;
    } catch { /* ignore */ }
    return null;
};

async function osWrite(text) {
    await navigator.clipboard?.writeText(text);
}

async function osRead() {
    return navigator.clipboard?.readText();
}

// True when reading the OS clipboard will NOT pop any browser UI. Chrome
// exposes a queryable 'clipboard-read' permission; Firefox (and Safari)
// throw on that query — there readText() ALWAYS shows a native "Paste"
// confirmation chip at the cursor, so a silent read is never possible.
async function canReadSilently() {
    try {
        const st = await navigator.permissions.query({ name: 'clipboard-read' });
        return st.state === 'granted';
    } catch {
        return false;
    }
}

// Passive read for UI that must never trigger a permission prompt or the
// Firefox/Safari paste chip (context-menu builders, focus refresh). Reads
// the OS clipboard only when that is silent; otherwise returns the
// in-process cache. Real paste ACTIONS keep using readClipboard() — a
// browser confirmation is legitimate at the moment the user pastes.
export async function peekClipboard() {
    if (await canReadSilently()) {
        try {
            const decoded = decode(await osRead());
            if (decoded) setCache(decoded);
        } catch { /* keep cache */ }
    }
    return fallbackEntry;
}

export async function writeClipboard(kind, payload, meta = {}) {
    const entry = { kind, meta, payload };
    setCache(entry);
    notify(entry);
    try {
        await osWrite(encode(kind, payload, meta));
    } catch { /* fallback still works within this window */ }
    return entry;
}

// Reads the current entry for an actual paste ACTION.
// - When a silent OS read is possible (Chrome with 'clipboard-read' granted)
//   the OS clipboard stays the source of truth.
// - Otherwise (Firefox/Safari) the localStorage-synced cache is preferred, so
//   same-browser cross-window paste needs no native "Paste" chip. The
//   prompting OS read remains the LAST RESORT for an empty cache — a fresh
//   profile, or a copy made in a different browser (the only case where the
//   mirror can be missing while the OS clipboard holds a Kron entry).
export async function readClipboard() {
    if (await canReadSilently()) {
        try {
            const decoded = decode(await osRead());
            if (decoded) {
                setCache(decoded);
                return decoded;
            }
        } catch { /* fall through to cache */ }
        return fallbackEntry;
    }
    if (fallbackEntry) return fallbackEntry;
    try {
        const decoded = decode(await osRead());
        if (decoded) setCache(decoded);
    } catch { /* ignore */ }
    return fallbackEntry;
}

// Refreshes the cached entry from the system clipboard WITHOUT triggering
// browser UI (see peekClipboard) and notifies subscribers. Called while
// opening context menus — an eager readText() here made Firefox pop its
// native "Paste" chip on every right-click and delayed the app menu until
// the chip was dismissed. Returns the current entry (may be null).
export async function refreshClipboard() {
    const entry = await peekClipboard();
    notify(entry);
    return entry;
}

// React hook — subscribes to clipboard changes. Refreshes on mount,
// on window focus, and when the tab becomes visible. Also re-reads
// on demand via the returned `refresh` function.
export function useKronClipboard() {
    const [entry, setEntry] = useState(fallbackEntry);

    useEffect(() => {
        let cancelled = false;
        const set = (e) => { if (!cancelled) setEntry(e); };
        listeners.add(set);

        const refresh = async () => {
            const entry = await peekClipboard();
            if (!cancelled && entry) set(entry);
        };
        refresh();
        const onFocus = () => refresh();
        const onVis = () => { if (!document.hidden) refresh(); };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVis);

        return () => {
            cancelled = true;
            listeners.delete(set);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, []);

    return entry;
}
