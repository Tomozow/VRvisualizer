import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// base is overridden at build time for GitHub Pages: VITE_BASE=/VRvisualizer/ npm run build
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // WebXR needs a secure context on the headset; use `npm run dev -- --https` with mkcert,
    // or a tunnel (ngrok/cloudflared) when developing against a real Quest.
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
