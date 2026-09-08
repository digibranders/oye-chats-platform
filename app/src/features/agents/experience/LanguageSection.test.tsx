import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const catalogue = vi.hoisted(() => ({
  locales: [
    { locale: 'en-IN', code: 'en', name: 'English (India)', nativeName: 'English', direction: 'ltr' as const },
    { locale: 'hi-IN', code: 'hi', name: 'Hindi (India)', nativeName: 'हिन्दी', direction: 'ltr' as const },
    { locale: 'ar-AE', code: 'ar', name: 'Arabic (UAE)', nativeName: 'العربية', direction: 'rtl' as const },
    // In the catalogue, but the WIDGET has no dictionary for it. Never
    // preselected: answers in Japanese inside an English interface is the
    // experience the addable filter exists to prevent.
    { locale: 'ja-JP', code: 'ja', name: 'Japanese (Japan)', nativeName: '日本語', direction: 'ltr' as const },
  ],
}));

vi.mock('../../../hooks/useLocaleCatalog', () => ({
  useLocaleCatalog: () => ({
    locales: catalogue.locales,
    ready: true,
    labelFor: (code: string) => code,
    localeNameFor: (locale: string) =>
      catalogue.locales.find((entry) => entry.locale === locale)?.name ?? null,
    directionFor: () => 'ltr' as const,
    uiTranslatedFor: (code: string | null | undefined) => code !== 'ja',
    adminUiTranslatedFor: () => true,
  }),
  default: () => ({}),
}));

vi.mock('../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ hasFeature: () => true, entitlements: null, loading: false }),
}));

import { LanguageSection } from './LanguageSection';
import type { ExperienceDraft } from './experience-model';

/**
 * Turning "answer visitors in more than one language" on.
 *
 * A customer who has just said "more than one" has answered the question.
 * Making them then add languages one at a time from a twenty-entry combobox
 * asks it again in a slower form, so switching on selects everything the widget
 * can actually render and leaves them to remove the few they do not want.
 */

function draftWith(over: Partial<ExperienceDraft>): ExperienceDraft {
  return {
    multilingualEnabled: false,
    supportedLocales: ['en-IN'],
    defaultLocale: 'en-IN',
    autoDetectLanguage: true,
    allowVisitorLanguageSwitch: false,
    operatorTranslation: false,
    ...over,
  } as ExperienceDraft;
}

function renderSection(draft: ExperienceDraft) {
  const onChange = vi.fn();
  render(
    <LanguageSection draft={draft} baseline={draft} readOnly={false} onChange={onChange} />,
  );
  return onChange;
}

const master = () => screen.getByRole('switch', { name: /answer visitors in more than one language/i });

describe('LanguageSection — switching multilingual on', () => {
  it('selects every language the widget can render', async () => {
    const user = userEvent.setup();
    const onChange = renderSection(draftWith({ multilingualEnabled: false }));

    await user.click(master());

    const patch = onChange.mock.calls.at(-1)?.[0];
    expect(patch.multilingualEnabled).toBe(true);
    expect(patch.supportedLocales).toEqual(['en-IN', 'hi-IN', 'ar-AE']);
  });

  it('leaves out a language the widget has no dictionary for', async () => {
    // Answers in Japanese inside an English interface is nobody's choice.
    const user = userEvent.setup();
    const onChange = renderSection(draftWith({ multilingualEnabled: false }));

    await user.click(master());

    expect(onChange.mock.calls.at(-1)?.[0].supportedLocales).not.toContain('ja-JP');
  });

  it('keeps the current language first, so the default still resolves', async () => {
    // The default-language picker is built from this list. A default that is
    // not in it renders as an empty control.
    const user = userEvent.setup();
    const onChange = renderSection(
      draftWith({ multilingualEnabled: false, supportedLocales: ['hi-IN'], defaultLocale: 'hi-IN' }),
    );

    await user.click(master());

    const patch = onChange.mock.calls.at(-1)?.[0];
    expect(patch.supportedLocales[0]).toBe('hi-IN');
    expect(patch.supportedLocales).toContain(patch.supportedLocales.find((l: string) => l === 'hi-IN'));
  });

  it('does not overwrite a choice the customer has already made', async () => {
    // Somebody who narrowed to three, switched off and switched on again gets
    // their three back. A silent reset to everything would be the console
    // undoing their work.
    const user = userEvent.setup();
    const chosen = ['en-IN', 'hi-IN', 'ar-AE'];
    const onChange = renderSection(
      draftWith({ multilingualEnabled: false, supportedLocales: chosen }),
    );

    await user.click(master());

    expect(onChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('supportedLocales');
  });

  it('touches the language list not at all when switching OFF', async () => {
    const user = userEvent.setup();
    const onChange = renderSection(draftWith({ multilingualEnabled: true }));

    await user.click(master());

    const patch = onChange.mock.calls.at(-1)?.[0];
    expect(patch.multilingualEnabled).toBe(false);
    expect(patch).not.toHaveProperty('supportedLocales');
  });
});
