import { test, expect } from '@playwright/test'

/**
 * The privacy notice under the composer, and when a phone is allowed to hide it.
 *
 * This is the only privacy link anywhere in the widget — one occurrence, in
 * `ChatInput.jsx`. There is no copy of it in the header menu or on the welcome
 * screen, so whatever this element does on a phone is the whole of what a phone
 * visitor ever sees.
 *
 * It collapses to `hidden` ONLY once the visitor has sent a message, and then
 * on every viewport. The distinction is the entire point: the notice exists to
 * be on screen while someone is deciding whether to type personal details into
 * a chat box, and that decision happens before the first message, not after it.
 * Reclaiming the vertical space afterwards costs nothing; reclaiming it from the
 * start removes the disclosure from every visitor before they have decided.
 *
 * That is not hypothetical — it shipped. A refactor replaced the conditional
 * with a bare `hidden md:block`, which reads like a tidy-up and is a disclosure
 * change, and it reached production before being reverted. Hence a test that
 * names the behaviour directly rather than leaving it to be inferred from two
 * language tests that happen to assert on the same element.
 */
const API = 'http://oyechats-e2e.test'

async function boot(page, { history = [] } = {}) {
  await page.addInitScript(({ api }) => {
    window.OYECHATS_API_URL = api
  }, { api: API })
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
  await page.route(`${API}/bots/settings/public*`, (route) =>
    route.fulfill({
      json: { bot_name: 'Acme Bot', primary_color: '#2563eb', language_config: { enabled: false } },
    }),
  )
  await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: history }))

  await page.goto('/')
  await page.waitForFunction(() => !!window.OyeChats && typeof window.OyeChats.open === 'function')
  await page.evaluate(() => window.OyeChats.open())
  const root = page.locator('#oyechats-widget-root')
  await expect(root.locator('textarea, input[type="text"]').first()).toBeVisible({ timeout: 15_000 })
  return root
}

const SENT = [
  { id: 1, role: 'user', content: 'hello', timestamp: '2026-08-31T10:00:00.000Z' },
  { id: 2, role: 'assistant', content: 'hi there', timestamp: '2026-08-31T10:00:01.000Z' },
]

test.describe('the privacy notice', () => {
  test('is visible before the visitor has said anything', async ({ page }) => {
    // Both projects. On a phone this is the assertion that matters: it is the
    // one that fails if the collapse is ever made unconditional again.
    const root = await boot(page)
    await expect(root.getByText('Privacy Policy')).toBeVisible()
  })

  test('is still reachable as a link, not just painted text', async ({ page }) => {
    const root = await boot(page)
    await expect(root.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      'https://www.oyechats.com/legal/privacy',
    )
  })

  test('collapses on every viewport once the conversation has started', async ({ page }) => {
    const root = await boot(page, { history: SENT })
    const line = root.getByText('Privacy Policy')
    // Present in the document either way — this is a layout collapse, not a
    // removal, so the link stays reachable for assistive tech.
    await expect(line).toHaveCount(1)
    // Hidden on both phone and desktop once the first message is sent: the
    // decision the notice guards is already made, so the row is reclaimed.
    await expect(line).not.toBeVisible()
  })

  test('on a phone the branding sits under the middle of the composer, not under Send', async ({ page }) => {
    // The "Powered by" link used to hug the right edge, directly beneath the
    // send button, and thumbs aiming for Send kept opening oyechats.com.
    const root = await boot(page)
    const branding = root.getByRole('link', { name: /OyeChats/ })
    const send = root.locator('button[type="submit"], button[aria-label*="Send" i]').first()
    const [brandBox, sendBox] = await Promise.all([branding.boundingBox(), send.boundingBox()])
    const brandCentre = brandBox.x + brandBox.width / 2
    // Centred on every viewport now, so the phone case is the general case:
    // clear of Send's left edge, and inside the middle third of the composer.
    // The composer is the send button's grid row, which on desktop is the
    // 380px panel rather than the viewport, so measure against the panel.
    const panel = root.locator('[data-oyechats-panel]')
    const panelBox = await panel.boundingBox()
    const third = panelBox.width / 3
    expect(brandCentre).toBeGreaterThan(panelBox.x + third)
    expect(brandCentre).toBeLessThan(panelBox.x + 2 * third)
    expect(brandBox.x + brandBox.width).toBeLessThan(sendBox.x)
  })
})
