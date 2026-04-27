import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

// App build: ESM bundle with code-splitting. Loaded dynamically by the loader IIFE.
// Emits a manifest.json so the loader can find the hashed entry chunk at runtime.

const widgetBase = process.env.VITE_WIDGET_BASE || './'

export default defineConfig({
  plugins: [
    react(),
    visualizer({
      filename: 'dist/app/stats.html',
      gzipSize: true,
      brotliSize: true,
      template: 'treemap',
    }),
  ],
  base: widgetBase,
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2020',
    cssCodeSplit: false,
    manifest: 'manifest.json',
    rollupOptions: {
      input: 'src/app-entry.jsx',
      // Force Rollup to keep the entry's named exports (init/default) intact —
      // the loader dynamically imports the entry chunk via fetch+import(), which
      // Rollup can't trace, so without this it tree-shakes the public exports.
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: 'oyechats-app.[hash].js',
        chunkFileNames: 'oyechats-[name].[hash].js',
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || ''
          if (name.endsWith('.css')) return 'oyechats-app.[hash].css'
          return 'oyechats-app.[hash].[ext]'
        },
        manualChunks(id) {
          // Vendor — React, ReactDOM, scheduler, axios. Shared across all UI chunks.
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/') ||
            id.includes('node_modules/axios/')
          ) {
            return 'vendor'
          }
          // Core services — used by both the FAB (eager) and chat (lazy).
          // Co-locating with vendor keeps the chat chunk truly chat-only,
          // so it only loads on first widget open.
          if (id.includes('/widget-controller') || id.includes('/services/api') || id.includes('/services/sanitize') || id.includes('/services/sentinelStripper')) {
            return 'vendor'
          }
          // Sentry is heavy and only loaded on first error or when OYECHATS_DEBUG=true.
          if (id.includes('node_modules/@sentry/')) {
            return 'sentry'
          }
          // Markdown rendering — only used in chat bubbles, lazy with chat chunk.
          if (
            id.includes('node_modules/react-markdown/') ||
            id.includes('node_modules/micromark') ||
            id.includes('node_modules/mdast') ||
            id.includes('node_modules/unist') ||
            id.includes('node_modules/hast') ||
            id.includes('node_modules/remark') ||
            id.includes('node_modules/rehype') ||
            id.includes('node_modules/decode-named-character-reference') ||
            id.includes('node_modules/character-entities') ||
            id.includes('node_modules/property-information') ||
            id.includes('node_modules/space-separated-tokens') ||
            id.includes('node_modules/comma-separated-tokens') ||
            id.includes('node_modules/devlop')
          ) {
            return 'markdown'
          }
          // Chat / live chat / forms are NOT manually-chunked — Vite/Rollup
          // auto-splits them based on the React.lazy(() => import(...)) call sites.
          // This avoids cross-chunk helper sharing that would otherwise pull
          // chat into the eager-load graph.
        },
      },
    },
  },
  define: {
    __WIDGET_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
    __WIDGET_BUILD__: JSON.stringify(process.env.VITE_BUILD_TIMESTAMP || new Date().toISOString()),
    __WIDGET_BASE__: JSON.stringify(widgetBase),
  },
})
