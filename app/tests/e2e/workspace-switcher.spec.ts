import { expect, test } from '@playwright/test';

import { mockBackend } from './mockBackend';

/**
 * The rail's workspace switcher, in a real layout.
 *
 * The unit tests cover the control. What they cannot cover is the wiring and
 * the placement: that the rail renders it at all, that it sits above the
 * navigation it scopes rather than inside it, and that a solo account gets no
 * empty row where it would have been. All three are things the rebuild got
 * wrong once already — the control existed in the old shell and was dropped
 * with the menu it lived in, and nothing failed.
 */

const OWN = { id: 1, name: 'Acme Corporation', role: 'owner' };
const LINKED = { id: 2, name: 'Globex Support', role: 'operator', operator_role: 'admin' };

test.describe('Workspace switcher', () => {
  test('is absent for an account with a single workspace', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/');

    const rail = page.getByRole('complementary');
    await expect(rail.getByRole('link', { name: 'Home' })).toBeVisible({ timeout: 20_000 });
    await expect(rail.getByRole('combobox', { name: 'Switch workspace' })).toHaveCount(0);
  });

  test('offers every workspace, with the seat held in each', async ({ page }) => {
    await mockBackend(page, { workspaces: [OWN, LINKED] });
    await page.goto('/');

    const rail = page.getByRole('complementary');
    const switcher = rail.getByRole('combobox', { name: 'Switch workspace' });
    await expect(switcher).toBeVisible({ timeout: 20_000 });
    await expect(switcher).toContainText('Acme Corporation');

    await switcher.click();
    await expect(page.getByRole('option', { name: /Acme Corporation/ })).toBeVisible();
    // The seat, not only the name: which workspace is yours and which you were
    // invited into changes what you can do once you are standing in it.
    await expect(page.getByRole('option', { name: /Globex Support/ })).toContainText('Admin');
  });

  test('sits above the navigation it scopes, not inside it', async ({ page }) => {
    // Every destination below it belongs to one workspace, so a switcher
    // rendered among them would read as a peer of Home and Inbox.
    await mockBackend(page, { workspaces: [OWN, LINKED] });
    await page.goto('/');

    const rail = page.getByRole('complementary');
    const switcher = rail.getByRole('combobox', { name: 'Switch workspace' });
    await expect(switcher).toBeVisible({ timeout: 20_000 });

    const switcherBox = await switcher.boundingBox();
    const homeBox = await rail.getByRole('link', { name: 'Home' }).boundingBox();
    expect(switcherBox).not.toBeNull();
    expect(homeBox).not.toBeNull();
    expect(switcherBox!.y).toBeLessThan(homeBox!.y);
  });

  test('switching lands in the other workspace', async ({ page }) => {
    await mockBackend(page, { workspaces: [OWN, LINKED] });
    await page.goto('/');

    const rail = page.getByRole('complementary');
    const switcher = rail.getByRole('combobox', { name: 'Switch workspace' });
    await expect(switcher).toBeVisible({ timeout: 20_000 });

    await switcher.click();
    await page.getByRole('option', { name: /Globex Support/ }).click();

    // An operator seat lands on the inbox, not the dashboard: it is the only
    // surface that seat has a reason to open on.
    await expect(page).toHaveURL(/\/inbox$/, { timeout: 20_000 });
    await expect(switcher).toContainText('Globex Support');
  });
});
