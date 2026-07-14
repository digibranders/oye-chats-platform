import { defineConfig } from 'vite'
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
  server: {
    port: 5174,
    strictPort: true,
  },
})
