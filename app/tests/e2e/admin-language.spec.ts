/**
 * Phase 7B: the dashboard's own interface language.
 *
 * Asserting that Hindi APPEARS is only half a test. A screen that renders both
 * languages at once passes a presence-only check while being visibly broken, so
 * every case below also asserts the English original is GONE. That pairing is
 * what catches a component holding a string frozen at mount.
 *
 * The separation from `Operator.preferred_locale` is asserted too: switching
 * the dashboard language must never issue a write to the operator's live-chat
 * working language, because that field is metered and drives translation.
 */

import { expect, test, type Page } from '@playwright/test';

import { mockBackend } from './mockBackend';

const SETTINGS = '/settings';

async function openAppearance(page: Page): Promise<void> {
  await page.goto(SETTINGS);
  await expect(page.getByRole('radio', { name: 'हिन्दी' })).toBeVisible({ timeout: 20_000 });
}

test.describe('Dashboard language selector', () => {
  test('offers English and Hindi, and starts on English', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);

    await expect(page.getByRole('radio', { name: 'English' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'हिन्दी' })).toBeVisible();
    // English is the default, so the English original must be on screen.
    await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
  });

  test('switching to Hindi replaces the English chrome', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);

    await page.getByRole('radio', { name: 'हिन्दी' }).click();

    // PRESENT: the translated copy.
    await expect(page.getByText('रूप', { exact: true })).toBeVisible();
    await expect(page.getByText('थीम', { exact: true })).toBeVisible();
    // ABSENT: the English originals it replaced. This is the assertion that
    // catches a half-translated screen.
    await expect(page.getByText('Appearance', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Theme', { exact: true })).toHaveCount(0);
  });

  test('the sidebar follows, so nav is not left in the previous language', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);

    // Scoped by ROLE, not by accessible name. The sidebar landmark's own label
    // is itself localized, so scoping by "Primary navigation" stops matching
    // the moment the test does the thing it is testing. Scoping is still
    // required: the breadcrumb renders its own "Home" link.
    const nav = page.getByRole('complementary');
    await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
    await page.getByRole('radio', { name: 'हिन्दी' }).click();

    await expect(nav.getByRole('link', { name: 'होम' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Home' })).toHaveCount(0);
  });

  test('the choice survives a reload', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);
    await page.getByRole('radio', { name: 'हिन्दी' }).click();
    await expect(page.getByText('रूप', { exact: true })).toBeVisible();

    await page.reload();

    await expect(page.getByText('रूप', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Appearance', { exact: true })).toHaveCount(0);
  });

  test('switching back restores English exactly', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);

    await page.getByRole('radio', { name: 'हिन्दी' }).click();
    await expect(page.getByText('रूप', { exact: true })).toBeVisible();

    await page.getByRole('radio', { name: 'English' }).click();

    await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
    await expect(page.getByText('रूप', { exact: true })).toHaveCount(0);
  });

  test('the group is reachable and operable by keyboard', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);

    // Only the checked option is in the tab order, matching the Theme and
    // Contrast groups; arrow keys move AND select, like native radios.
    await page.getByRole('radio', { name: 'English' }).focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.getByRole('radio', { name: 'हिन्दी' })).toBeFocused();
    await expect(page.getByText('रूप', { exact: true })).toBeVisible();
  });

  test('sets document lang, and never flips direction for an LTR language', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);

    await page.getByRole('radio', { name: 'हिन्दी' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'hi-IN');
    // RTL is out of scope for Phase 7 and Hindi is LTR; a stray dir flip here
    // would mirror ~216 physical Tailwind classes with nothing to catch it.
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('does NOT write the operator live-chat language', async ({ page }) => {
    await mockBackend(page);

    // Dashboard UI locale and Operator.preferred_locale are different things:
    // one is per-device presentation, the other is a metered translation
    // target. A write here would start translating conversations, and bill for
    // it, because someone changed a menu language.
    const operatorLanguageWrites: string[] = [];
    await page.route('**/operators/me/language', (route) => {
      if (route.request().method() !== 'GET') {
        operatorLanguageWrites.push(route.request().method());
      }
      return route.fulfill({ json: { preferred_locale: null, available: [] } });
    });

    await openAppearance(page);
    await page.getByRole('radio', { name: 'हिन्दी' }).click();
    await expect(page.getByText('रूप', { exact: true })).toBeVisible();

    expect(operatorLanguageWrites).toEqual([]);
  });

  test('stores the locale per device, not on the server', async ({ page }) => {
    await mockBackend(page);
    await openAppearance(page);
    await page.getByRole('radio', { name: 'हिन्दी' }).click();
    await expect(page.getByText('रूप', { exact: true })).toBeVisible();

    const stored = await page.evaluate(() => window.localStorage.getItem('oc_ui_locale'));
    expect(stored).toBe('hi-IN');
  });
});
