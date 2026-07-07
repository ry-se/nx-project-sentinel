/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import type { Plugin } from 'vite';

const INITIAL_PRELOAD_DENYLIST = /^(vendor-three|vendor-tiles|WorldView|IntelImport|DetectDebug|detections|renderDetectionBox)-/;
const CHUNK_BUDGETS: Array<{ pattern: RegExp; maxKb: number }> = [
  { pattern: /^index-.*\.js$/, maxKb: 260 },
  { pattern: /^WorldView-.*\.js$/, maxKb: 950 },
  { pattern: /^IntelImport-.*\.js$/, maxKb: 30 },
  { pattern: /^DetectDebug-.*\.js$/, maxKb: 30 },
  { pattern: /^detections-.*\.js$/, maxKb: 40 },
  { pattern: /^renderDetectionBox-.*\.js$/, maxKb: 10 },
  { pattern: /^vendor-icons-.*\.js$/, maxKb: 30 },
];

type BundleEntry =
  | { type: 'asset'; fileName: string; source: string | Uint8Array }
  | {
      type: 'chunk';
      fileName: string;
      code: string;
      imports?: string[];
      isEntry?: boolean;
    };

function enforceBundleBudgets(): Plugin {
  return {
    name: 'sentinel-bundle-budgets',
    generateBundle(_options, bundle): void {
      assertNoInitialLazyPreloads(bundle);
      assertNoInitialLazyStaticImports(bundle);
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        assertChunkBudget(chunk);
      }
    },
  };
}

function assertNoInitialLazyPreloads(bundle: Record<string, BundleEntry>): void {
  const html = bundle['index.html'];
  if (!html || html.type !== 'asset' || typeof html.source !== 'string') return;
  const forbidden = html.source.match(/assets\/(?:vendor-three|vendor-tiles|WorldView|IntelImport|DetectDebug|detections|renderDetectionBox)-[^"]+\.js/g);
  if (forbidden) {
    throw new Error(`Initial HTML preloads lazy sandbox chunks: ${forbidden.join(', ')}`);
  }
}

function assertNoInitialLazyStaticImports(bundle: Record<string, BundleEntry>): void {
  const entryFileNames = getInitialEntryFileNames(bundle);
  const visited = new Set<string>();
  const forbiddenChains: string[] = [];

  for (const entryFileName of entryFileNames) {
    visitStaticImports(entryFileName, [entryFileName], bundle, visited, forbiddenChains);
  }

  if (forbiddenChains.length > 0) {
    throw new Error(`Initial entry imports lazy sandbox chunks: ${forbiddenChains.join(', ')}`);
  }
}

function getInitialEntryFileNames(bundle: Record<string, BundleEntry>): string[] {
  const entryFileNames = Object.values(bundle)
    .filter(
      (entry): entry is Extract<BundleEntry, { type: 'chunk' }> =>
        entry.type === 'chunk' && entry.isEntry === true
    )
    .map((entry) => entry.fileName);
  if (entryFileNames.length > 0) return entryFileNames;

  const html = bundle['index.html'];
  if (!html || html.type !== 'asset' || typeof html.source !== 'string') return [];

  return Array.from(html.source.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g))
    .map((match) => match[1].replace(/^\/+/, ''))
    .filter((fileName) => bundle[fileName]?.type === 'chunk');
}

function visitStaticImports(
  fileName: string,
  chain: string[],
  bundle: Record<string, BundleEntry>,
  visited: Set<string>,
  forbiddenChains: string[]
): void {
  if (visited.has(fileName)) return;
  visited.add(fileName);

  const entry = bundle[fileName];
  if (!entry || entry.type !== 'chunk') return;

  for (const importedFileName of entry.imports ?? []) {
    const nextChain = [...chain, importedFileName];
    if (isInitialDenylistedChunk(importedFileName)) {
      forbiddenChains.push(nextChain.join(' -> '));
    }
    visitStaticImports(importedFileName, nextChain, bundle, visited, forbiddenChains);
  }
}

function assertChunkBudget(chunk: Extract<BundleEntry, { type: 'chunk' }>): void {
  const budget = CHUNK_BUDGETS.find((entry) => entry.pattern.test(chunk.fileName));
  if (!budget) return;
  const sizeKb = Buffer.byteLength(chunk.code, 'utf8') / 1024;
  if (sizeKb > budget.maxKb) {
    throw new Error(
      `${chunk.fileName} is ${sizeKb.toFixed(1)} kB, above budget ${budget.maxKb} kB`
    );
  }
}

function isInitialDenylistedChunk(fileName: string): boolean {
  const baseName = fileName.split('/').pop() ?? fileName;
  return INITIAL_PRELOAD_DENYLIST.test(baseName);
}

export default defineConfig({
  root: import.meta.dirname,
  // Vite's default envDir is `root` (this dir) — the repo's .env/.env.example live at
  // the monorepo root and are shared with the backend, so point Vite there too.
  // Without this, VITE_-prefixed vars in the root .env were silently never loaded.
  envDir: path.resolve(import.meta.dirname, '../..'),
  cacheDir: '../../node_modules/.vite/frontend',
  resolve: {
    alias: [
      { find: '@/constants/', replacement: path.resolve(__dirname, './src/constants/') },
      { find: '@/constants', replacement: path.resolve(__dirname, './src/constants') },
    ],
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

  plugins: [react(), tailwindcss(), enforceBundleBudgets()],

  build: {
    outDir: './dist/apps/frontend',
    emptyOutDir: true,
    reportCompressedSize: true,
    // The 3D sandbox stack is intentionally isolated behind the lazy WorldView route.
    // Per-chunk budgets above keep the app shell strict while allowing that route chunk.
    chunkSizeWarningLimit: 950,
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('vite/preload-helper')) return 'vite-preload-helper';
          if (id.includes('/node_modules/lucide-react/')) return 'vendor-icons';
          return undefined;
        },
      },
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },

  test: {
    name: '@org/frontend',
    watch: false,
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    setupFiles: ['./src/test-setup.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
});
