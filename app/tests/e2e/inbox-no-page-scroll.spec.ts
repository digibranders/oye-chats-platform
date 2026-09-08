import { expect, test } from '@playwright/test';

import { SESSION_ID, mockBackend, type OperatorSocket } from './mockBackend';

/**
 * The inbox is exactly one viewport tall, and stays that way.
 *
 * It is a three-pane console: the conversation list and the transcript scroll
 * independently, inside a frame that does not move. When the frame moves, the
 * status strip, the pane headers and the composer slide up out of the window
 * while the operator is reading — and the composer is the thing they were
 * reaching for.
 *
 * The cause was `sr-only`. Tailwind's visually-hidden utility is
 * `position: absolute` with no inset, so the element stays at the spot it
 * would have occupied in flow, but is laid out against its nearest positioned
 * ancestor — not against the scroll container it appears to be inside, which
 * therefore neither clips it nor scrolls it. The transcript renders one
 * `sr-only` speaker label per message, so a thirty-message conversation placed
 * a label 1200px below the top of the shell's scroll container and added
 * 1200px of scrollable overflow to it. Short conversations were fine, which is
 * why this read as "sometimes, on some chats".
 *
 * Fixed in `index.css` by pinning `sr-only` to the origin of whatever contains
 * it. That is asserted here rather than in a unit test because jsdom computes
 * no layout: there is no scroll height in it to be wrong.
 */

/** Enough messages that any per-message overflow is unmistakable. */
function seedConversation(socket: OperatorSocket, count: number): void {
  for (let index = 0; index < count; index += 1) {
    socket.send({
      type: 'message',
      session_id: SESSION_ID,
      role: index % 2 === 0 ? 'user' : 'operator',
      content: `Message ${index}. Long enough to take a full line in the transcript.`,
      timestamp: new Date(Date.now() - (count - index) * 60_000).toISOString(),
      id: 900 + index,
    });
  }
}

/** How far the shell's scroll container can scroll. Must be zero here. */
function shellOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.getElementById('main');
    if (!main) throw new Error('the shell scroll container is missing');
    return main.scrollHeight - main.clientHeight;
  });
}

test.describe('Inbox page scroll', () => {
  test('a long conversation scrolls the transcript, not the console', async ({ page }) => {
    const socket = await mockBackend(page);
    await page.goto('/inbox');
    await page.getByText('Priya').first().click({ timeout: 20_000 });

    expect(await shellOverflow(page)).toBe(0);

    seedConversation(socket, 30);
    // Scoped: the list renders the last message as a row preview too.
    const pane = page.locator('section[aria-label^="Conversation with"]');
    await expect(pane.getByText('Message 29')).toBeVisible();

    // The transcript itself must genuinely be overflowing, or this proves
    // nothing: a console that fits has no page scroll either.
    const transcriptOverflow = await page.evaluate(() => {
      const list = document.querySelector('section[aria-label^="Conversation with"] ol');
      let node = list?.parentElement ?? null;
      while (node) {
        if (node.scrollHeight - node.clientHeight > 0) return node.scrollHeight - node.clientHeight;
        node = node.parentElement;
      }
      return 0;
    });
    expect(transcriptOverflow).toBeGreaterThan(0);

    expect(await shellOverflow(page)).toBe(0);
  });

  test('a long queue scrolls the list, not the console', async ({ page }) => {
    // The conversation list has the same shape of defect: every row carries an
    // `sr-only` timestamp, and the list is its own scroll container.
    const socket = await mockBackend(page);
    await page.goto('/inbox');
    await expect(page.getByText('Priya').first()).toBeVisible({ timeout: 20_000 });

    socket.send({
      type: 'queue_update',
      count: 40,
      waiting: Array.from({ length: 40 }, (_, index) => ({
        session_id: `sess-waiting-${index}`,
        name: `Visitor ${index}`,
        reason: 'Asked for a person',
        bot_id: 1,
        bot_name: 'Acme Bot',
        created_at: new Date(Date.now() - index * 60_000).toISOString(),
      })),
    });

    const list = page.getByRole('listbox');
    await expect(list.getByText('Visitor 0')).toBeVisible();
    expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

    expect(await shellOverflow(page)).toBe(0);
  });
});
