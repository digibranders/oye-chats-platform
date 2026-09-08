import { expect, test } from '@playwright/test';

import { type HistoryMessage, mockBackend } from './mockBackend';

/**
 * A transcript rebuilt from history, and the four things that were silently
 * missing from it.
 *
 * `parseHistoryMessage` read `m.created_at`; `GET /chat/history` sends the
 * field as `timestamp`. Every restored message therefore had a null clock, and
 * the four features keyed off it all failed quietly: no time under a message,
 * no day divider, no run grouping (an avatar beside every single message), and
 * no "Seen". A unit test of the parser pins the parse. This pins what the
 * operator actually sees, which is the half that made the defect invisible for
 * so long — nothing errored, the screen was simply poorer.
 *
 * It also covers the AI having no bubble, because that and the measure are
 * layout facts and jsdom computes no layout.
 */

/** Two days, and a run of three from one speaker inside the second. */
const HISTORY: HistoryMessage[] = [
  { id: 1, role: 'user', content: 'hello buddy', timestamp: '2026-09-07T09:15:00.000Z' },
  { id: 2, role: 'bot', content: 'Welcome back! What brings you here today?', timestamp: '2026-09-07T09:15:30.000Z' },
  { id: 3, role: 'user', content: 'i want to implement the soc', timestamp: '2026-09-08T10:56:00.000Z' },
  { id: 4, role: 'bot', content: 'That sounds like a **SOC build-out**.', timestamp: '2026-09-08T10:56:20.000Z' },
  { id: 5, role: 'operator', content: 'Happy to help with that.', timestamp: '2026-09-08T10:58:00.000Z' },
  { id: 6, role: 'operator', content: 'What is your timeline?', timestamp: '2026-09-08T10:58:10.000Z' },
  { id: 7, role: 'operator', content: 'And your team size?', timestamp: '2026-09-08T10:58:20.000Z' },
];

test.describe('Inbox transcript', () => {
  test('a conversation rebuilt from history has clocks and day dividers', async ({ page }) => {
    await mockBackend(page, { history: HISTORY });
    await page.goto('/inbox');
    await page.getByText('Priya').first().click({ timeout: 20_000 });

    const pane = page.locator('section[aria-label^="Conversation with"]');
    await expect(pane.getByText('And your team size?')).toBeVisible();

    // A clock under a message. There was not one anywhere before the fix.
    const clocks = pane.locator('p.text-2xs span.figure');
    expect(await clocks.count()).toBeGreaterThan(0);

    // Two calendar days in the payload, so a boundary between them.
    await expect(pane.getByText(/^(Yesterday|7 Sep)/).first()).toBeVisible();
  });

  test('a run from one speaker keeps one avatar, not one per message', async ({ page }) => {
    // Grouping compares two timestamps. With nulls it gave up, so all seven
    // messages were their own group: seven avatars, seven full gaps, which is
    // most of why the pane read as a wall.
    await mockBackend(page, { history: HISTORY });
    await page.goto('/inbox');
    await page.getByText('Priya').first().click({ timeout: 20_000 });

    const pane = page.locator('section[aria-label^="Conversation with"]');
    await expect(pane.getByText('And your team size?')).toBeVisible();

    // The three operator turns are one run, so the screen-reader speaker label
    // is written once for them rather than three times.
    expect(await pane.getByText('You:').count()).toBe(1);
  });

  test('the AI is plain text and the people are bubbles', async ({ page }) => {
    await mockBackend(page, { history: HISTORY });
    await page.goto('/inbox');
    await page.getByText('Priya').first().click({ timeout: 20_000 });

    const pane = page.locator('section[aria-label^="Conversation with"]');
    await expect(pane.getByText('SOC build-out')).toBeVisible();

    // Computed, not asserted off class names: this is the one place that can
    // prove the AI's turn paints no ground of its own.
    const grounds = await pane.evaluate((root) => {
      const boxOf = (needle: string): string | null => {
        const hit = [...root.querySelectorAll('div')].find(
          (el) => el.className.includes('max-w-[min(34rem') && el.textContent?.includes(needle),
        );
        const box = hit?.firstElementChild as HTMLElement | undefined;
        return box ? getComputedStyle(box).backgroundColor : null;
      };
      return {
        ai: boxOf('SOC build-out'),
        visitor: boxOf('i want to implement the soc'),
        operator: boxOf('And your team size?'),
      };
    });

    // Transparent: the AI's words sit on the pane, not in a box on it.
    expect(grounds.ai).toBe('rgba(0, 0, 0, 0)');
    expect(grounds.visitor).not.toBe('rgba(0, 0, 0, 0)');
    expect(grounds.operator).not.toBe('rgba(0, 0, 0, 0)');
    expect(grounds.visitor).not.toBe(grounds.operator);
  });
});
