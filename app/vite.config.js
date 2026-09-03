import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { oyechatsPwaPlugin } from './plugins/vite-plugin-oyechats-pwa.js'

/**
 * Identifies this build to the client.
 *
 * CI sets GITHUB_SHA; a local build falls back to the clock. Its only job is to
 * change on every deploy, which is what makes it usable as a cache key.
 */
const BUILD_ID = (process.env.GITHUB_SHA ?? '').slice(0, 12) || String(Date.now());

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    tailwindcss(),
    oyechatsPwaPlugin(),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  build: {
    rolldownOptions: {
      output: {
        minify: {
          compress: {
            dropConsole: true,
            dropDebugger: true,
          },
        },
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
})
