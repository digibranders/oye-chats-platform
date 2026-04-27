import { defineConfig } from 'vite'

// Loader build: tiny IIFE that customers embed via `<script src="oyechats-widget.js" data-bot-key="...">`.
// Bootstraps the shadow DOM, exposes `window.OyeChats`, and dynamically imports the ESM app bundle.
// Kept separate from the app build so the customer-facing entry stays cacheable and < 5 KB gzipped.

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
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
  },
})
