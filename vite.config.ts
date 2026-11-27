import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web/', import.meta.url)),
  publicDir: false,
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
