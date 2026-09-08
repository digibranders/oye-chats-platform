import { expect, test } from '@playwright/test';

import { BOT_ID, mockBackend } from './mockBackend';

/**
 * What the Deploy page puts where, and the one thing it must not print twice.
 *
 * It used to open with a card headed "Add this to your website" carrying the
 * script tag, directly beside a platform guide whose first step carried the
 * same tag — in the form the customer's own stack needs, which the generic one
 * was not. Two snippets on one screen, the wrong one first and largest, and the
 * hand-off controls ("email this to my developer") stranded under the copy
 * nobody should follow.
 *
 * A browser test rather than jsdom because the claim is about layout: which
 * card comes first, and what sits inside which.
 */

async function openDeploy(page: import('@playwright/test').Page): Promise<void> {
  await mockBackend(page);
  await page.goto(`/chatbots/${BOT_ID}/deploy`);
  await expect(page.getByRole('heading', { name: 'Deploy', level: 1 })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('Deploy layout', () => {
  test('prints the install snippet once, not twice', async ({ page }) => {
    await openDeploy(page);

    // `pre` only: `CodeBlock` nests a `code` inside one, so counting both
    // double-counts a single snippet.
    const tags = await page.evaluate(() =>
      [...document.querySelectorAll('pre')].filter((node) =>
        (node.textContent ?? '').includes('oyechats-widget.js'),
      ).length,
    );
    expect(tags).toBe(1);
    await expect(page.getByText('Add this to your website')).toHaveCount(0);
  });

  test('opens on the platform instructions', async ({ page }) => {
    await openDeploy(page);
    // First card in the reading order, and its tab is the one selected.
    await expect(
      page.getByRole('tab', { name: 'Instructions for your platform' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps the hand-off with the instructions it hands off', async ({ page }) => {
    // The embed key and the two ways to give this job to somebody else are the
    // part of the old card that was NOT duplicated. They belong under the
    // steps, where a reader who has just read them and cannot do them is
    // standing.
    await openDeploy(page);

    // "Inside the same card" as a containment fact rather than a class name:
    // the hand-off shares a tighter ancestor with the instructions tab than
    // the Access heading further down the column does.
    const nesting = await page.evaluate(() => {
      const byText = (selector: string, re: RegExp): Element | undefined =>
        [...document.querySelectorAll(selector)].find((node) => re.test(node.textContent ?? ''));

      const tab = byText('[role="tab"]', /Instructions for your platform/);
      const email = byText('button', /email this to my developer/i);
      const prompt = byText('button', /copy a prompt for a coding agent/i);
      const key = byText('p', /Public and safe to commit\./);
      const access = [...document.querySelectorAll('h2, h3')].find(
        (h) => (h.textContent ?? '').trim() === 'Access',
      );
      if (!tab || !email || !prompt || !key || !access) return null;

      const commonAncestor = (a: Element, b: Element): Element | null => {
        const seen = new Set<Element>();
        for (let node: Element | null = a; node; node = node.parentElement) seen.add(node);
        for (let node: Element | null = b; node; node = node.parentElement) {
          if (seen.has(node)) return node;
        }
        return null;
      };

      const card = commonAncestor(tab, email);
      const page_ = commonAncestor(tab, access);
      return {
        inSameCard: card !== null && card !== page_,
        holdsPrompt: card?.contains(prompt) ?? false,
        holdsKey: card?.contains(key) ?? false,
      };
    });

    expect(nesting).toEqual({ inSameCard: true, holdsPrompt: true, holdsKey: true });
  });

  test('answers "is it running" above the fold, not below a column of help', async ({ page }) => {
    // The install reading is what the customer came for. It used to sit under
    // a help card tall enough to push it off the screen.
    await openDeploy(page);

    const status = page.getByRole('heading', { name: /waiting to be installed|live on your website/i });
    const access = page.getByRole('heading', { name: 'Access' });

    const statusBox = await status.boundingBox();
    const accessBox = await access.boundingBox();
    if (!statusBox || !accessBox) throw new Error('missing status or access heading');
    expect(statusBox.y).toBeLessThan(accessBox.y);
    // And inside the first screenful of a laptop.
    expect(statusBox.y).toBeLessThan(700);
  });
});
