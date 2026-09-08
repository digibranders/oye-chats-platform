import { expect, test, type Page } from '@playwright/test';

import { BOT_ID, mockBackend, type OperatorSocket } from './mockBackend';

/**
 * Reaching an operator who is not looking at the inbox.
 *
 * The reported failure was a notification panel nobody opens and a rail badge
 * nobody notices. Underneath it was worse: the operator socket was owned by the
 * inbox page, so an operator on any other screen was disconnected and, after
 * sixty seconds, marked offline with their live chats re-queued. The first test
 * here is that one — the connection survives leaving the page — because every
 * other claim on this screen depends on it.
 *
 * The click-safety case cannot be checked in jsdom, which computes no layout:
 * there are no boxes to measure and nothing to move.
 */

function waiting(sessionId: string, name: string, secondsAgo: number) {
  return {
    session_id: sessionId,
    name,
    reason: 'i want to know more abt the pricing for SOC',
    bot_id: BOT_ID,
    bot_name: 'Acme Bot',
    // `waiting_since`, not `created_at`. The server sends the moment the
    // visitor entered the QUEUE; `created_at` was when they opened the widget,
    // and the server never actually put it on a queue row at all, which is why
    // the card's escalation never ran in production.
    waiting_since: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    requeue_reason: 'handoff',
  };
}

/**
 * Put the operator on duty by visiting the inbox, then send them elsewhere.
 *
 * The move away is a click on the rail, not a `goto`. That is the gesture a
 * real operator makes, and it is the one the fix is about: a full page load
 * would rebuild the socket regardless and prove nothing about surviving
 * navigation.
 */
async function goOnDutyThenLeave(page: Page): Promise<void> {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('complementary').getByRole('link', { name: /^Leads/ }).click();
  await expect(page).toHaveURL(/\/leads/);
}

const card = (page: Page) => page.locator('[data-lobby-card]');

