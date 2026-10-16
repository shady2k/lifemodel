import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: appRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@/components/ui': fileURLToPath(new URL('../kit/components/ui', import.meta.url)),
      '@/hooks': fileURLToPath(new URL('../kit/hooks', import.meta.url)),
      '@/lib': fileURLToPath(new URL('../kit/lib', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@kit': fileURLToPath(new URL('../kit', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
