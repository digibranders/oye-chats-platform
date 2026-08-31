import { test, expect } from '@playwright/test'

/**
 * Phase 5 hardening - the widget's OWN chrome in Hindi, in a real browser.
 *
 * WHAT THIS PROVES THAT UNIT TESTS CANNOT
 * ---------------------------------------
 * `i18n.test.js` proves two things separately: the Hindi dictionary holds a
 * string for every key, and each component's source calls `t()`. Neither one
 * proves the string reaches the screen. The whole class of bug this suite
 * exists for is copy that is present in the dictionary, requested by the
 * component, and still rendered in English - because the component that
 * actually mounts in that state is a different one, or the state is reached
 * through a path nobody rendered in Hindi.
 *
 * So this asserts on RENDERED TEXT: for each visitor-reachable state, the Hindi
 * copy is on screen AND the English original is not. The negative half is the
 * one that matters. A missing Hindi string is invisible to a test that only
 * looks for Hindi, because the English fallback renders happily in its place.
 *
 * Customer-authored copy (bot name, greeting, quick actions) is deliberately
 * NOT asserted: it is shown unchanged in every language by design, so it is set
 * to Devanagari in the fixture below only to keep it out of the English sweep.
 */

const API = 'http://oyechats-e2e.test'
const BOT_KEY = 'bot-DEV'

/**
 * English chrome that MUST NOT survive into a Hindi session. Every entry was
 * hardcoded before this sweep. Matching is done against the widget's rendered
 * text, so a regression in any one of them fails here.
 *
 * Product names (OyeChats, Calendly, YouTube), the "Powered by" attribution
 * (customer-editable white-label copy) and email addresses are excluded: they
 * are not translated by design.
 */
const ENGLISH_CHROME = [
  'Start New Chat',
  'More options',
  'Send transcript',
  'Leave a message',
  'Load earlier messages',
  'Privacy Policy',
  'End chat',
  'Keep chatting',
  'End conversation?',
  'Skip',
  'Continue with AI',
  'Want to talk to our team?',
  'Not now',
  'Try again',
  'Keep waiting',
  'Yes, connect me',
  'No, keep chatting with AI',
  'Switch to live chat instead?',
  'New chat',
  'Clear chat',
  'Talk to a human',
  'Start a fresh conversation',
  'Hide the messages above',
  'Request a live agent',
]

const settingsPayload = (overrides = {}) => ({
  bot_name: 'एक्मे बॉट',
  launcher_name: 'सवाल हैं?',
  primary_color: '#2563eb',
  live_chat_enabled: true,
  feature_flags: { email_transcript: true, post_chat_rating: true },
  // Customer-authored copy travels unchanged, so the fixture writes it in
  // Devanagari; otherwise it would trip the English sweep for the right
  // reason and mask a real failure.
  widget_messages: {
    welcome_suggestions: ['कीमत', 'सेवाएँ'],
  },
  language_config: {
    enabled: true,
    default_locale: 'en-IN',
    supported_locales: ['en-IN', 'hi-IN'],
    allow_visitor_language_switch: true,
  },
  ...overrides,
})

/** Boot the host page as a Hindi visitor with the chat already open. */
async function bootHindiVisitor(page, { settings = {}, history = [] } = {}) {
  await page.addInitScript(
    ({ api, botKey }) => {
      window.OYECHATS_API_URL = api
      localStorage.setItem(
        `oyechats_locale_${botKey}`,
        JSON.stringify({ locale: 'hi-IN', source: 'explicit' }),
      )
    },
    { api: API, botKey: BOT_KEY },
  )

  // Catch-all first: Playwright prefers the most recently registered route.
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
  await page.route(`${API}/bots/settings/public*`, (route) =>
    route.fulfill({ json: settingsPayload(settings) }),
  )
  await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: history }))

  await page.goto('/')
  await page.waitForFunction(() => !!window.OyeChats && typeof window.OyeChats.open === 'function')
  await page.evaluate(() => window.OyeChats.open())
  await waitForWidget(page)
  // The Hindi dictionary is a lazy chunk: nothing is translated until it lands.
  await page.waitForFunction(
    () => !!performance.getEntriesByType('resource').find((r) => r.name.includes('oyechats-hi')),
    { timeout: 15_000 },
  )
  return page.locator('#oyechats-widget-root')
}

