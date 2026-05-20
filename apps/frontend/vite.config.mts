/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'node:path';

const cesiumSource = path.resolve(
  import.meta.dirname,
  '../../node_modules/cesium/Build/Cesium'
);

const cesiumBaseUrl = 'cesium';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/frontend',

  define: {
    CESIUM_BASE_URL: JSON.stringify(`/cesium`),
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

  plugins: [
    react(),
    tailwindcss(),
    // viteStaticCopy({
    //   targets: [
    //     {
    //       src: path.join(cesiumSource, 'Workers'),
    //       dest: cesiumBaseUrl,
    //     },
    //     {
    //       src: path.join(cesiumSource, 'ThirdParty'),
    //       dest: cesiumBaseUrl,
    //     },
    //     {
    //       src: path.join(cesiumSource, 'Assets'),
    //       dest: cesiumBaseUrl,
    //     },
    //     {
    //       src: path.join(cesiumSource, 'Widgets'),
    //       dest: cesiumBaseUrl,
    //     },
    //   ],
    // }),
  ],

  build: {
    outDir: '../../dist/apps/frontend',
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
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
});