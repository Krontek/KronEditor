import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// Single source of truth for the app version: package.json. Injected at
// build/serve time as the global __APP_VERSION__ (see src/version.js).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    port: parseInt(process.env.VITE_PORT ?? '') || 1420,
    strictPort: true,
    proxy: {
      '/api/host': {
        target: process.env.HOST_AGENT_URL ?? 'http://localhost:7171',
        changeOrigin: true,
        // The frontend polls /api/host/check-server-status every 3s; when the
        // host-agent is not running, default proxy logging floods the terminal.
        // Swallow connection errors quietly and return 503 so the frontend's
        // existing failure-handling path runs as expected.
        configure: (proxy: any) => {
          proxy.on('error', (err: any, _req: any, res: any) => {
            const code = err && err.code;
            if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
              if (res && typeof res.writeHead === 'function' && !res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'host-agent offline' }));
              }
              return; // suppress default console.error
            }
            console.error('[vite proxy]', err);
          });
        },
      },
    },
  },
  // Build output goes into host-agent/dist so the Go embed.FS directive
  // (host-agent/embed.go) can bundle it into the final binary.
  build: {
    outDir: 'host-agent/dist',
    emptyOutDir: true,
  },
  // to make use of `TAURI_DEBUG` and other env variables
  // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
  clearScreen: false,
  // tauri expects a fixed port, fail if that port is not available
  envPrefix: ['VITE_', 'TAURI_'],
})
