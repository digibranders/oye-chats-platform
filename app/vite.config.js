import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { oyechatsPwaPlugin } from './plugins/vite-plugin-oyechats-pwa.js'

// https://vite.dev/config/
export default defineConfig({
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
