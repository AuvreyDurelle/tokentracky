import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The town screens against a fake API, for packages/town/bench/drive.mjs. Never part of the app's build.
export default defineConfig({root: fileURLToPath(new URL('.', import.meta.url)), base: './', esbuild: {jsx: 'automatic'}, build: {outDir: '../../../.cache/town-bench', emptyOutDir: true}});
