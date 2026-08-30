import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { API, mockBackend } from './mockBackend';

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
 *
 * Every payload below is the shape `_build_trial_payload` actually returns
 * (`api/app/api/auth_routes.py`), not a plausible-looking one. The first
 * version of this file sent `status: 'trialing'` for a customer who had
 * bought, a state the backend cannot produce, and the whole file went on
 * passing through a mutation that blanked the bought card for every real
 * customer.
 */

/** Comfortably inside the trial, credits nowhere near binding. */
const COUNTING_DAYS = {
  status: 'trialing',
  trial_end_at: '2026-09-08T00:00:00.000Z',
  days_remaining: 9,
  credits_granted: 500,
  trial_days: 14,
};

/**
 * Wait for the SESSION query to land before asserting a surface is absent.
 *
 * The rail's nav is static, so syncing on a nav link proves only that the
 * bundle booted: an absence assertion could settle before `/auth/me` resolved
 * and pass for an account that does have a trial. The account name comes from
 * the same query the trial surfaces read, so it is the honest sync point.
 */
async function sessionLoaded(page: Page): Promise<void> {
  // The email, not the name: "Owner" also matches "owner@example.com" and the
  // strict locator refuses the ambiguity.
  await expect(page.getByRole('complementary').getByText('owner@example.com')).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Wait until the credit balance has been served AND rendered.
 *
 * The card shows days until the balance query resolves, and only then decides
 * whether credits are the binding constraint. So "N days left" is ALSO the
 * pre-resolution frame, and a retrying assertion for it settles on that frame
 * and passes whatever the comparison would have concluded. Two specs here
 * flipped between runs before this existed, and the trial-length spec passed
 * under the very mutation it was written to catch.
 *
 * Waiting for the response is not enough on its own; React still has to render
 * it. Two animation frames after the response is the flush point, and the
 * mutation runs below confirm it: with the server's trial length ignored, both
 * specs that use this fail every time.
 */
async function balanceSettled(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

/** Geometry, read through a retrying assertion rather than once. */
async function box(page: Page, testId: string) {
  return expect
    .poll(async () => (await page.getByTestId(testId).boundingBox()) ?? null, { timeout: 10_000 })
    .not.toBeNull()
    .then(() => page.getByTestId(testId).boundingBox());
}

test.describe('Trial surfaces', () => {
  test('a paying account sees neither the card nor the banner', async ({ page }) => {
    // The default mock is a Professional account with no trial block, which is
    // what most of the console is exercised against. Both surfaces read the
    // same absent payload, so this guards them together.
    await mockBackend(page);
    await page.goto('/');
    await sessionLoaded(page);

    await expect(page.getByTestId('trial-card')).toHaveCount(0);
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  });

  test('counts the days down in the rail and in the banner', async ({ page }) => {
    await mockBackend(page, { trial: COUNTING_DAYS });
    const balance = page.waitForResponse((r) => r.url().includes('/credits/balance'));
    await page.goto('/');

    const card = page.getByTestId('trial-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    // 500 of 500 credits against 9 of 14 days: days bind, and they must still
    // bind once the balance is in hand rather than only before it arrives.
    await balance;
    await balanceSettled(page);
    await expect(card).toContainText('9 days left in your trial');
    await expect(card).not.toContainText('credits left in your trial');
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
    await expect(page.getByTestId('trial-banner')).toBeVisible({ timeout: 20_000 });

    const bannerBox = await box(page, 'trial-banner');
    const headerBox = await page.getByRole('banner').boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(headerBox!.y + 1);
  });

  test('the card sits DIRECTLY above Billing, where the copy says it does', async ({ page }) => {
    await mockBackend(page, { trial: COUNTING_DAYS });
    await page.goto('/');

    const rail = page.getByRole('complementary');
    await expect(page.getByTestId('trial-card')).toBeVisible({ timeout: 20_000 });

    const cardBox = await box(page, 'trial-card');
    const billingBox = await rail.getByRole('link', { name: 'Billing' }).boundingBox();
    expect(cardBox).not.toBeNull();
    expect(billingBox).not.toBeNull();
    // Adjacency, not "somewhere above". An earlier version of this spec only
    // bracketed the card between Home and Billing, and passed with the card
    // moved out of the footer entirely to the middle of the rail, which is
    // exactly what the Rail's own "Directly above Billing" comment forbids.
    const gap = billingBox!.y - (cardBox!.y + cardBox!.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(12);
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

  test('the trial length in the comparison is the server\'s, not a constant', async ({ page }) => {
    // 250 of 500 credits with 8 days left: binding on a 14-day trial (0.50 <
    // 0.57) and NOT binding on a 30-day one (0.50 > 0.27). The denominator was
    // hardcoded to 14 in the client while the numerator came from the payload,
    // so a super-admin retuning `plans.trial_days` would have mis-classified
    // every account silently. Same numbers, two trial lengths, two answers.
    const half = { ...COUNTING_DAYS, days_remaining: 8, credits_granted: 500 };
    await mockBackend(page, { trial: { ...half, trial_days: 14 }, creditsRemaining: 250 });
    await page.goto('/');
    await expect(page.getByTestId('trial-card')).toContainText('250 credits left in your trial', {
      timeout: 20_000,
    });

    await page.route(`${API}/auth/me*`, (route) =>
      route.fulfill({
        json: {
          id: 1,
          name: 'Owner',
          email: 'owner@example.com',
          is_verified: true,
          trial: { ...half, trial_days: 30 },
        },
      }),
    );
    const balance = page.waitForResponse((r) => r.url().includes('/credits/balance'));
    await page.reload();
    await expect(page.getByTestId('trial-card')).toBeVisible({ timeout: 20_000 });
    await balance;
    await balanceSettled(page);
    await expect(page.getByTestId('trial-card')).toContainText('8 days left in your trial');
    await expect(page.getByTestId('trial-card')).not.toContainText('credits left in your trial');
  });

  test('a trial with no end date says nothing rather than "0 days left"', async ({ page }) => {
    // `days_remaining` is `int | None`: it is null whenever the row's
    // `trial_end` is null. Read as zero, the card announced "0 days left in
    // your trial" to someone whose trial has not been dated. The banner has
    // always guarded this; the card did not.
    await mockBackend(page, { trial: { ...COUNTING_DAYS, trial_end_at: null, days_remaining: null } });
    await page.goto('/');
    await sessionLoaded(page);

    await expect(page.getByTestId('trial-card')).toHaveCount(0);
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  });

  test('a customer who has already bought is told what starts and when, with no CTA', async ({
    page,
  }) => {
    // `status: 'active'` is not a detail. The bought branch of
    // `_build_trial_payload` is reachable ONLY through a subscription in
    // `active`, and it returns that row's status, so `trialing` here is a
    // payload no account can produce. With the wrong status this spec passed
    // through a mutation that returned null for every non-trialing row, which
    // blanks this card for every real customer who has paid.
    await mockBackend(page, {
      trial: {
        status: 'active',
        trial_end_at: '2026-09-05T00:00:00.000Z',
        days_remaining: 6,
        credits_granted: 500,
        trial_days: 0,
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

    // Establish that the dismissal is LIVE in the load the override runs in.
    // Without this step the spec cannot tell "urgency beat a dismissal" from
    // "the dismissal was never persisted", and it passed unchanged with
    // persistence removed entirely.
    await page.reload();
    await expect(page.getByTestId('trial-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('trial-banner')).toHaveCount(0);

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
