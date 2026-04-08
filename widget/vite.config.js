import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    cors: true,
  },
  build: {
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: 'oyechats-widget.js',
        chunkFileNames: 'oyechats-widget.js',
        // CSS is inlined into JS via ?inline import (Shadow DOM injection),
        // so no separate .css file is emitted. Keep pattern for other assets.
        assetFileNames: 'oyechats-widget.[ext]',
      }
    }
  }
})
