import { expect, test, type Page } from '@playwright/test';

import { API, mockBackend } from './mockBackend';

/**
 * The lead drawer, in a real browser.
 *
 * Two of its three claims cannot be checked in jsdom, which computes no layout:
 * that the transcript scrolls inside the panel with the tab row still visible,
 * and that dragging the leading edge actually changes the panel's width and
 * that the width survives a reload. The third — the widget's anatomy — is
 * asserted in `WidgetTranscript.test.tsx`; what is checked here is that the
 * drawer is really wired to it, with the chatbot's own colours.
 */

const SESSION = 'sess-lead-1';

/** The chatbot's own palette, which the replay must be painted in. */
const BOT_COLOURS = {
  primary_color: '#2563EB',
  user_bubble_color: '#DBE9FF',
  avatar_type: 'mascot',
};

const LEAD = {
  session_id: SESSION,
  bot_id: 1,
  bot_name: 'Acme Bot',
  score: 82,
  tier: 'sql',
  status: 'sql',
  contact: { name: 'Siddique', email: 'siddique@digibranders.com', company: 'Digibranders' },
  chats: 24,
  created_at: '2026-09-08T10:55:00Z',
  last_active_at: '2026-09-08T11:00:00Z',
};

/** Long enough that the panel has to scroll at any width. */
const HISTORY = Array.from({ length: 40 }, (_, index) => ({
  id: index + 1,
  role: index % 2 === 0 ? 'user' : 'bot',
  content: `Message ${index}, long enough to take a line in the transcript.`,
  timestamp: new Date(Date.parse('2026-09-08T10:00:00Z') + index * 60_000).toISOString(),
}));

async function mockLeads(page: Page): Promise<void> {
  // Registered after `mockBackend`, so these win over its catch-all.
  await page.route(`${API}/leads/stats*`, (route) =>
    route.fulfill({ json: { total: 1, unqualified: 0, mql: 0, sal: 0, sql: 1, avg_score: 82, unread: 0 } }),
  );
  await page.route(`${API}/leads/${SESSION}`, (route) => route.fulfill({ json: LEAD }));
  await page.route(`${API}/leads?*`, (route) =>
    route.fulfill({ json: { leads: [LEAD], total: 1, page: 1, limit: 50 } }),
  );
  await page.route(`${API}/chat/sessions/*/audit`, (route) =>
    route.fulfill({
      json: {
        entries: [
          { action: 'handoff_requested', operator_id: null, details: null, created_at: '2026-09-08T10:38:00Z' },
        ],
      },
    }),
  );
  await page.route(`${API}/chat/history/**`, (route) => route.fulfill({ json: HISTORY }));
}

async function openConversation(page: Page): Promise<void> {
  await page.goto(`/leads?lead=${SESSION}&tab=conversation`);
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Message 39, long enough to take a line in the transcript.')).toBeVisible();
  // The panel slides in, and `toBeVisible` does not wait for that. A box read
  // mid-animation is a box the panel is no longer in, which put a drag's
  // mouse-down 400px away from the handle it was aiming at.
  await expect
    .poll(() => page.getByRole('dialog').evaluate((node) => node.getAnimations().length))
    .toBe(0);
}

function panelWidth(page: Page): Promise<number> {
  return page
    .getByRole('dialog')
    .evaluate((node) => Math.round(node.getBoundingClientRect().width));
}

test.describe('Lead drawer', () => {
  test('scrolls the transcript, keeping the tab row and the header in place', async ({ page }) => {
    await mockBackend(page, { bot: BOT_COLOURS });
    await mockLeads(page);
    await openConversation(page);

    const tabs = page.getByRole('tab', { name: /conversation/i });
    await expect(tabs).toBeVisible();

    const scroll = await page.evaluate(() => {
      const panel = document.querySelector('[role="tabpanel"]') as HTMLElement | null;
      if (!panel) throw new Error('the conversation panel is missing');
      const before = panel.getBoundingClientRect().top;
      panel.scrollTop = panel.scrollHeight;
      return {
        overflow: panel.scrollHeight - panel.clientHeight,
        moved: panel.getBoundingClientRect().top - before,
      };
    });

    // The panel is genuinely the scroller...
    expect(scroll.overflow).toBeGreaterThan(0);
    // ...and scrolling it moves nothing else: the row used to be the first item
    // inside the drawer's own scroller and slid away with the messages, taking
    // the only route back to the Profile tab with it.
    expect(scroll.moved).toBe(0);
    await expect(tabs).toBeInViewport();
    await expect(page.getByRole('heading', { name: 'Siddique' })).toBeInViewport();
  });

  test('paints the replay in the chatbot’s own colours, not the console’s', async ({ page }) => {
    await mockBackend(page, { bot: BOT_COLOURS });
    await mockLeads(page);
    await openConversation(page);

    // The visitor's turns, and only theirs, are bubbles in the chatbot's colour.
    const bubble = page.locator('[data-widget-bubble]').first();
    await expect(bubble).toHaveCSS('background-color', 'rgb(219, 233, 255)');
    const botRows = await page.locator('[data-widget-role="bot"] [data-widget-bubble]').count();
    expect(botRows).toBe(0);

    // The handoff is a line in the conversation at the moment it happened, not
    // a disclosure filed under the last message.
    await expect(page.getByText('Requested a person')).toBeVisible();
  });

  test('remembers the width the reader dragged it to', async ({ page }) => {
    await mockBackend(page, { bot: BOT_COLOURS });
    await mockLeads(page);
    await openConversation(page);

    const resting = await panelWidth(page);

    const handle = page.getByRole('separator', { name: /resize the panel/i });
    await handle.hover();
    const box = await handle.boundingBox();
    if (!box) throw new Error('the resize handle has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Toward the page: the panel is at the inline end, so left is wider.
    await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const dragged = await panelWidth(page);
    expect(dragged).toBeGreaterThan(resting + 100);

    // The point of remembering it: a width chosen once should not have to be
    // chosen again on every lead.
    await page.reload();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 });
    expect(await panelWidth(page)).toBe(dragged);
  });

  test('will not be dragged so wide that the page behind it disappears', async ({ page }) => {
    await mockBackend(page, { bot: BOT_COLOURS });
    await mockLeads(page);
    await openConversation(page);

    const handle = page.getByRole('separator', { name: /resize the panel/i });
    await handle.focus();
    await page.keyboard.press('End');

    const width = await panelWidth(page);
    const viewport = page.viewportSize()?.width ?? 0;
    // A drawer that covers the page is a route change wearing a scrim.
    expect(viewport - width).toBeGreaterThanOrEqual(320);
  });
});
