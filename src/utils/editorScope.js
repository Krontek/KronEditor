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
};

export function setEditorScope(s) { scope = s; }
export function getEditorScope() { return scope; }
