import { test, expect } from '@playwright/test'

const API = 'http://oyechats-launcher.test'
const avatar = `${API}/avatar.png`
const customLogo = `${API}/launcher.png`
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="#2563eb"/></svg>'

async function boot(page, settings = {}, { dismissGreeting = true } = {}) {
  await page.addInitScript(({ api, dismiss }) => {
    window.OYECHATS_API_URL = api
    if (dismiss) sessionStorage.setItem('oyechats_greeting_dismissed', '1')
  }, { api: API, dismiss: dismissGreeting })
  await page.route(`${API}/**`, route => route.fulfill({ json: {} }))
  await page.route(`${API}/*.png`, route => route.fulfill({ contentType: 'image/svg+xml', body: image }))
  await page.route(`${API}/bots/settings/public*`, route => route.fulfill({ json: {
    bot_name: 'Acme Assistant', launcher_name: 'Ask Acme', primary_color: '#2563eb',
    language_config: { enabled: false }, ...settings,
  } }))
  await page.goto('/')
  const root = page.locator('#oyechats-widget-root')
  const launcher = root.getByRole('button', { name: 'Ask Acme', exact: true })
  await expect(launcher).toBeVisible()
  return { root, launcher }
}

test('mirrored favicon stays in the greeting avatar, not the launcher', async ({ page, isMobile }) => {
  const { root, launcher } = await boot(page, { bot_logo: avatar, launcher_logo: avatar }, { dismissGreeting: false })
  await expect(launcher.locator('svg.oyechats-launcher-mark')).toBeVisible()
  await expect(launcher.locator('img')).toHaveCount(0)
  if (!isMobile) await expect(root.locator(`img[src="${avatar}"]`)).toBeVisible({ timeout: 5000 })
})

for (const avatarType of ['orb', 'mascot']) {
  test(`${avatarType} avatar does not replace the default launcher`, async ({ page }) => {
    const { launcher } = await boot(page, { avatar_type: avatarType })
    await expect(launcher.locator('svg.oyechats-launcher-mark')).toBeVisible()
    await expect(launcher.locator('canvas, .lucide-bot')).toHaveCount(0)
  })
}

test('a configured launcher image cannot replace the fixed OyeChats mark', async ({ page }) => {
  const { launcher } = await boot(page, { bot_logo: avatar, launcher_logo: customLogo })
  await expect(launcher.locator('svg.oyechats-launcher-mark')).toBeVisible()
  await expect(launcher.locator('img')).toHaveCount(0)
})

test('dots are still at rest, pulse on hover, and reset on leave', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover only applies to a fine pointer')
  const { launcher } = await boot(page)
  const dots = launcher.locator('.oyechats-launcher-dot')
  await expect(dots).toHaveCount(3)
  await expect(dots.first()).toHaveCSS('animation-name', 'none')
  await launcher.hover()
  await expect(dots.first()).toHaveCSS('animation-name', 'oyechatsLauncherDot')
  await expect(dots.nth(1)).toHaveCSS('animation-delay', '0.15s')
  await expect(dots.nth(2)).toHaveCSS('animation-delay', '0.3s')
  await page.mouse.move(0, 0)
  await expect(dots.first()).toHaveCSS('animation-name', 'none')
  await expect(dots.first()).toHaveCSS('opacity', '1')
})

test('keyboard focus animates dots and Enter opens chat', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop keyboard interaction')
  const { root, launcher } = await boot(page)
  await launcher.focus()
  await expect(launcher.locator('.oyechats-launcher-dot').first()).toHaveCSS('animation-name', 'oyechatsLauncherDot')
  await launcher.press('Enter')
  await expect(root.locator('[data-oyechats-panel]')).toBeVisible()
})

test('reduced motion keeps the mark still on focus and hover', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { launcher } = await boot(page)
  if (!isMobile) await launcher.hover()
  await launcher.focus()
  await expect(launcher.locator('.oyechats-launcher-dot').first()).toHaveCSS('animation-name', 'none')
  await expect(launcher).toHaveCSS('transform', 'none')
})

test('launcher opens chat on desktop and touch', async ({ page }) => {
  const { root, launcher } = await boot(page)
  await launcher.click()
  await expect(root.locator('[data-oyechats-panel]')).toBeVisible()
})
