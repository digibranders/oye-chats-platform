import { test, expect } from '@playwright/test'

// How the widget arrives on a customer's page. A first-visit trace of the
// production widget (2026-09-17) found three things these tests now pin:
//   - the loader fetched manifest.json on every page view (~0.5 s, uncached);
//   - the stylesheet was requested only after the app JS had run;
//   - React rendered before that stylesheet applied, so the launcher appeared
//     as an unstyled button inside the page, then jumped into its corner
//     (CLS 0.066 desktop, 0.077 mobile).

const API = 'http://oyechats-load.test'
const CSS = /\/app\/oyechats-app\.[^/]+\.css$/

async function stubApi(page) {
  await page.addInitScript(({ api }) => {
    window.OYECHATS_API_URL = api
    sessionStorage.setItem('oyechats_greeting_dismissed', '1')
  }, { api: API })
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
  await page.route(`${API}/bots/settings/public*`, (route) => route.fulfill({ json: {
    bot_name: 'Acme Assistant', launcher_name: 'Ask Acme', primary_color: '#2563eb',
    language_config: { enabled: false },
  } }))
}

const launcherIn = (page) =>
  page.locator('#oyechats-widget-root').getByRole('button', { name: 'Ask Acme', exact: true })

test('the loader does not fetch manifest.json', async ({ page }) => {
  await stubApi(page)
  const requested = []
  page.on('request', (req) => requested.push(req.url()))
  await page.goto('/')
  await expect(launcherIn(page)).toBeVisible()
  expect(requested.filter((u) => u.includes('/app/manifest.json'))).toEqual([])
})

test('the stylesheet is requested before the app entry has finished loading', async ({ page }) => {
  await stubApi(page)
  const order = []
  page.on('request', (req) => {
    if (CSS.test(req.url())) order.push('css:requested')
  })
  page.on('requestfinished', (req) => {
    if (/oyechats-app-entry\./.test(req.url())) order.push('entry:finished')
  })
  await page.goto('/')
  await expect(launcherIn(page)).toBeVisible()
  expect(order.indexOf('css:requested')).toBeGreaterThanOrEqual(0)
  expect(order.indexOf('css:requested')).toBeLessThan(order.indexOf('entry:finished'))
})

test('nothing renders, and the page does not move, until the stylesheet applies', async ({ page }) => {
  await stubApi(page)
  await page.addInitScript(() => {
    window.__shifts = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts.push(e.value)
    }).observe({ type: 'layout-shift', buffered: true })
  })
  let release
  const held = new Promise((resolve) => { release = resolve })
  await page.route(CSS, async (route) => { await held; await route.continue() })

  // The held stylesheet also holds the page's load event.
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.getElementById('oyechats-widget-root')?.shadowRoot)
  // Long enough for the app JS to load and, before this fix, render.
  await page.waitForFunction(() => typeof window.OyeChats?.diagnose === 'function' && window.OyeChats.diagnose() != null)

  const host = page.locator('#oyechats-widget-root')
  await expect(host).toHaveCSS('position', 'fixed')
  await expect(host).toHaveCSS('width', '0px')
  await expect(page.locator('#oyechats-widget-root .oyechats-launcher')).toHaveCount(0)
  const heightWhileHeld = await page.evaluate(() => document.documentElement.scrollHeight)

  release()
  await expect(launcherIn(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(heightWhileHeld)
  // The launcher fades in for 240 ms; let any shift it might cause be recorded.
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => window.__shifts.reduce((a, b) => a + b, 0))).toBe(0)
})

test('a stylesheet that fails to load leaves the page untouched and reports an error', async ({ page }) => {
  await stubApi(page)
  await page.addInitScript(() => {
    window.__errors = []
    const register = () => {
      if (!window.OyeChats) { setTimeout(register, 5); return }
      window.OyeChats.on('error', (e) => window.__errors.push(e))
    }
    register()
  })
  await page.route(CSS, (route) => route.fulfill({ status: 404, body: '' }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__errors.length)).toBe(1)
  expect(await page.evaluate(() => window.__errors[0].source)).toBe('stylesheet')
  await expect(page.locator('#oyechats-widget-root .oyechats-launcher')).toHaveCount(0)
  await expect(page.locator('#oyechats-widget-root')).toHaveCSS('position', 'fixed')
})

test('a ready handler registered after the widget mounted is still called', async ({ page }) => {
  await stubApi(page)
  await page.goto('/')
  await expect(launcherIn(page)).toBeVisible()
  const payload = await page.evaluate(() => new Promise((resolve) => {
    window.OyeChats.on('ready', resolve)
    setTimeout(() => resolve('not called'), 2000)
  }))
  expect(payload).toEqual(expect.objectContaining({ version: expect.any(String) }))
})
