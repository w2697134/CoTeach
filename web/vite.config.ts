import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    // 几个副本同时开发时各开一套：CT_WEB_PORT 页面端口，CT_API_PORT 接哪个后端（默认 5190 / 18660）
    port: Number(process.env.CT_WEB_PORT || 5190),
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.CT_API_PORT || 18660}`, changeOrigin: false } },
  },
  build: {
    outDir: '../server/dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
