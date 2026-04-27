import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// `base` se setea sólo para builds de producción (GitHub Pages sirve en
// https://vscorza.github.io/rollito-vm/). En dev queda como root.
const REPO_BASE = '/rollito-vm/';

export default defineConfig(({ command }) => ({
  root: 'web',
  base: command === 'build' ? REPO_BASE : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'web/index.html'),
        docs: resolve(__dirname, 'web/docs-viewer.html'),
      },
    },
  },
  server: {
    fs: {
      // Permite que web/main.js importe ../src y ../games/../docs (?raw).
      allow: ['..'],
    },
  },
}));
