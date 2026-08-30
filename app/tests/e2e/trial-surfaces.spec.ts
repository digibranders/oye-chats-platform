import { expect, test } from '@playwright/test';

import { API, assertPageHitMock, mockBackend } from './mockBackend';

/**
 * The two trial surfaces, in a real browser and a real layout.
 *
 * The unit tests already cover the states in isolation. What they cannot cover
 * is everything that only exists once the shell is assembled: that the rail
 * renders the card at all and puts it where the copy claims it is, that the
 * banner pushes the chrome down instead of painting over it, and that a
 * dismissal written to localStorage survives a reload. That last one is the
 * reason this file exists: the banner shipped once reading its dismissal key
 * before the session query resolved, so it wrote under one key and read under
 * another, and came back on every navigation. jsdom cannot catch the ordering
 * because it does not do a second page load.
 */

/** Comfortably inside the trial, credits nowhere near binding. */
const COUNTING_DAYS = {
  status: 'trialing',
  trial_end_at: '2026-09-08T00:00:00.000Z',
  days_remaining: 9,
  credits_granted: 500,
};

test.describe('Trial surfaces', () => {
  test('a paying account sees neither the card nor the banner', async ({ page }) => {
    // The default mock is a Professional account with no trial block, which is
    // what most of the console is exercised against. Both surfaces read the
    // same absent payload, so this guards them together.
    await mockBackend(page);
    await page.goto('/');
    await assertPageHitMock(page);

    const rail = page.getByRole('complementary');
    await expect(rail.getByRole('link', { name: 'Home' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('trial-card')).toHaveCount(0);
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  });

  test('counts the days down in the rail and in the banner', async ({ page }) => {
    await mockBackend(page, { trial: COUNTING_DAYS });
    await page.goto('/');

    const card = page.getByTestId('trial-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('9 days left in your trial');
    await expect(card.getByRole('link', { name: /Upgrade/ })).toBeVisible();

    // The two surfaces read one query, so they can never disagree about the
    // count. Asserting both here is what would fail if that ever split.
    const banner = page.getByTestId('trial-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('9 days left');
  });

  test('the banner is a layout row above the top bar, not an overlay on it', async ({ page }) => {
    // The impersonation bar this sits beside was `position: fixed` once and
    // covered the top bar outright, so the shell hung below the fold. A visible
    // element proves nothing here: the question is whether it took up space.
    await mockBackend(page, { trial: COUNTING_DAYS });
    await page.goto('/');

    const banner = page.getByTestId('trial-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });

    const bannerBox = await banner.boundingBox();
    const headerBox = await page.getByRole('banner').boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(headerBox!.y + 1);
  });

  test('the card sits directly above Billing, where the copy says it does', async ({ page }) => {
    await mockBackend(page, { trial: COUNTING_DAYS });
    await page.goto('/');

    const rail = page.getByRole('complementary');
    const card = page.getByTestId('trial-card');
    await expect(card).toBeVisible({ timeout: 20_000 });

    const cardBox = await card.boundingBox();
    const billingBox = await rail.getByRole('link', { name: 'Billing' }).boundingBox();
    const homeBox = await rail.getByRole('link', { name: 'Home' }).boundingBox();
    expect(cardBox).not.toBeNull();
    expect(billingBox).not.toBeNull();
    expect(homeBox).not.toBeNull();
    // Above Billing, and below the navigation proper: it is a fact about the
    // account, not another destination.
    expect(cardBox!.y).toBeLessThan(billingBox!.y);
    expect(cardBox!.y).toBeGreaterThan(homeBox!.y);
  });

  test('shows credits instead of days when credits are the binding constraint', async ({ page }) => {
    // 20 of 500 credits against 9 of 14 days: the credits run out first, so the
    // days are a true and useless number to put in front of this customer.
    await mockBackend(page, { trial: COUNTING_DAYS, creditsRemaining: 20 });
    await page.goto('/');

    const card = page.getByTestId('trial-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('20 credits left in your trial');
    await expect(card).not.toContainText('days left in your trial');
  });

  test('a customer who has already bought is told what starts and when, with no CTA', async ({
    page,
  }) => {
    await mockBackend(page, {
      trial: {
        status: 'trialing',
        days_remaining: 6,
        credits_granted: 500,
        paid_plan_starts_at: '2026-09-05T00:00:00.000Z',
        paid_plan_name: 'Standard',
      },
    });
    await page.goto('/');

    const card = page.getByTestId('trial-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Standard starts in 6 days');
    // Selling to someone who has already paid. The card must carry no Upgrade
    // link, and the banner must not appear at all.
    await expect(card.getByRole('link', { name: /Upgrade/ })).toHaveCount(0);
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  });

  test('a dismissal survives a reload, and the card does not go with it', async ({ page }) => {
    await mockBackend(page, { trial: COUNTING_DAYS });
    await page.goto('/');

    const banner = page.getByTestId('trial-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);

    await page.reload();
    // The standing fact stays; only the interruption was dismissed.
    await expect(page.getByTestId('trial-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  });

  test('the banner comes back inside three days regardless of the dismissal', async ({ page }) => {
    await mockBackend(page, { trial: COUNTING_DAYS });
    await page.goto('/');

    const banner = page.getByTestId('trial-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);

    // Same browser, same stored dismissal, three days left. "Stop telling me"
    // is reasonable on day four and not on day thirteen, when the consequence
    // is the customer's chatbot going quiet. Only the payload moves: rerunning
    // the whole harness would also re-register the socket, and the thing under
    // test is what the shell does with a dismissal it already holds.
    await page.route(`${API}/auth/me*`, (route) =>
      route.fulfill({
        json: {
          id: 1,
          name: 'Owner',
          email: 'owner@example.com',
          is_verified: true,
          trial: { ...COUNTING_DAYS, days_remaining: 3 },
        },
      }),
    );
    await page.reload();

    await expect(page.getByTestId('trial-banner')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('trial-banner')).toContainText('3 days left');
  });
});
