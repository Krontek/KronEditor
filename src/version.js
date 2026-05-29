// App version — single source of truth is package.json. Vite replaces the
// __APP_VERSION__ token at build/serve time (see vite.config.ts `define`).
// Use this everywhere a version is shown so it never drifts out of sync.
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