test.describe('Lobby alerts', () => {
  test('the operator keeps their connection after leaving the inbox', async ({ page }) => {
    // The socket used to be unmounted by this navigation. Sixty seconds later
    // the server marked them offline and re-queued their conversations, while
    // the console went on saying "Taking chats".
    const socket = await mockBackend(page);
    await goOnDutyThenLeave(page);

    // One connection, still open, from a page that is not the inbox.
    expect(socket.opened).toBeGreaterThan(0);
    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    await expect(card(page)).toBeVisible();
  });

  test('names who is waiting, for how long, and offers to take them', async ({ page }) => {
    const socket = await mockBackend(page);
    await goOnDutyThenLeave(page);

    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    await expect(card(page).getByText('Siddique')).toBeVisible();
    await expect(card(page).getByText(/i want to know more abt the pricing/)).toBeVisible();
    // The duration is text, not only a colour: the stripe is the same three
    // steps that about one operator in twelve cannot tell apart.
    await expect(card(page).getByText(/^\d+s$/)).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Take it' })).toBeVisible();
  });

  test('a second arrival appends, and does not move the first by a pixel', async ({ page }) => {
    // The rule the whole ordering model exists for. An operator reaching for
    // "Take it" must not have somebody else slide under the pointer on the way,
    // which is the same defect as the reflow that swallowed clicks on the auth
    // pages.
    const socket = await mockBackend(page);
    await goOnDutyThenLeave(page);

    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 30)] });
    await expect(card(page)).toHaveCount(1);
    const before = await card(page).first().boundingBox();
    if (!before) throw new Error('the first card has no box');

    socket.send({
      type: 'queue_update',
      count: 2,
      waiting: [waiting('s2', 'Priya', 1), waiting('s1', 'Siddique', 30)],
    });
    await expect(card(page)).toHaveCount(2);

    const after = await card(page).first().boundingBox();
    expect(Math.round(after!.y)).toBe(Math.round(before.y));
    // Oldest on top, whatever order the payload happened to arrive in.
    await expect(card(page).first().getByText('Siddique')).toBeVisible();
    await expect(card(page).nth(1).getByText('Priya')).toBeVisible();
  });

  test('taking a visitor accepts them and opens the conversation', async ({ page }) => {
    const socket = await mockBackend(page);
    let accepted: string | null = null;
    await page.route('**/operators/accept/*', (route) => {
      accepted = new URL(route.request().url()).pathname.split('/').pop() ?? null;
      return route.fulfill({ json: { status: 'accepted' } });
    });
    await goOnDutyThenLeave(page);

    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    await card(page).getByRole('button', { name: 'Take it' }).click();

    // `?session=` is the deep link the card sends; the inbox resolves it into
    // its own selection (`c=s.<id>`) and drops the parameter, so the landing
    // URL is the canonical one rather than the one that was navigated to.
    await expect(page).toHaveURL(/\/inbox\?/);
    await expect(page).toHaveURL(/c=s\.s1/);
    expect(accepted).toBe('s1');
  });

  test('counts the lobby in the tab title, for an operator in another tab', async ({ page }) => {
    const socket = await mockBackend(page);
    await goOnDutyThenLeave(page);
    const before = await page.title();
    expect(before).not.toMatch(/^\(\d+\)/);

    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    await expect.poll(() => page.title()).toMatch(/^\(1\)/);

    socket.send({ type: 'queue_update', count: 0, waiting: [] });
    await expect.poll(() => page.title()).not.toMatch(/^\(\d+\)/);
  });

  test('says nothing on the inbox, where the queue is already on screen', async ({ page }) => {
    const socket: OperatorSocket = await mockBackend(page);
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible({ timeout: 20_000 });

    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    // It reaches the queue list, so this is not "the frame never arrived".
    await expect(page.getByRole('listbox').getByText('Siddique')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('clears the chrome even when a banner sits above the top bar', async ({ page }) => {
    // The reported overlap. The stack used to be `fixed` at
    // `--spacing-topbar + 0.75rem`, which assumes the top bar is the only
    // chrome above the page. With a trial banner present the card landed ON
    // the bar, covering search and the notification bell.
    const socket = await mockBackend(page, {
      trial: {
        status: 'trialing',
        trial_end_at: '2026-09-11T00:00:00.000Z',
        days_remaining: 2,
        trial_days: 14,
        credits_granted: 500,
      },
    });
    await goOnDutyThenLeave(page);
    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    await expect(card(page)).toHaveCount(1);

    const gap = await page.evaluate(() => {
      const search = document.querySelector('button[aria-label*="Search" i], input[type="search"]');
      const first = document.querySelector('[data-lobby-card]');
      if (!search || !first) throw new Error('missing search or card');
      return first.getBoundingClientRect().top - search.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThan(0);
  });

  test('pushes toasts below itself instead of sharing the coordinates', async ({ page }) => {
    // The other half of the overlap: the toaster is `fixed` in the same corner.
    // The stack publishes its height and the toasts read it, so the cards stay
    // put and the toasts move — a toast arriving must not shift a button an
    // operator is reaching for.
    const socket = await mockBackend(page);
    await goOnDutyThenLeave(page);

    const before = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--overlay-stack-height').trim(),
    );
    expect(before).toBe('');

    socket.send({ type: 'queue_update', count: 1, waiting: [waiting('s1', 'Siddique', 8)] });
    await expect(card(page)).toHaveCount(1);

    const published = await page.evaluate(() => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--overlay-stack-height')
        .trim();
      const height = document.querySelector('[data-lobby-card]')!.parentElement!.getBoundingClientRect().height;
      return { value, height: Math.ceil(height) };
    });
    expect(published.value).toBe(`${published.height}px`);

    socket.send({ type: 'queue_update', count: 0, waiting: [] });
    await expect(card(page)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--overlay-stack-height').trim(),
        ),
      )
      .toBe('');
  });

  test('closing one card does not close the queue', async ({ page }) => {
    const socket = await mockBackend(page);
    await goOnDutyThenLeave(page);

    socket.send({
      type: 'queue_update',
      count: 2,
      waiting: [waiting('s1', 'Siddique', 30), waiting('s2', 'Priya', 1)],
    });
    await expect(card(page)).toHaveCount(2);

    await card(page).first().getByRole('button', { name: 'Dismiss Siddique' }).click();
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).getByText('Priya')).toBeVisible();
  });
});
