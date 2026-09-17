import { test, expect } from '@playwright/test'

// The Content-Security-Policy the dashboard tells customers to set:
// script-src and style-src for the widget's origin, connect-src for the API.
// The widget must work with exactly that and nothing looser: no inline
// styles, no inline scripts, no other hosts.
//
// Two widget origins are in play here. `vite preview` serves the loader and
// chunks from this page's origin ('self'). CI builds with
// VITE_WIDGET_BASE=https://cdn.oyechats.com/, so the app's preload hints for
// lazy chunks point at the production CDN.

const API = 'http://oyechats-csp.test'
const WIDGET_ORIGINS = "'self' https://cdn.oyechats.com"
const HOST_PATH = '/csp-host.html'
const HOST_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CSP host</title></head>
<body><h1>Acme</h1>
<script async src="/oyechats-widget.js" data-bot-key="bot-DEV"></script>
</body></html>`

const policy = ({ styleSrc }) =>
  `default-src 'none'; script-src ${WIDGET_ORIGINS}; style-src ${styleSrc}; connect-src ${API}`

async function boot(page, csp) {
  await page.addInitScript(({ api }) => {
    window.OYECHATS_API_URL = api
    window.__violations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`)
    })
    window.__errors = []
    const register = () => {
      if (!window.OyeChats) { setTimeout(register, 5); return }
      window.OyeChats.on('error', (e) => window.__errors.push(e.source))
    }
    register()
  }, { api: API })
  await page.route(`**${HOST_PATH}`, (route) => route.fulfill({
    contentType: 'text/html',
    headers: { 'Content-Security-Policy': csp },
    body: HOST_HTML,
  }))
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
  await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: [] }))
  await page.route(`${API}/bots/settings/public*`, (route) => route.fulfill({ json: {
    bot_name: 'Acme Assistant', launcher_name: 'Ask Acme', primary_color: '#2563eb',
    language_config: { enabled: false }, lead_form_enabled: true,
  } }))
  await page.goto(HOST_PATH)
}

test('the documented policy is enough: the widget renders, opens and shows its lead form', async ({ page }) => {
  await boot(page, policy({ styleSrc: WIDGET_ORIGINS }))
  const root = page.locator('#oyechats-widget-root')
  const launcher = root.getByRole('button', { name: 'Ask Acme', exact: true })
  await expect(launcher).toBeVisible()
  await launcher.click()
  await expect(root.locator('form input').first()).toBeVisible()
  expect(await page.evaluate(() => window.__violations)).toEqual([])
})

test('without style-src the widget stays hidden rather than rendering unstyled', async ({ page }) => {
  await boot(page, policy({ styleSrc: "'none'" }))
  await expect.poll(() => page.evaluate(() => window.__errors)).toEqual(['stylesheet'])
  await expect(page.locator('#oyechats-widget-root .oyechats-launcher')).toHaveCount(0)
  const violations = await page.evaluate(() => window.__violations)
  expect(violations.some((v) => v.startsWith('style-src'))).toBe(true)
})
