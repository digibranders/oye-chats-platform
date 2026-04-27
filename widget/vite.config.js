import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-server config only. Production builds use vite.loader.config.js + vite.app.config.js
// (see `npm run build`). Keeping this file so `npm run dev` stays a one-command flow.

export default defineConfig({
  plugins: [react()],
  server: {
    cors: true,
  },
  define: {
    __WIDGET_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
    __WIDGET_BUILD__: JSON.stringify('dev'),
    __WIDGET_BASE__: JSON.stringify('/'),
  },
})
