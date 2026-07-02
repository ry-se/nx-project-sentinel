/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path'

export default defineConfig({
  root: import.meta.dirname,
  // Vite's default envDir is `root` (this dir) — the repo's .env/.env.example live at
  // the monorepo root and are shared with the backend, so point Vite there too.
  // Without this, VITE_-prefixed vars in the root .env were silently never loaded.
  envDir: path.resolve(import.meta.dirname, '../..'),
  cacheDir: '../../node_modules/.vite/frontend',
  resolve: {
    alias: {
      '@/constants': path.resolve(__dirname, './src/constants')
    }
  },

  server: {
    port: 4200,
    host: '0.0.0.0',
    allowedHosts: ['localhost', 'frontend'],
  },

  preview: {
    port: 4200,
    host: '0.0.0.0',
  },

  plugins: [react(), tailwindcss()],

  build: {
    outDir: './dist/apps/frontend',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },

  test: {
    name: '@org/frontend',
    watch: false,
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
});
