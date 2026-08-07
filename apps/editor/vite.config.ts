// Note: defineConfig is imported from 'vitest/config' so the `test` block is typed;
// it is a superset of vite's defineConfig.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Required for SharedArrayBuffer / AudioWorklet in the WebCodecs v2 engine.
// CAUTION: with COEP enabled, media served from R2 MUST be CORS-enabled
// (R2 bucket CORS + <video crossorigin="anonymous">), otherwise it will not load.
// If the M0 R2 CORS smoke test fails, fall back to
// 'Cross-Origin-Embedder-Policy': 'credentialless' (or defer COEP to v2).
// Single source of truth for both `server` (dev) and `preview` (built preview).
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    headers: crossOriginIsolationHeaders,
    proxy: {
      '/api': 'http://localhost:5000',
      // SignalR hub: needs WebSocket proxying.
      '/hubs': { target: 'http://localhost:5000', ws: true },
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
