import { expect, test } from '@playwright/test';
import { API, SESSION_ID, assertApiOrigin, mockBackend, type HistoryMessage } from './mockBackend';

/**
 * Phase 4 - operator-side multilingual live chat, in a real browser.
 *
 * WHAT THIS PROVES THAT UNIT TESTS CANNOT
 * ---------------------------------------
 * The visitor→operator direction is deliberately out of band: the original is
 * persisted, routed and acknowledged FIRST, and the translation arrives later
 * as its own `message_translation` frame keyed by `message_id`. That ordering
 * is invisible to a unit test of the reducer - it only shows up when the real
 * socket, the real reducer and the real bubble run together and you can watch
 * a bubble start in Hindi and become English a moment later.
 *
 * The same goes for the reload path: the console rebuilds its thread from
 * `GET /chat/history`, so a translation that lived only on the wire vanishes
 * on refresh. That is asserted here against the real history payload.
 */

const VISITOR_HI = 'मुझे कीमत बताइए';
const VISITOR_EN = 'Tell me the price';
const OPERATOR_REPLY = 'Our Enterprise plan starts at 5000 rupees per month.';

/** A visitor message as history returns it once translation has completed. */
const TRANSLATED_HISTORY: HistoryMessage[] = [
  {
    id: 101,
    role: 'user',
    content: VISITOR_HI,
    timestamp: '2026-08-24T10:00:00.000Z',
    source_language: 'hi',
    translations: { en: { content: VISITOR_EN, status: 'ok' } },
  },
];

/** The same message when the provider was unavailable. */
const FAILED_HISTORY: HistoryMessage[] = [
  {
    id: 101,
    role: 'user',
    content: VISITOR_HI,
    timestamp: '2026-08-24T10:00:00.000Z',
    source_language: 'hi',
    translations: { en: { status: 'failed' } },
  },
];

/** Open the inbox on the Live chat tab and select the seeded conversation. */
async function openConversation(
  page: import('@playwright/test').Page,
  socket: import('./mockBackend').OperatorSocket,
): Promise<void> {
  await page.goto('/inbox?tab=live');
  await assertApiOrigin(socket);
  // The conversation list renders from `active_chats_restore`.
  const chat = page.getByText('Priya').first();
  await expect(chat).toBeVisible({ timeout: 20_000 });
  await chat.click();
}

