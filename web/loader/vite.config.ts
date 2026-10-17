import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@kit': fileURLToPath(new URL('../kit', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
