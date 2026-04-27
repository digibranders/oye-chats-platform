// Copies dev/host.html → dist/index.html so `npx vite preview` serves the
// fixture at http://localhost:4173/ for manual verification of the widget.
// Also writes a tiny .well-known/no-cors-test.txt so we can verify CORS
// headers are set correctly when the dist is served behind a CDN.

import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const widgetRoot = join(__dirname, '..')

const src = join(widgetRoot, 'dev', 'host.html')
const dest = join(widgetRoot, 'dist', 'index.html')

if (!existsSync(src)) {
  console.error(`[copy-host-fixture] source not found: ${src}`)
  process.exit(1)
}

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[copy-host-fixture] copied ${src} → ${dest}`)

// Marker file for CORS verification — fetch this from a different origin to
// confirm the CDN serves the right Access-Control-Allow-Origin header.
const wellKnownDir = join(widgetRoot, 'dist', '.well-known')
mkdirSync(wellKnownDir, { recursive: true })
writeFileSync(join(wellKnownDir, 'cors-test.txt'), 'ok\n')
