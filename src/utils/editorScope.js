// Tracks which editor panel the user most recently interacted with, so
// global Ctrl+C / Ctrl+V handlers can dispatch copy/paste to the correct
// target instead of all firing at once and racing on the shared clipboard.
//
// Panels update the scope with `onMouseDown` on their root element; their
// key handlers check `getEditorScope()` and bail if it does not match.

let scope = null;

export const EDITOR_SCOPE = {
    SIDEBAR: 'sidebar',
    LD: 'ld',
    VARIABLES: 'variables',
    AGENT: 'agent',
};

export function setEditorScope(s) { scope = s; }
export function getEditorScope() { return scope; }

// ⚠️ True when the user has actually selected text. Every global Ctrl+C handler
// MUST bail on this: a selection means the user is copying TEXT, and hijacking
// that to copy a POU / rung / variable set silently replaces what they wanted
// with something else. This is not covered by the INPUT/TEXTAREA/monaco focus
// guards — selecting text in a plain <div> (an agent chat bubble, an error
// message, a diff line) leaves focus on <body>, so those checks all pass and the
// handler fires. That is exactly how Ctrl+C in the agent panel used to copy the
// selected POU instead of the highlighted text.
export function hasTextSelection() {
    try {
        const sel = window.getSelection();
        return !!sel && !sel.isCollapsed && String(sel).trim() !== '';
    } catch { return false; }
}
