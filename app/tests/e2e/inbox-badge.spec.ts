import { expect, test } from '@playwright/test';

import { mockBackend } from './mockBackend';

/**
 * The rail's Inbox badge, and the one thing it must not go back to being.
 *
 * It used to be counted in the shell from the notifications feed — every
 * unread `handoff_request` row. Notifications stay unread until somebody
 * clears them, so the rail said "6" beside Inbox for visitors who had asked
 * for a person weeks earlier and long since left, on the same screen where the
 * inbox itself said `Waiting (0)`. The badge is labelled "waiting", so it was
 * not merely confusing: it asserted that six people needed help when none did.
 *
 * The first case is the regression. It serves six unread handoff notifications
 * AND an empty queue, which is exactly the state that produced the wrong badge,
 * and requires the rail to stay quiet.
 */

const STALE_HANDOFFS = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  type: 'handoff_request',
  title: 'A visitor asked for a person',
  is_read: false,
}));

test.describe('Inbox badge', () => {
  test('stays quiet when old handoff notifications are unread but nobody is waiting', async ({
    page,
  }) => {
    await mockBackend(page, { waitingCount: 0, notifications: STALE_HANDOFFS });
    await page.goto('/');

    const inbox = page.getByRole('complementary').getByRole('link', { name: /^Inbox/ });
    await expect(inbox).toBeVisible({ timeout: 20_000 });
    // Not "no 6" — no count at all. A badge reading 0 is still a badge.
    await expect(inbox).not.toContainText(/\d/);
  });

  test('shows the number of visitors actually waiting', async ({ page }) => {
    await mockBackend(page, { waitingCount: 3, notifications: STALE_HANDOFFS });
    await page.goto('/');

    const inbox = page.getByRole('complementary').getByRole('link', { name: /^Inbox/ });
    await expect(inbox).toBeVisible({ timeout: 20_000 });
    // Three waiting, six unread notifications: the badge follows the queue.
    await expect(inbox).toContainText('3');
  });
});
