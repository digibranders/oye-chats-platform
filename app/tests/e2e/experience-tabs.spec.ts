import { expect, test } from '@playwright/test';
import { mockBackend } from './mockBackend';

/**
 * The agent Experience tab strip, measured in a real layout engine.
 *
 * This exists because a unit test cannot catch it: jsdom has no layout, so the
 * defect below was invisible to the whole suite and only showed up when the
 * page was driven in a browser at a narrow width.
 *
 * What went wrong: the tablist was a plain flex row with no overflow handling.
 * Once the tabs needed more width than their column, the browser compressed
 * them until their labels wrapped onto three lines, and the row STILL spilled
 * sideways underneath the preview panel beside it. Tabs rendered there were
 * painted but not clickable - the hit test resolved to the preview panel - so
 * "Live chat & leads" and "Services & copy" simply could not be opened.
 */

/** The width where the two-column editor/preview grid engages (Tailwind `lg`). */
const NARROW = { width: 1024, height: 800 };

async function openExperience(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize(NARROW);
  await page.goto('/agents/1/experience');
  await expect(page.getByRole('tab', { name: 'Branding' })).toBeVisible({ timeout: 20_000 });
}

test.describe('Experience tabs at a narrow width', () => {
  test('every tab can be reached and opened', async ({ page }) => {
    await mockBackend(page);
    await openExperience(page);

    const tabs = page.getByRole('tablist', { name: 'Experience sections' }).getByRole('tab');
    const count = await tabs.count();
    expect(count).toBe(6);

    for (let i = 0; i < count; i += 1) {
      const tab = tabs.nth(i);
      const label = (await tab.textContent())?.trim() ?? '';
      // `click` fails the test if the element is covered by something else,
      // which is exactly the failure mode being guarded.
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('the strip scrolls sideways instead of overflowing its column', async ({ page }) => {
    await mockBackend(page);
    await openExperience(page);

    const box = await page.getByRole('tablist', { name: 'Experience sections' }).evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowX: getComputedStyle(el).overflowX,
      parentWidth: el.parentElement?.clientWidth ?? 0,
    }));

    // Wider than its column - so it must be scrollable, not spilling.
    expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    expect(box.overflowX).toBe('auto');
    // ...and never wider than the column it sits in.
    expect(box.clientWidth).toBeLessThanOrEqual(box.parentWidth);
    // No vertical overflow: the tabs' `-mb-px` must be absorbed, or a second
    // scrollbar appears beside the horizontal one and eats the row's width.
    expect(box.scrollHeight).toBe(box.clientHeight);
  });

  test('labels stay on one line rather than wrapping when space is tight', async ({ page }) => {
    await mockBackend(page);
    await openExperience(page);

    const height = await page
      .getByRole('tablist', { name: 'Experience sections' })
      .evaluate((el) => el.clientHeight);

    // One row of tabs. Squashed labels wrapped to three lines and pushed this
    // past 90px.
    expect(height).toBeLessThan(60);
  });
});
