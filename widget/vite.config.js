import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    cors: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: 'oyechats-widget.js',
        chunkFileNames: 'oyechats-widget.js',
        // Emit sibling assets with predictable names for script+css embedding.
        assetFileNames: 'oyechats-widget.[ext]',
      }
    }
  }
})
