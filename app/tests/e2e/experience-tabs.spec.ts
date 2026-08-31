import { expect, test } from '@playwright/test';
import { mockBackend } from './mockBackend';
import { SECTION_KEYS } from '../../src/features/agents/experience/experience-model';

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
  await page.goto('/chatbots/1/experience');
  await expect(page.getByRole('tab', { name: 'Branding' })).toBeVisible({ timeout: 20_000 });
}

test.describe('Experience tabs at a narrow width', () => {
  test('every tab can be reached and opened', async ({ page }) => {
    await mockBackend(page);
    await openExperience(page);

    const tabs = page.getByRole('tablist', { name: 'Experience settings' }).getByRole('tab');
    const count = await tabs.count();
    // One tab per `SECTION_KEYS`, imported rather than hardcoded. The literal
    // that used to sit here went stale the moment two sections were added, and
    // failed as a bare "expected 5, received 7" that says nothing about what
    // changed. Importing it means adding a section updates this expectation
    // with it, while still failing loudly if a section stops rendering a tab -
    // which is the defect this file exists to catch.
    expect(count).toBe(SECTION_KEYS.length);

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

    const box = await page.getByRole('tablist', { name: 'Experience settings' }).evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowX: getComputedStyle(el).overflowX,
      parentWidth: el.parentElement?.clientWidth ?? 0,
    }));

    // Scrollable BY CONSTRUCTION, not only while it happens to overflow. The
    // five current tabs fit this column, so asserting that they overflow today
    // would make the guard vacuous the moment it passed; what has to hold is
    // that a strip too wide for its column scrolls rather than spills, which
    // is `overflow-x: auto` plus never being wider than the column itself.
    expect(box.overflowX).toBe('auto');
    expect(box.scrollWidth).toBeGreaterThanOrEqual(box.clientWidth);
    // ...and never wider than the column it sits in, allowing for the one
    // deliberate exception: `TAB_LIST` carries `-mx-3`, which bleeds the strip
    // 12px into the gutter on each side so the first tab's LABEL lines up with
    // the page text rather than its padded box (see `tabStyles.ts`). Anything
    // past that gutter is the strip spilling.
    const GUTTER_BLEED = 24;
    expect(box.clientWidth).toBeLessThanOrEqual(box.parentWidth + GUTTER_BLEED);
    // No vertical overflow: the tabs' `-mb-px` must be absorbed, or a second
    // scrollbar appears beside the horizontal one and eats the row's width.
    expect(box.scrollHeight).toBe(box.clientHeight);
  });

  test('labels stay on one line rather than wrapping when space is tight', async ({ page }) => {
    await mockBackend(page);
    await openExperience(page);

    const height = await page
      .getByRole('tablist', { name: 'Experience settings' })
      .evaluate((el) => el.clientHeight);

    // One row of tabs. Squashed labels wrapped to three lines and pushed this
    // past 90px.
    expect(height).toBeLessThan(60);
  });
});
