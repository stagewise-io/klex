import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Tauri serves the dev build from this fixed port (src-tauri/tauri.conf.json).
export default defineConfig({
  clearScreen: false,
  plugins: [tailwindcss()],
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: ['es2022', 'chrome110', 'safari16'] },
});
