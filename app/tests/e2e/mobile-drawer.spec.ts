import { devices, expect, test } from '@playwright/test';

import { mockBackend } from './mockBackend';

/**
 * The rail as a phone drawer.
 *
 * Below 1024px the rail is a dialog, and the account menu at its foot used to
 * open to the right of it, the way it does beside the desktop column. A 224px
 * drawer plus a 256px panel needs 486px; a phone has about 400. The panel was
 * cut off at the screen edge and ran under the bottom of the viewport, so
 * "Account settings" and "Sign out" could not be reached from a phone at all.
 *
 * Playwright cannot raise a phone browser's bottom toolbar or draw
 * edge-to-edge, so the drawer's height fix is pinned by its shape (the small
 * viewport from the top, with the safe-area inset) rather than reproduced.
 */

test.use({ ...devices['Pixel 7'] });

async function openDrawer(page: import('@playwright/test').Page) {
  await mockBackend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer.getByRole('link', { name: 'Home' })).toBeVisible({ timeout: 20_000 });
  return drawer;
}

test.describe('Phone drawer', () => {
  test('the account row is inside the visible viewport', async ({ page }) => {
    const drawer = await openDrawer(page);
    const account = drawer.getByRole('button', { name: 'Account' });
    await expect(account).toBeVisible();

    const viewport = page.viewportSize()!;
    // Measured after the slide-in has landed: a box mid-animation is offset.
    await expect
      .poll(async () => (await account.boundingBox())!.x, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(0);
    const box = (await account.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });

  test('the account menu opens inside the drawer, fully on screen', async ({ page }) => {
    const drawer = await openDrawer(page);
    const account = drawer.getByRole('button', { name: 'Account' });
    await expect
      .poll(async () => (await account.boundingBox())!.x, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(0);
    await account.click();

    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Account settings' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();

    const viewport = page.viewportSize()!;
    const drawerBox = (await drawer.boundingBox())!;
    // Settled: the pop-in scales from 0.96, so wait for the final width.
    await expect
      .poll(async () => (await menu.boundingBox())!.width, { timeout: 5_000 })
      .toBeLessThanOrEqual(drawerBox.width);
    const menuBox = (await menu.boundingBox())!;
    const accountBox = (await account.boundingBox())!;

    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    // Above the row that opened it, not beside it.
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(accountBox.y);
  });

  test('the drawer is sized to the small viewport, from the top', async ({ page }) => {
    const drawer = await openDrawer(page);
    const shape = await drawer.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { position: style.position, top: rect.top, height: rect.height, paddingBottom: style.paddingBottom };
    });
    const viewport = page.viewportSize()!;
    expect(shape.position).toBe('fixed');
    expect(shape.top).toBe(0);
    // No browser chrome in emulation, so svh is the viewport; the inset is 0.
    expect(shape.height).toBe(viewport.height);
    expect(shape.paddingBottom).toBe('0px');
  });
});
