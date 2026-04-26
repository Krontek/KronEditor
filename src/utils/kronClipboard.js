// Cross-instance clipboard for KronEditor.
//
// Writes payloads to the OS clipboard as JSON tagged with a marker, so two
// separate editor windows (different processes) can exchange POUs, rungs,
// blocks, and variables via copy/paste. Also keeps an in-process fallback
// so copy/paste works even when clipboard permissions are denied.

import { useEffect, useState } from 'react';

const MARKER = '__KRONEDITOR_CLIPBOARD_V1__';

export const CLIP_KIND = {
    POU: 'POU',
    RUNG: 'RUNG',
    BLOCK: 'BLOCK',
    VARIABLE: 'VARIABLE',
};

let fallbackEntry = null;
const listeners = new Set();

const notify = (entry) => listeners.forEach(cb => { try { cb(entry); } catch { /* ignore */ } });

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

export async function writeClipboard(kind, payload, meta = {}) {
    const entry = { kind, meta, payload };
    fallbackEntry = entry;
    notify(entry);
    try {
        await navigator.clipboard?.writeText(encode(kind, payload, meta));
    } catch { /* permission / focus issues: fallback still works within this window */ }
    return entry;
}

export async function readClipboard() {
    try {
        const text = await navigator.clipboard?.readText();
        const decoded = decode(text);
        if (decoded) {
            fallbackEntry = decoded;
            return decoded;
        }
    } catch { /* permissions: fall through to in-process fallback */ }
    return fallbackEntry;
}

// Refreshes the cached entry by reading the system clipboard.
// Returns the current entry (may be null).
export async function refreshClipboard() {
    const entry = await readClipboard();
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
            try {
                const text = await navigator.clipboard?.readText();
                const decoded = decode(text);
                if (decoded) {
                    fallbackEntry = decoded;
                    set(decoded);
                }
            } catch { /* ignore */ }
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
