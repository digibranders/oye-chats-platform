import { test, expect } from '@playwright/test'

/**
 * Phase 4 - visitor-side multilingual live chat, in a real browser.
 *
 * WHAT THIS PROVES THAT UNIT TESTS CANNOT
 * ---------------------------------------
 * The regression this guards is a RENDER bug that only exists across a page
 * lifecycle. An operator reply is persisted in the OPERATOR's language (that
 * row is the canonical original and is never rewritten), while the visitor was
 * shown the translation live over the socket. On reload the widget rebuilds the
 * thread from `GET /chat/history` through TWO independent paths:
 *
 *   1. `ChatWindow`'s own history load, which renders the bot-mode transcript
 *   2. `LiveChatMode`'s restore, which runs on every `status: connected` frame
 *
 * Both must pick the same string. When this suite was first written they did
 * not: path 1 read `content` and path 2 read the translation, so a Hindi
 * visitor saw the same operator reply twice, once in English and once in
 * Hindi. `displayTextFor` is unit-tested in src/lib/; only a browser test that
 * boots the real widget against a real history payload catches the wiring.
 *
 * HOW THE BACKEND IS SIMULATED
 * ----------------------------
 * There is no API in this suite (playwright.config.js serves only the built
 * widget). `window.OYECHATS_API_URL` is pointed at a sentinel origin before the
 * bundle loads, `page.route` answers the endpoints the boot path touches, and
 * `page.routeWebSocket` plays the operator side without anything leaving the
 * browser.
 */

const API = 'http://oyechats-e2e.test'
const BOT_KEY = 'bot-DEV'
const SESSION_ID = 'sess-e2e-hi'

/** The operator's reply as the DB actually holds it: English original + Hindi translation. */
const OPERATOR_REPLY_EN = 'Our Enterprise plan starts at 5000 rupees per month.'
const OPERATOR_REPLY_HI = 'हमारा एंटरप्राइज़ प्लान 5000 रुपये प्रति माह से शुरू होता है।'
const VISITOR_MESSAGE_HI = 'मुझे कीमत बताइए'
const VISITOR_MESSAGE_EN = 'Tell me the price'

/**
 * History as the server returns it after Phase 4: `content` is always the
 * canonical original, `translations` is derived and keyed by target language.
 */
function historyPayload({ translated = true } = {}) {
  return [
    {
      id: 100,
      role: 'user',
      content: VISITOR_MESSAGE_HI,
      timestamp: '2026-08-24T10:00:00.000Z',
      source_language: 'hi',
      translations: { en: { content: VISITOR_MESSAGE_EN, status: 'ok' } },
    },
    {
      id: 101,
      role: 'operator',
      content: OPERATOR_REPLY_EN,
      timestamp: '2026-08-24T10:01:00.000Z',
      source_language: 'en',
      translations: translated
        ? { hi: { content: OPERATOR_REPLY_HI, status: 'ok' } }
        : // Provider was down when this reply was sent: recorded as failed,
          // carries no content, so the visitor falls back to the original.
          { hi: { status: 'failed' } },
    },
  ]
}

/**
 * Boot the host page as a returning Hindi visitor whose session is already
 * LIVE, which is exactly what a mid-conversation reload looks like.
 *
 * Returns a handle for driving the operator socket.
 */
