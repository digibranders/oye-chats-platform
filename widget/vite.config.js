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
        assetFileNames: 'oyechats-widget.[ext]',
      }
    }
  }
})
