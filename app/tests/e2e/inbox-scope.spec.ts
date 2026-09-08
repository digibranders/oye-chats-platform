import { expect, test } from '@playwright/test';

import { BOT_ID, mockBackend } from './mockBackend';

/**
 * The scope the inbox opens on, and why it is the wide one.
 *
 * The console shipped with four narrow scopes and no wide one, opening on
 * Waiting. That made the operator's first question "which bucket is it in?"
 * rather than "who needs me?": a visitor sitting in the queue was invisible
 * from Yours, a message left overnight was invisible from both, and every
 * scope but the open one was a number in a dropdown the operator had to
 * remember to check.
 *
 * These two cases are the whole contract. All is what a bare `/inbox` opens
 * on, and All means all: rows from different sources in one list, sorted
 * together.
 */
test.describe('Inbox scope', () => {
  test('opens on All, not on one bucket', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/inbox');

    const scope = page.getByRole('combobox', { name: /conversation scope/i });
    // The mocked account has exactly one conversation: the restored live chat.
    await expect(scope).toHaveText(/^All \(1\)$/, { timeout: 20_000 });
  });

  test('puts a waiting visitor and an open chat in the same list', async ({ page }) => {
    const socket = await mockBackend(page);
    await page.goto('/inbox');

    // Priya is a restored active chat, so she belongs to Yours.
    await expect(page.getByText('Priya').first()).toBeVisible({ timeout: 20_000 });

    // Farid is in the queue, so he belongs to Waiting. Under the old default
    // only one of the two could ever be on screen at a time.
    socket.send({
      type: 'queue_update',
      count: 1,
      waiting: [
        {
          session_id: 'sess-e2e-waiting',
          name: 'Farid',
          reason: 'Asked for a person',
          bot_id: BOT_ID,
          bot_name: 'Acme Bot',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const list = page.getByRole('listbox', { name: /all conversations/i });
    await expect(list.getByText('Farid')).toBeVisible();
    await expect(list.getByText('Priya')).toBeVisible();
  });
});
