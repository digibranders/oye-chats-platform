import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { chunksFromManifest } from './src/lib/manifestChunks.js'

// Loader build: tiny IIFE that customers embed via `<script src="oyechats-widget.js" data-bot-key="...">`.
// Bootstraps the shadow DOM, exposes `window.OyeChats`, and dynamically imports the ESM app bundle.
// Kept separate from the app build so the customer-facing entry stays cacheable and < 5 KB gzipped.
//
// Runs after the app build (`npm run build`), so the app's chunk names can be
// baked in and the loader skips fetching manifest.json on every page view.
// The deploy workflow fails if a built loader does not carry them.
const APP_MANIFEST = new URL('./dist/app/manifest.json', import.meta.url)
const builtChunks = existsSync(APP_MANIFEST)
  ? chunksFromManifest(JSON.parse(readFileSync(APP_MANIFEST, 'utf8')))
  : null

export default defineConfig({
  esbuild: {
    drop: ['console', 'debugger'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: !!process.env.VITE_SOURCEMAP,
    target: 'es2020',
    minify: 'esbuild',
    lib: {
      entry: 'src/loader.js',
      name: 'OyeChatsLoader',
      formats: ['iife'],
      fileName: () => 'oyechats-widget.js',
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
  define: {
    __WIDGET_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
    __WIDGET_BUILD__: JSON.stringify(process.env.VITE_BUILD_TIMESTAMP || new Date().toISOString()),
    __WIDGET_BASE__: JSON.stringify(process.env.VITE_WIDGET_BASE || ''),
    __OYECHATS_CHUNKS__: JSON.stringify(builtChunks),
  },
})