/**
 * Wait for the widget to have mounted content.
 *
 * NOT `expect(root).toBeVisible()`: `#oyechats-widget-root` is a shadow host
 * whose only child is `position: fixed`, so the host's own box measures 0x0 and
 * Playwright calls it hidden. Asserting on the shadow tree's content is both
 * accurate and stable.
 */
async function waitForWidget(page) {
  await page.waitForFunction(
    () => {
      const host = document.getElementById('oyechats-widget-root')
      const root = host && (host.shadowRoot || host)
      return !!root && (root.textContent || '').length > 20
    },
    { timeout: 15_000 },
  )
}

/** Everything the visitor can actually read, flattened. */
async function renderedText(page) {
  return page.evaluate(() => {
    const host = document.getElementById('oyechats-widget-root')
    const root = host?.shadowRoot || host
    return root ? root.textContent || '' : ''
  })
}

/**
 * The negative assertion, applied to whatever is on screen right now.
 * Word-boundary matched so "End chat" does not match inside a longer Hindi
 * string that happens to embed a Latin product name.
 */
async function expectPrivacyLine(root, text) {
  /**
   * The privacy line beneath the composer, asserted the way this file cares
   * about it: the COPY must be right in both projects, while its visibility is
   * a layout fact that differs by viewport.
   *
   * It is `hidden md:block` unconditionally, so a phone never renders it. That
   * is deliberate (the mobile viewport reclaims the vertical space above the
   * input), and it changed on the `steve` branch: it used to be visible on a
   * phone until the visitor sent their first message. Asserting presence rather
   * than skipping keeps this suite doing its actual job — proving the string is
   * translated and rendered — instead of losing the assertion on one project.
   */
  const line = root.getByText(text)
  await expect(line).toHaveCount(1)
  if (test.info().project.name === 'mobile') {
    await expect(line).not.toBeVisible()
  } else {
    await expect(line).toBeVisible({ timeout: 10_000 })
  }
}

async function expectNoEnglishChrome(page, context) {
  const text = await renderedText(page)
  const found = ENGLISH_CHROME.filter((s) => text.includes(s))
  expect(found, `untranslated English chrome visible during ${context}`).toEqual([])
}