async function bootVisitor(page, { translated = true } = {}) {
  await page.addInitScript(
    ({ api, botKey, sessionId }) => {
      window.OYECHATS_API_URL = api
      // A persisted session is what makes the widget restore instead of
      // starting fresh; the stored locale is what selects the translation.
      localStorage.setItem(`chat_session_id_${botKey}`, sessionId)
      localStorage.setItem(
        `oyechats_locale_${botKey}`,
        JSON.stringify({ locale: 'hi-IN', source: 'explicit' }),
      )
    },
    { api: API, botKey: BOT_KEY, sessionId: SESSION_ID },
  )

  // ORDER MATTERS. Playwright tries the most recently registered matching
  // route FIRST, so the catch-all is registered first and the specific
  // handlers below override it. Registering it last swallows every mock and
  // the widget silently boots with empty data.
  await page.route(`${API}/**`, (route) => route.fulfill({ json: {} }))
  await page.route(`${API}/bots/settings/public*`, (route) =>
    route.fulfill({
      json: {
        bot_name: 'Acme Bot',
        primary_color: '#2563eb',
        // `hi-IN` MUST be in supported_locales. The widget narrows the stored
        // preference through the bot's supported list, so without this the
        // active locale falls back to English and every translation assertion
        // below silently tests the wrong thing.
        language_config: {
          enabled: true,
          default_locale: 'en-IN',
          supported_locales: ['en-IN', 'hi-IN'],
          operator_translation_enabled: true,
        },
      },
    }),
  )
  await page.route(`${API}/chat/history/**`, (route) =>
    route.fulfill({ json: historyPayload({ translated }) }),
  )
  // `status: live` is what flips the widget into LiveChatMode on boot.
  await page.route(`${API}/operators/session-status/**`, (route) =>
    route.fulfill({ json: { status: 'live', operator_name: 'Asha' } }),
  )

  const handle = { opened: 0, ws: null }
  await page.routeWebSocket(/\/ws\/chat\//, (ws) => {
    // Acts as the server: no connectToServer(), so nothing leaves the browser.
    handle.opened += 1
    handle.ws = ws
    ws.onMessage(() => {
      /* visitor pings / read receipts: acknowledged by ignoring */
    })
    ws.send(JSON.stringify({ type: 'status', status: 'connected', operator_name: 'Asha' }))
  })

  await page.goto('/')
  await page.waitForFunction(() => !!window.OyeChats && typeof window.OyeChats.open === 'function')
  await page.evaluate(() => window.OyeChats.open())

  // The live-chat socket is what triggers LiveChatMode's restore. Wait for it
  // so the assertions cover that path and not just ChatWindow's history load.
  await expect.poll(() => handle.opened, { timeout: 15_000 }).toBeGreaterThan(0)
  return handle
}

/** The widget renders into a shadow root; Playwright pierces it automatically. */
function thread(page) {
  return page.locator('#oyechats-widget-root')
}

/**
 * Settle on a stable rendered-text count.
 *
 * The operator reply currently renders TWICE for a returning visitor in a live
 * session: once from ChatWindow's bot-mode history list and once from
 * LiveChatMode's restored live list. That duplication predates Phase 4 (before
 * translation both copies were the same English string) and is out of scope
 * here, so these tests assert the LANGUAGE of what is rendered and never pin
 * the copy count.
 */
async function countOf(page, text) {
  return thread(page).getByText(text).count()
}

test.describe('Phase 4 - visitor reload restores the translated thread', () => {
  test('a Hindi visitor reloading mid-conversation sees Hindi, never the English original', async ({
    page,
  }) => {
    await bootVisitor(page)

    // The operator's reply must be restored from `translations.hi`.
    await expect.poll(() => countOf(page, OPERATOR_REPLY_HI), { timeout: 15_000 }).toBeGreaterThan(0)

    // THE REGRESSION, asserted directly: no mixed-language thread. The English
    // original is in the payload and must never reach the screen.
    expect(await countOf(page, OPERATOR_REPLY_EN)).toBe(0)

    // The visitor's own Hindi message is untouched - they never see the English
    // translation that was produced for the operator.
    expect(await countOf(page, VISITOR_MESSAGE_HI)).toBeGreaterThan(0)
    expect(await countOf(page, VISITOR_MESSAGE_EN)).toBe(0)
  })

  test('a reconnect re-runs the restore without switching language', async ({ page }) => {
    // `status: connected` re-fires on every reconnect and the restore appends
    // anything newer than what it already holds, so a second pass must not
    // introduce the original alongside the translation.
    const handle = await bootVisitor(page)
    await expect.poll(() => countOf(page, OPERATOR_REPLY_HI), { timeout: 15_000 }).toBeGreaterThan(0)
    const before = await countOf(page, OPERATOR_REPLY_HI)

    handle.ws.send(JSON.stringify({ type: 'status', status: 'connected', operator_name: 'Asha' }))
    await page.waitForTimeout(1500)

    // Same language, and the re-run is idempotent rather than additive.
    expect(await countOf(page, OPERATOR_REPLY_EN)).toBe(0)
    expect(await countOf(page, OPERATOR_REPLY_HI)).toBe(before)
  })

  test('when translation failed the visitor still gets the operator original', async ({ page }) => {
    // Provider outage: the message must remain deliverable and readable. A
    // `failed` entry carries no content, so the fallback is the original.
    await bootVisitor(page, { translated: false })

    await expect.poll(() => countOf(page, OPERATOR_REPLY_EN), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await countOf(page, OPERATOR_REPLY_HI)).toBe(0)
  })
})
