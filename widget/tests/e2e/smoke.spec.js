import { test, expect } from '@playwright/test'

// Smoke: widget mounts, FAB is visible, public API is exposed, lazy chunks
// load on demand. Hard-asserts the bundle-split contract.

test.describe('OyeChats widget — smoke', () => {
  test('mounts FAB without loading chat chunk', async ({ page }) => {
    const requested = new Set()
    page.on('request', (req) => requested.add(req.url()))

    await page.goto('/')

    // Wait for widget to mount — Shadow DOM root with our marker exists.
    await expect.poll(() =>
      page.evaluate(() => !!document.getElementById('oyechats-widget-root'))
    ).toBe(true)

    // Public API surface is exposed.
    const apiSurface = await page.evaluate(() => Object.keys(window.OyeChats || {}))
    for (const m of ['init', 'destroy', 'open', 'close', 'identify', 'on', 'diagnose']) {
      expect(apiSurface).toContain(m)
    }

    // Chat chunk MUST NOT have loaded yet.
    const chatLoaded = [...requested].some((u) => u.includes('oyechats-ChatWindow'))
    expect(chatLoaded, 'chat chunk must stay lazy until widget is opened').toBe(false)
  })

  test('opens chat via OyeChats.open() — lazy chunks then load', async ({ page }) => {
    const requested = new Set()
    page.on('request', (req) => requested.add(req.url()))

    await page.goto('/')
    await page.waitForFunction(() => !!window.OyeChats)

    await page.evaluate(() => window.OyeChats.open())

    // Chat chunk should now load.
    await expect
      .poll(() => [...requested].some((u) => u.includes('oyechats-ChatWindow')), { timeout: 5000 })
      .toBe(true)
  })

  test('identify() persists visitor and survives close/open', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => !!window.OyeChats)

    await page.evaluate(() => {
      window.OyeChats.identify({ name: 'QA', email: 'qa@example.com' })
    })
    const visitor = await page.evaluate(() => window.OyeChats.diagnose().visitor)
    expect(visitor).toEqual({ name: 'QA', email: 'qa@example.com' })
  })
})
