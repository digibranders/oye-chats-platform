import { test, expect } from '@playwright/test'

/**
 * Phone guards against the on-screen keyboard. See "Phone layout" in
 * `src/index.css` and the backdrop in `ChatWindow.jsx`.
 *
 * Neither Playwright project can raise a real keyboard, so this pins the two
 * static properties the phone fixes rest on: the font-size floor that stops
 * iOS Safari zooming into the composer, and the full-viewport sheet that hides
 * the host page in the strip the keyboard leaves above itself.
 */
const API = 'http://oyechats-e2e.test'

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ fakeViewport?: boolean }} [opts] With `fakeViewport`, replace
 *   `window.visualViewport` before the widget loads with a plain event target
 *   the test can move and resize, so the panel's viewport listener binds to it.
 */
async function boot(page, { fakeViewport = false } = {}) {
  await page.addInitScript(({ api, fake }) => {
    window.OYECHATS_API_URL = api
    if (fake) {
      const viewport = new EventTarget()
      Object.assign(viewport, {
        height: window.innerHeight,
        width: window.innerWidth,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      })
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    }
  }, { api: API, fake: fakeViewport })
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
  await page.route(`${API}/bots/settings/public*`, (route) =>
    route.fulfill({
      json: { bot_name: 'Acme Bot', primary_color: '#2563eb', language_config: { enabled: false } },
    }),
  )
  await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: [] }))

  await page.goto('/')
  await page.waitForFunction(() => !!window.OyeChats && typeof window.OyeChats.open === 'function')
  await page.evaluate(() => window.OyeChats.open())
  const root = page.locator('#oyechats-widget-root')
  await expect(root.locator('textarea').first()).toBeVisible({ timeout: 15_000 })
  return root
}

const isPhone = () => test.info().project.name === 'mobile'

test.describe('phone keyboard guards', () => {
  test('the composer is at least 16px on a phone so iOS Safari does not zoom into it', async ({ page }) => {
    const root = await boot(page)
    const composer = root.locator('textarea').first()
    const fontSize = await composer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    if (isPhone()) {
      expect(fontSize).toBeGreaterThanOrEqual(16)
    } else {
      // Desktop keeps the tighter composer; the floor is phone-only.
      expect(fontSize).toBe(14)
    }
  })

  test('a sheet in the panel colour fills the viewport behind the panel on a phone', async ({ page }) => {
    const root = await boot(page)
    const backdrop = root.locator('.oyechats-mobile-backdrop')
    await expect(backdrop).toHaveCount(1)

    const box = await backdrop.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        display: style.display,
        position: style.position,
        background: style.backgroundColor,
      }
    })

    if (isPhone()) {
      const viewport = page.viewportSize()
      expect(box.position).toBe('fixed')
      expect(box.top).toBe(0)
      expect(box.left).toBe(0)
      expect(box.width).toBe(viewport.width)
      expect(box.height).toBe(viewport.height)
      expect(box.background).not.toBe('rgba(0, 0, 0, 0)')
    } else {
      expect(box.display).toBe('none')
    }
  })

  test('the panel tracks the visual viewport offset on both axes', async ({ page }) => {
    // A real visual viewport cannot be panned from a test, so the widget is
    // booted against a stand-in that the test moves: Safari zoomed 16/14 into
    // a control and panned 24px right, 40px down. A panel that ignores
    // offsetLeft is the bug that hung it off the left edge of a zoomed page.
    test.skip(!isPhone(), 'JS owns the panel geometry only in the phone layout')
    const root = await boot(page, { fakeViewport: true })
    const panel = root.locator('[data-oyechats-panel]')
    await expect.poll(() => panel.evaluate((el) => el.style.left)).toBe('0px')

    await page.evaluate(() => {
      Object.assign(window.visualViewport, { height: 300, width: 341, offsetTop: 40, offsetLeft: 24, scale: 1.14 })
      window.visualViewport.dispatchEvent(new Event('resize'))
    })

    await expect.poll(() => panel.evaluate((el) => el.style.left)).toBe('24px')
    await expect.poll(() => panel.evaluate((el) => el.style.top)).toBe('40px')
    await expect.poll(() => panel.evaluate((el) => el.style.width)).toBe('341px')
    await expect.poll(() => panel.evaluate((el) => el.style.height)).toBe('300px')
    await expect.poll(() => panel.evaluate((el) => el.style.bottom)).toBe('auto')
  })
})
