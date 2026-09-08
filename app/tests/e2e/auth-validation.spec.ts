import { expect, test, type Page } from '@playwright/test';

/**
 * When the auth forms are allowed to complain, and why it is not on blur.
 *
 * The bug this pins is not a preference about validation timing, it is a
 * swallowed click. Validating on blur renders the error message between a
 * link's `mousedown` and its `mouseup`: the page reflows by the height of that
 * one line, `mouseup` lands on whatever has moved into the pointer's place, and
 * the browser dispatches no `click` at all. Measured on `/register` before the
 * fix — the "Sign in" link sat at y=663, pressing it blurred the empty name
 * field, the error pushed the link to y=680, and nothing happened. The second
 * click worked, because by then the error was already on screen and the page
 * no longer moved.
 *
 * jsdom cannot catch this. It computes no layout, so there is no reflow for a
 * mouseup to miss, and `fireEvent.click` dispatches a click directly rather
 * than deriving one from a press and a release.
 */

/** The auth pages talk to nothing that matters here. */
async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
}

test.describe('Auth form validation', () => {
  test('a link takes one click, not two, when a field was left empty', async ({ page }) => {
    await stubApi(page);
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible({
      timeout: 20_000,
    });

    // Focus a required field and leave it, which is the whole reproduction.
    await page.getByLabel(/your name/i).click();

    const signIn = page.getByRole('link', { name: /^sign in$/i });
    const before = await signIn.boundingBox();
    if (!before) throw new Error('the sign-in link has no box');

    // A real press and release at one point, not `locator.click()`, which
    // re-resolves the element and would paper over exactly this defect.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();

    const during = await signIn.boundingBox();
    if (!during) throw new Error('the sign-in link vanished mid-press');
    // Nothing may move under the pointer while the button is down.
    expect(Math.round(during.y)).toBe(Math.round(before.y));

    await page.mouse.up();
    await expect(page).toHaveURL(/\/login/);
  });

  test('says nothing about a field the visitor has not filled in yet', async ({ page }) => {
    // Passing through a field is not a mistake, and a red line for it is the
    // form telling somebody off for something they have not done.
    await stubApi(page);
    await page.goto('/register');
    await page.getByLabel(/your name/i).click();
    await page.getByLabel(/work email/i).click();

    await expect(page.getByText(/enter your name/i)).toBeHidden();
  });

  test('says everything at once when the visitor says they are finished', async ({ page }) => {
    await stubApi(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account/i }).click();

    // Submitting is the moment the claim "I am done" is made, and the first
    // moment the form has earned a red line.
    await expect(page.getByText(/enter your name/i)).toBeVisible();
    await expect(page.getByText(/enter a valid email|enter your email/i).first()).toBeVisible();
  });

  test('clears an error as it is fixed, without waiting for another submit', async ({ page }) => {
    await stubApi(page);
    await page.goto('/register');
    await page.getByRole('button', { name: /create account/i }).click();

    const nameError = page.getByText(/enter your name/i);
    await expect(nameError).toBeVisible();

    await page.getByLabel(/your name/i).fill('Priya Sharma');
    await expect(nameError).toBeHidden();
  });

  test('holds on the sign-in page too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in|welcome/i })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByLabel(/email/i).click();
    const create = page.getByRole('link', { name: /create an account|sign up/i }).first();
    const before = await create.boundingBox();
    if (!before) throw new Error('the create-account link has no box');

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    const during = await create.boundingBox();
    expect(Math.round(during!.y)).toBe(Math.round(before.y));
    await page.mouse.up();

    await expect(page).toHaveURL(/\/register/);
  });
});
