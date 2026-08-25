import { describe, expect, it } from 'vitest';
import {
  type LanguageConfig,
  DEFAULT_LOCALE,
  LANGUAGE_DEFAULTS,
  draftFromBot,
  languageFromBot,
  languagePatch,
  normalizeLanguageConfig,
} from './botConfig';

/**
 * Phase 5B - the bot's visitor-facing language configuration.
 *
 * The rules under test are the same four the server enforces. They are checked
 * here because a customer meeting a 422 after pressing save is a UI failure:
 * the invalid combination should never have been reachable.
 */

const config = (over: Partial<LanguageConfig> = {}): LanguageConfig => ({
  enabled: true,
  supportedLocales: ['en-IN', 'hi-IN'],
  defaultLocale: 'en-IN',
  autoDetect: true,
  allowVisitorSwitch: true,
  operatorTranslation: true,
  ...over,
});

describe('languageFromBot', () => {
  it('gives an unconfigured bot the documented server-side defaults', () => {
    expect(languageFromBot(undefined)).toEqual(LANGUAGE_DEFAULTS);
    expect(languageFromBot({})).toEqual(LANGUAGE_DEFAULTS);
    expect(LANGUAGE_DEFAULTS.defaultLocale).toBe(DEFAULT_LOCALE);
  });

  it('reads every stored key', () => {
    expect(
      languageFromBot({
        enabled: true,
        supported_locales: ['hi-IN', 'en-IN'],
        default_locale: 'hi-IN',
        auto_detect: false,
        allow_visitor_language_switch: true,
        operator_translation_enabled: true,
      }),
    ).toEqual({
      enabled: true,
      supportedLocales: ['hi-IN', 'en-IN'],
      defaultLocale: 'hi-IN',
      autoDetect: false,
      allowVisitorSwitch: true,
      operatorTranslation: true,
    });
  });

  it('loads a legacy bot exactly as stored, inconsistencies and all', () => {
    // A bot configured before this UI existed can hold a default that is not
    // in its supported list. Silently repairing it on LOAD would make the card
    // show something the server does not have; the repair belongs to the save.
    const loaded = languageFromBot({
      enabled: true,
      supported_locales: ['hi-IN'],
      default_locale: 'fr-FR',
    });
    expect(loaded.defaultLocale).toBe('fr-FR');
    expect(loaded.supportedLocales).toEqual(['hi-IN']);
  });

  it('drops blanks and repeats out of a stored list', () => {
    const loaded = languageFromBot({ supported_locales: ['en-IN', '', '  ', 'en-IN', 'hi-IN', 7, null] });
    expect(loaded.supportedLocales).toEqual(['en-IN', 'hi-IN']);
  });

  it('is reachable from the full bot draft', () => {
    const draft = draftFromBot({ language_config: { enabled: true, supported_locales: ['hi-IN'] } });
    expect(draft.language.enabled).toBe(true);
    expect(draft.language.supportedLocales).toEqual(['hi-IN']);
  });
});

describe('normalizeLanguageConfig', () => {
  it('promotes a new default when the current one is no longer supported', () => {
    const result = normalizeLanguageConfig(config({ supportedLocales: ['hi-IN', 'fr-FR'] }));
    expect(result.defaultLocale).toBe('hi-IN');
  });

  it('never produces an empty supported list', () => {
    const result = normalizeLanguageConfig(config({ supportedLocales: [], defaultLocale: 'hi-IN' }));
    expect(result.supportedLocales).toEqual(['hi-IN']);
    expect(result.defaultLocale).toBe('hi-IN');
  });

  it('falls back to the platform default when there is nothing at all', () => {
    const result = normalizeLanguageConfig(config({ supportedLocales: [], defaultLocale: '   ' }));
    expect(result.supportedLocales).toEqual([DEFAULT_LOCALE]);
  });

  it('clears the visitor switcher below two languages', () => {
    // A selector with one option is not a choice.
    expect(normalizeLanguageConfig(config({ supportedLocales: ['en-IN'] })).allowVisitorSwitch).toBe(false);
    expect(normalizeLanguageConfig(config()).allowVisitorSwitch).toBe(true);
  });

  it('clears operator translation when multilingual is off', () => {
    // This is the exact pair `bot_routes.py` rejects with a 422.
    const result = normalizeLanguageConfig(config({ enabled: false }));
    expect(result.operatorTranslation).toBe(false);
  });

  it('leaves a valid configuration untouched', () => {
    const valid = config();
    expect(normalizeLanguageConfig(valid)).toEqual(valid);
  });
});

describe('languagePatch', () => {
  it('emits only the language slice', () => {
    // Every other card saves independently; a language save must not carry
    // their fields along and overwrite an edit in progress elsewhere.
    expect(Object.keys(languagePatch(config()))).toEqual(['language_config']);
  });

  it('sends the backend key names, not the draft ones', () => {
    expect(languagePatch(config()).language_config).toEqual({
      enabled: true,
      supported_locales: ['en-IN', 'hi-IN'],
      default_locale: 'en-IN',
      auto_detect: true,
      allow_visitor_language_switch: true,
      operator_translation_enabled: true,
    });
  });

  it('round-trips through the wire shape unchanged', () => {
    const saved = config({ autoDetect: false });
    const wire = languagePatch(saved).language_config;
    expect(languageFromBot(wire)).toEqual(normalizeLanguageConfig(saved));
  });

  it('cannot send the combination the server rejects', () => {
    const wire = languagePatch(config({ enabled: false })).language_config as Record<string, unknown>;
    expect(wire.operator_translation_enabled).toBe(false);
  });

  it('cannot send a default outside the supported list', () => {
    const wire = languagePatch(config({ supportedLocales: ['fr-FR'], defaultLocale: 'en-IN' }))
      .language_config as Record<string, string[] | string>;
    expect(wire.supported_locales).toContain(wire.default_locale as string);
  });

  it('repairs a legacy bot on its first save', () => {
    const legacy = languageFromBot({ enabled: true, supported_locales: ['hi-IN'], default_locale: 'fr-FR' });
    const wire = languagePatch(legacy).language_config as Record<string, unknown>;
    expect(wire.default_locale).toBe('hi-IN');
  });
});
