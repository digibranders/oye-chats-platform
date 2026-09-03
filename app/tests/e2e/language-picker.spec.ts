import { expect, test } from '@playwright/test';
import { mockBackend } from './mockBackend';

/**
 * The language picker offers only what the WIDGET can actually render.
 *
 * The backend catalogue lists every locale the AI converses in. The widget
 * ships UI dictionaries for fewer. Offering the difference put two live
 * customer bots into a state nobody would choose: answers in Spanish or Urdu
 * wrapped in an English interface, and on Urdu a mirrored right-to-left layout
 * with English chrome inside it.
 *
 * Driven in a browser rather than jsdom because the control is a custom
 * Select whose options only exist once it is opened.
 */

async function openLanguageTab(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/chatbots/1/experience');
  await expect(page.getByRole('tab', { name: 'Branding' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: /Language/ }).click();
  await expect(page.getByText('Supported languages', { exact: true })).toBeVisible();
}

test.describe('Language picker', () => {
  test('offers translated languages and withholds the rest', async ({ page }) => {
    // Only English selected, so Hindi is genuinely addable and the control is
    // enabled. With both already chosen there is nothing left to add and the
    // picker is disabled, which would prove nothing.
    await mockBackend(page, {
      bot: {
        language_config: {
          enabled: true,
          default_locale: 'en-IN',
          supported_locales: ['en-IN'],
          operator_translation_enabled: false,
        },
      },
    });
    await openLanguageTab(page);

    await page.getByLabel('Add a language').click();

    // Hindi has a widget dictionary and is offered.
    await expect(page.getByRole('option', { name: /Hindi/ })).toBeVisible();
    // French and Urdu are in the catalogue but have none, so they must not be
    // selectable at all.
    await expect(page.getByRole('option', { name: /French/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /Urdu/ })).toHaveCount(0);
  });

  test('explains why the list is short', async ({ page }) => {
    await mockBackend(page);
    await openLanguageTab(page);
    await expect(
      page.getByText(/Only languages the chat widget itself is translated into can be added/i),
    ).toBeVisible();
  });

  test('a language already saved stays visible, flagged and removable', async ({ page }) => {
    // Exactly the state the two live bots are in. Filtering the picker does not
    // clean up stored config, and a customer who cannot see it cannot fix it.
    await mockBackend(page, {
      bot: {
        language_config: {
          enabled: true,
          default_locale: 'en-IN',
          supported_locales: ['en-IN', 'ur-PK'],
          operator_translation_enabled: true,
        },
      },
    });
    await openLanguageTab(page);

    await expect(page.getByLabel('Remove Urdu (Pakistan)')).toBeVisible();
    // The live region carries its heading as content, not as an accessible
    // name, so it is filtered by text rather than named. Filtering also keeps
    // it apart from the save-state status in the same view.
    const notice = page
      .getByRole('status')
      .filter({ hasText: /A language without a translated widget/i });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/not translated into Urdu/i);
  });
});

/**
 * What the picker actually PUTS in `supported_locales`.
 *
 * The field is a list of BCP-47 tags: the backend validates each entry against
 * its locale catalogue and refuses the whole save otherwise. The options were
 * built from `LocaleEntry.code`, which is the BASE language (`hi`), not
 * `LocaleEntry.locale`, which is the tag (`hi-IN`). So adding a language from
 * this control and pressing Save returned
 *
 *   Unsupported locale(s) in language_config.supported_locales: hi
 *
 * and nothing could be added at all. English hid it: `en-IN` was already on
 * the bot from creation, so the only rows anyone reached through the dropdown
 * were the broken ones.
 *
 * The same mistake made the three English rows indistinguishable, because
 * en-IN, en-US and en-GB all carry `code: 'en'` and so all carried the same
 * option value.
 */
test.describe('Language picker writes locale tags, not language codes', () => {
  test('adding a language sends a BCP-47 tag the backend accepts', async ({ page }) => {
    const saved: unknown[] = [];
    await mockBackend(page, {
      bot: {
        language_config: {
          enabled: true,
          default_locale: 'en-IN',
          supported_locales: ['en-IN'],
          operator_translation_enabled: false,
        },
      },
      onBotUpdate: (body) => {
        saved.push((body as { language_config?: { supported_locales?: unknown } })?.language_config
          ?.supported_locales);
      },
    });
    await openLanguageTab(page);

    await page.getByLabel('Add a language').click();
    await page.getByRole('option', { name: /Hindi/ }).click();

    // The chip names the LOCALE, not the bare language: "Hindi (India)".
    await expect(page.getByText('Hindi (India)')).toBeVisible();

    await page.getByRole('button', { name: /Save changes/i }).click();

    await expect
      .poll(() => saved.at(-1), { timeout: 10_000 })
      .toEqual(['en-IN', 'hi-IN']);
  });

  test('each English region is its own option', async ({ page }) => {
    await mockBackend(page, {
      bot: {
        language_config: {
          enabled: true,
          default_locale: 'en-IN',
          supported_locales: ['hi-IN'],
          operator_translation_enabled: false,
        },
      },
    });
    await openLanguageTab(page);
    await page.getByLabel('Add a language').click();

    // Three distinct rows, and picking one must not add the other two.
    await expect(page.getByRole('option', { name: 'English (India)' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'English (United States)' })).toBeVisible();
    await page.getByRole('option', { name: 'English (United States)' }).click();

    await expect(page.getByText('English (United States)')).toBeVisible();
    await expect(page.getByText('English (India)')).toHaveCount(0);
  });
});
