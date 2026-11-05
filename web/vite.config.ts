import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5190,
    proxy: { '/api': { target: 'http://127.0.0.1:18660', changeOrigin: false } },
  },
  build: {
    outDir: '../server/dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
