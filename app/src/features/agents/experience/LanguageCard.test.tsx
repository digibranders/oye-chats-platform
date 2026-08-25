import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LanguageCard } from './LanguageCard';
import { type LanguageConfig, IDLE } from './botConfig';
import { resetLocaleCatalog, setLocaleCatalog } from '../../../services/localeCatalog';

/**
 * The rules in this card exist so a customer never meets the server's 422.
 * That guarantee only holds if the CONTROLS enforce it, which is what these
 * tests exercise - the pure normaliser is covered in `languageConfig.test.ts`.
 */

vi.mock('../../../services/api', () => ({
  getLocales: () => Promise.resolve(CATALOG),
}));

const CATALOG = {
  locales: [
    { code: 'en', locale: 'en-IN', name: 'English (India)', native_name: 'English (India)', direction: 'ltr' },
    { code: 'hi', locale: 'hi-IN', name: 'Hindi (India)', native_name: 'हिन्दी', direction: 'ltr' },
    { code: 'fr', locale: 'fr-FR', name: 'French (France)', native_name: 'Français (France)', direction: 'ltr' },
  ],
  languages: { en: 'English', hi: 'Hindi', fr: 'French' },
};

const config = (over: Partial<LanguageConfig> = {}): LanguageConfig => ({
  enabled: true,
  supportedLocales: ['en-IN', 'hi-IN'],
  defaultLocale: 'en-IN',
  autoDetect: true,
  allowVisitorSwitch: false,
  operatorTranslation: false,
  ...over,
});

/** Render the card and return the latest config its `onChange` produced. */
function renderCard(value: LanguageConfig, baseline: LanguageConfig = value) {
  let current = value;
  const onSave = vi.fn();
  const rerender = render(
    <LanguageCard
      value={current}
      baseline={baseline}
      onChange={(updater) => {
        current = updater(current);
      }}
      dirty
      status={IDLE}
      onSave={onSave}
    />,
  );
  return { onSave, latest: () => current, ...rerender };
}

beforeEach(() => setLocaleCatalog(CATALOG));
afterEach(() => {
  cleanup();
  resetLocaleCatalog();
});

describe('supported languages', () => {
  it('lists each supported language and marks the default', () => {
    renderCard(config());
    // Scoped to the chip list: "English (India)" is also the Default language
    // select's trigger text, and a bare getByText would match both.
    const chips = within(screen.getByRole('list'));
    expect(chips.getByText('English (India)')).toBeTruthy();
    expect(chips.getByText('Hindi (India)')).toBeTruthy();
    expect(chips.getByText('default')).toBeTruthy();
  });

  it('promotes a new default when the current default is removed', () => {
    const { latest } = renderCard(config({ defaultLocale: 'en-IN' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove English (India)' }));
    expect(latest().supportedLocales).toEqual(['hi-IN']);
    expect(latest().defaultLocale).toBe('hi-IN');
  });

  it('will not let the last language be removed', () => {
    const { latest } = renderCard(config({ supportedLocales: ['en-IN'] }));
    const remove = screen.getByRole('button', { name: 'Remove English (India)' });
    expect(remove.hasAttribute('disabled')).toBe(true);
    fireEvent.click(remove);
    expect(latest().supportedLocales).toEqual(['en-IN']);
    expect(screen.getByText(/at least one language/i)).toBeTruthy();
  });
});

describe('dependent controls', () => {
  it('disables the visitor switcher below two languages, with the reason', () => {
    renderCard(config({ supportedLocales: ['en-IN'] }));
    const toggle = screen.getByRole('switch', { name: /switch language in the widget/i });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/add a second language/i)).toBeTruthy();
  });

  it('enables the visitor switcher once there are two languages', () => {
    renderCard(config());
    const toggle = screen.getByRole('switch', { name: /switch language in the widget/i });
    expect(toggle.hasAttribute('disabled')).toBe(false);
  });

  it('disables operator translation while multilingual is off, with the reason', () => {
    renderCard(config({ enabled: false }));
    const toggle = screen.getByRole('switch', { name: /translate live chat/i });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/turn multilingual on first/i)).toBeTruthy();
  });

  it('clears operator translation when multilingual is turned off', () => {
    const { latest } = renderCard(config({ operatorTranslation: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Multilingual' }));
    expect(latest().enabled).toBe(false);
    // The server rejects `operator_translation_enabled` without `enabled`, so
    // the pair can never leave this card.
    expect(latest().operatorTranslation).toBe(false);
  });
});

describe('the disabled state', () => {
  it('renders every control read-only rather than hiding it', () => {
    // A customer has to be able to see what turning multilingual on gives them.
    renderCard(config({ enabled: false }));
    expect(screen.getByText('Supported languages')).toBeTruthy();
    expect(screen.getByLabelText('Default language')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /detect the visitor/i })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /switch language in the widget/i })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /translate live chat/i })).toBeTruthy();
  });
});

describe('turning multilingual off', () => {
  it('says what will stop, and labels the save accordingly', () => {
    renderCard(config({ enabled: false }), config({ enabled: true }));
    expect(screen.getByText(/will turn multilingual off/i)).toBeTruthy();
    expect(screen.getByText(/past conversations keep the language/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off multilingual' })).toBeTruthy();
  });

  it('shows no warning when multilingual was already off', () => {
    renderCard(config({ enabled: false }), config({ enabled: false }));
    expect(screen.queryByText(/will turn multilingual off/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save language' })).toBeTruthy();
  });
});