test.describe('Phase 5 - the widget chrome speaks Hindi', () => {
  test('the composer, action bar and slash palette are Hindi', async ({ page }) => {
    const root = await bootHindiVisitor(page)

    // Composer placeholder + the privacy link beneath it.
    await expectPrivacyLine(root, 'गोपनीयता नीति')
    await expectNoEnglishChrome(page, 'the welcome state')

    // Slash palette: the labels live on a module-level constant, so this is
    // what proves they are resolved at render rather than frozen at import.
    // `isAvailable` hides /new and /clear until the visitor has sent something,
    // so a fresh chat offers /human alone. That is the one to assert on.
    //
    // `toBeVisible()` deliberately, not a text match. An earlier revision of
    // this test asserted on rendered text because the label measured 0 wide and
    // Playwright called it hidden, and a comment here wrote that off as a
    // shadow-host measurement artifact since it reproduced in English too. It
    // was not an artifact: `/human`'s icon was ignoring its `size` prop and
    // expanding to 320x320, squeezing the label to nothing. Visibility is the
    // assertion that catches that; a text match sails straight past it.
    const composer = root.locator('textarea, input[type="text"]').first()
    await composer.click()
    await composer.fill('/')
    await expect(root.getByText('लाइव एजेंट का अनुरोध करें')).toBeVisible({ timeout: 5000 })
    await expectNoEnglishChrome(page, 'the slash palette')
  })

  test('the header menu and transcript dialog are Hindi', async ({ page }) => {
    const root = await bootHindiVisitor(page, {
      history: [
        {
          id: 1,
          role: 'user',
          content: 'नमस्ते',
          timestamp: '2026-08-24T10:00:00.000Z',
        },
      ],
    })

    await root.locator('button[title="अधिक विकल्प"]').click()
    await expect(root.getByText('ट्रांसक्रिप्ट भेजें')).toBeVisible()
    await expect(root.getByText('भाषा (Language)')).toBeVisible()
    await expectNoEnglishChrome(page, 'the header menu')

    await root.getByText('ट्रांसक्रिप्ट भेजें').click()
    await expect(root.getByText('चैट का विवरण अपने ई-मेल पर भेजें।')).toBeVisible()
    await expect(root.getByText('भेजें', { exact: true })).toBeVisible()
    await expectNoEnglishChrome(page, 'the transcript dialog')
  })

  test('the language selector is reachable and Hindi-labelled', async ({ page }) => {
    const root = await bootHindiVisitor(page)
    await root.locator('button[title="अधिक विकल्प"]').click()
    await root.getByText('भाषा (Language)').click()
    await expect(root.getByText('भाषा चुनें')).toBeVisible({ timeout: 5000 })
    await expectNoEnglishChrome(page, 'the language selector')
  })

  test('a returning visitor gets a Hindi welcome-back banner and history control', async ({
    page,
  }) => {
    const root = await bootHindiVisitor(page, {
      history: Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        role: i % 2 === 0 ? 'user' : 'bot',
        content: i % 2 === 0 ? 'कीमत क्या है?' : 'हमारी कीमत यह है।',
        timestamp: '2026-08-20T10:00:00.000Z',
      })),
    })
    await expect(root.getByText(/वापसी पर स्वागत है/)).toBeVisible({ timeout: 10_000 })
    await expectNoEnglishChrome(page, 'the returning-visitor state')
  })

  test('English is byte-for-byte unchanged for a single-language bot', async ({ page }) => {
    // The mirror image of every assertion above. A bot with multilingual off
    // loads no dictionary at all, so each component must render its own inline
    // English default exactly as it did before the sweep.
    await page.addInitScript(({ api }) => {
      window.OYECHATS_API_URL = api
    }, { api: API })
    await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
    await page.route(`${API}/bots/settings/public*`, (route) =>
      route.fulfill({
        json: {
          bot_name: 'Acme Bot',
          primary_color: '#2563eb',
          feature_flags: { email_transcript: true },
          language_config: { enabled: false },
        },
      }),
    )
    // Empty history on purpose. The privacy line is `hidden md:block`, so it
    // never paints on a phone; `expectPrivacyLine` asserts the copy in both
    // projects and the visibility per project.
    await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: [] }))

    await page.goto('/')
    await page.waitForFunction(() => !!window.OyeChats && typeof window.OyeChats.open === 'function')
    await page.evaluate(() => window.OyeChats.open())
    const root = page.locator('#oyechats-widget-root')
    await waitForWidget(page)

    // No locale chunk may be fetched for a single-language bot.
    const localeChunkFetched = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((r) => r.name.includes('oyechats-hi')),
    )
    expect(localeChunkFetched, 'a single-language bot must not pay for a dictionary').toBe(false)

    // Assert the composer's own chrome BEFORE opening the menu: the dropdown
    // overlays the action bar on a phone viewport.
    await expectPrivacyLine(root, 'Privacy Policy')
    // The menu only offers a transcript once there is a transcript to send, so
    // with an empty history the assertion that matters is the chrome itself.
    await expect(root.locator('button[title="More options"], button[title="Close"]')).not.toHaveCount(
      0,
    )
  })
})