test.describe('Phase 4 - operator sees translated visitor messages', () => {
  test('a Hindi message arrives as the original, then becomes English when the translation lands', async ({
    page,
  }) => {
    const socket = await mockBackend(page, { history: [], operatorLocale: 'en-IN' });
    await openConversation(page, socket);

    // 1. The original is delivered first. This is the out-of-band contract:
    //    nothing waits on the provider, so the operator sees Hindi immediately.
    socket.send({
      type: 'message',
      session_id: SESSION_ID,
      role: 'user',
      content: VISITOR_HI,
      timestamp: '2026-08-24T10:00:00.000Z',
      id: 101,
      source_language: 'hi',
    });
    await expect(page.getByText(VISITOR_HI)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(VISITOR_EN)).toHaveCount(0);

    // 2. The translation follows as its own frame and replaces what is rendered.
    socket.send({
      type: 'message_translation',
      session_id: SESSION_ID,
      message_id: 101,
      language: 'en',
      content: VISITOR_EN,
      status: 'ok',
    });
    await expect(page.getByText(VISITOR_EN)).toBeVisible({ timeout: 15_000 });

    // 3. The original is one click away, and clicking back returns to English.
    const viewOriginal = page.getByRole('button', { name: /view original/i });
    await expect(viewOriginal).toBeVisible();
    await viewOriginal.click();
    await expect(page.getByText(VISITOR_HI)).toBeVisible();

    await page.getByRole('button', { name: /view translation/i }).click();
    await expect(page.getByText(VISITOR_EN)).toBeVisible();
  });

  test('the operator replies in English and the reply leaves on the socket', async ({ page }) => {
    const socket = await mockBackend(page, { history: TRANSLATED_HISTORY, operatorLocale: 'en-IN' });
    await openConversation(page, socket);
    await expect(page.getByText(VISITOR_EN)).toBeVisible({ timeout: 15_000 });

    // The composer is disabled until the socket reports `connected`, so target
    // it by its own placeholder rather than "the last textbox on the page".
    const composer = page.getByPlaceholder(/type a reply/i);
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.fill(OPERATOR_REPLY);
    await page.getByRole('button', { name: 'Send message' }).click();

    // The server receives the operator's OWN words. Translating into the
    // visitor's language happens server-side, never in the console.
    await expect
      .poll(() => socket.sent.filter((f) => f.type === 'message').length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const sent = socket.sent.find((f) => f.type === 'message');
    expect(sent).toMatchObject({ type: 'message', session_id: SESSION_ID, content: OPERATOR_REPLY });
  });

  test('the conversation language badge names the visitor language', async ({ page }) => {
    const socket = await mockBackend(page, { history: TRANSLATED_HISTORY, operatorLocale: 'en-IN' });
    await openConversation(page, socket);
    // Sourced from `ChatSession.language_code` via the session-details endpoint.
    // Targeted by its title, not by loose text: the operator's own language
    // picker sits in the same view and renders language names of its own, so a
    // bare getByText would be ambiguous about which one it matched.
    await expect(page.getByTitle('Visitor is writing in Hindi')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Phase 4 - operator reconnect', () => {
  test('translations survive a socket drop and the toggle still works', async ({ page }) => {
    // History is what rebuilds the thread after a reconnect, so this is the
    // assertion that the wire is not the only carrier.
    const socket = await mockBackend(page, { history: TRANSLATED_HISTORY, operatorLocale: 'en-IN' });
    await openConversation(page, socket);
    await expect(page.getByText(VISITOR_EN)).toBeVisible({ timeout: 15_000 });

    const connectionsBefore = socket.opened;
    socket.drop();

    // The console reconnects on its own backoff; wait for the new connection.
    await expect.poll(() => socket.opened, { timeout: 30_000 }).toBeGreaterThan(connectionsBefore);
    await page.getByText('Priya').first().click();

    // Still translated, and the toggle is still functional afterwards.
    await expect(page.getByText(VISITOR_EN)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /view original/i }).click();
    await expect(page.getByText(VISITOR_HI)).toBeVisible();
  });

  test('a duplicate translation frame does not double-render', async ({ page }) => {
    // Redelivery over the Redis backplane, or an operator retry landing beside
    // the original, must be a no-op rather than a second bubble.
    const socket = await mockBackend(page, { history: [], operatorLocale: 'en-IN' });
    await openConversation(page, socket);

    socket.send({
      type: 'message',
      session_id: SESSION_ID,
      role: 'user',
      content: VISITOR_HI,
      timestamp: '2026-08-24T10:00:00.000Z',
      id: 101,
      source_language: 'hi',
    });
    const translation = {
      type: 'message_translation',
      session_id: SESSION_ID,
      message_id: 101,
      language: 'en',
      content: VISITOR_EN,
      status: 'ok',
    };
    socket.send(translation);
    await expect(page.getByText(VISITOR_EN)).toBeVisible({ timeout: 15_000 });

    socket.send(translation);
    socket.send(translation);
    await page.waitForTimeout(1000);

    expect(await page.getByText(VISITOR_EN).count()).toBe(1);
  });
});

test.describe('Phase 4 - translation provider failure', () => {
  test('the original stays readable and the UI offers a retry', async ({ page }) => {
    const socket = await mockBackend(page, { history: [], operatorLocale: 'en-IN' });
    await openConversation(page, socket);

    socket.send({
      type: 'message',
      session_id: SESSION_ID,
      role: 'user',
      content: VISITOR_HI,
      timestamp: '2026-08-24T10:00:00.000Z',
      id: 101,
      source_language: 'hi',
    });
    socket.send({
      type: 'message_translation',
      session_id: SESSION_ID,
      message_id: 101,
      language: 'en',
      status: 'unavailable',
    });

    // The message is NOT lost: the operator can still read and act on it.
    await expect(page.getByText(VISITOR_HI)).toBeVisible({ timeout: 15_000 });
    // And the failure is surfaced honestly rather than looking like silence.
    await expect(page.getByText(/translation unavailable/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
  });

  test('a message with no translation yet still renders the original', async ({ page }) => {
    // The out-of-band window: original delivered, translation still in flight.
    const socket = await mockBackend(page, { history: FAILED_HISTORY, operatorLocale: 'en-IN' });
    await openConversation(page, socket);

    await expect(page.getByText(VISITOR_HI)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(VISITOR_EN)).toHaveCount(0);
  });

  test('retry calls the backfill endpoint and renders the result', async ({ page }) => {
    let translateCalls = 0;
    const socket = await mockBackend(page, { history: [], operatorLocale: 'en-IN' });
    await page.route(`${API}/operators/translate`, (route) => {
      translateCalls += 1;
      return route.fulfill({
        json: { translated: VISITOR_EN, target_locale: 'en', cached: false, status: 'ok' },
      });
    });
    await openConversation(page, socket);

    socket.send({
      type: 'message',
      session_id: SESSION_ID,
      role: 'user',
      content: VISITOR_HI,
      timestamp: '2026-08-24T10:00:00.000Z',
      id: 101,
      source_language: 'hi',
    });
    socket.send({
      type: 'message_translation',
      session_id: SESSION_ID,
      message_id: 101,
      language: 'en',
      status: 'unavailable',
    });
    await expect(page.getByRole('button', { name: /retry/i })).toBeVisible({ timeout: 15_000 });

    // The retry re-reads history afterwards, so serve the translated row now.
    await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: TRANSLATED_HISTORY }));
    await page.getByRole('button', { name: /retry/i }).click();

    await expect.poll(() => translateCalls, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByText(VISITOR_EN)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Phase 4 - operator without a language preference', () => {
  test('sees every message in the language it was written in', async ({ page }) => {
    // `preferred_locale: null` means translation is off for this operator: no
    // translated text, and no toggle offering one.
    const socket = await mockBackend(page, { history: [], operatorLocale: null });
    await openConversation(page, socket);

    socket.send({
      type: 'message',
      session_id: SESSION_ID,
      role: 'user',
      content: VISITOR_HI,
      timestamp: '2026-08-24T10:00:00.000Z',
      id: 101,
      source_language: 'hi',
    });
    socket.send({
      type: 'message_translation',
      session_id: SESSION_ID,
      message_id: 101,
      language: 'en',
      content: VISITOR_EN,
      status: 'ok',
    });
    await page.waitForTimeout(1000);

    await expect(page.getByText(VISITOR_HI)).toBeVisible();
    await expect(page.getByText(VISITOR_EN)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /view original/i })).toHaveCount(0);
  });
});

test.describe('Phase 5A - the working language is a property of the operator', () => {
  test('an offline operator still sees the language they have saved', async ({ page }) => {
    // Regression. The fetch used to be gated on the socket being connected, so
    // an operator who was off duty saw the picker claim "Don't translate" while
    // the server held a saved locale - the control misreported their own
    // setting, and adjusting it while offline meant acting on a false reading.
    await mockBackend(page, { history: [], operatorLocale: 'en-IN', online: false });
    await page.goto('/inbox?tab=live');

    // Offline: the availability action offers to put them ON duty.
    await expect(page.getByRole('button', { name: 'Go online' })).toBeVisible({ timeout: 20_000 });

    const picker = page.getByRole('combobox', { name: 'Read live chat in' });
    await expect(picker).toHaveText(/English \(India\)/, { timeout: 20_000 });
    await expect(page.getByText(/translated into English/i)).toBeVisible();
    await expect(page.getByText(/original language/i)).toHaveCount(0);
  });

  test('an offline operator with no preference still reads as untranslated', async ({ page }) => {
    // The honest null state, which must survive the fix above rather than
    // being replaced by a phantom default.
    await mockBackend(page, { history: [], operatorLocale: null, online: false });
    await page.goto('/inbox?tab=live');

    await expect(page.getByRole('button', { name: 'Go online' })).toBeVisible({ timeout: 20_000 });
    const picker = page.getByRole('combobox', { name: 'Read live chat in' });
    await expect(picker).toHaveText(/Don’t translate/, { timeout: 20_000 });
    await expect(page.getByText(/original language/i)).toBeVisible();
  });

  test('the picker offers the locales the bot supports', async ({ page }) => {
    // Sourced from `GET /operators/me/language`, not a hardcoded array.
    await mockBackend(page, { history: [], operatorLocale: 'en-IN', online: false });
    await page.goto('/inbox?tab=live');

    await page.getByRole('combobox', { name: 'Read live chat in' }).click();
    const options = page.getByRole('option');
    await expect(options).toHaveText([/Don’t translate/, /English \(India\)/, /Hindi \(India\)/]);
  });
});
