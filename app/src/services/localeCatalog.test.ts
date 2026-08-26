import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseLanguage,
  directionForLocale,
  getLocaleCatalog,
  isUiTranslated,
  labelForLanguage,
  nameForLocale,
  resetLocaleCatalog,
  setLocaleCatalog,
  subscribeLocaleCatalog,
} from './localeCatalog';

/** The shape `GET /locales` returns, trimmed to what these tests need. */
const PAYLOAD = {
  locales: [
    { code: 'en', locale: 'en-IN', name: 'English (India)', native_name: 'English (India)', direction: 'ltr' },
    { code: 'en', locale: 'en-US', name: 'English (United States)', native_name: 'English (US)', direction: 'ltr' },
    { code: 'hi', locale: 'hi-IN', name: 'Hindi (India)', native_name: 'हिन्दी', direction: 'ltr' },
    { code: 'ar', locale: 'ar-SA', name: 'Arabic (Saudi Arabia)', native_name: 'العربية', direction: 'rtl' },
  ],
  languages: { en: 'English', hi: 'Hindi', ar: 'Arabic' },
};

afterEach(() => resetLocaleCatalog());

describe('baseLanguage', () => {
  it('reduces a locale tag to its language', () => {
    expect(baseLanguage('hi-IN')).toBe('hi');
    expect(baseLanguage('zh_Hans_CN')).toBe('zh');
    expect(baseLanguage('AR')).toBe('ar');
  });

  it('returns null for anything that is not a tag', () => {
    expect(baseLanguage(null)).toBeNull();
    expect(baseLanguage('')).toBeNull();
    expect(baseLanguage('   ')).toBeNull();
  });
});

describe('labelForLanguage', () => {
  it('names a base language once the catalogue has loaded', () => {
    setLocaleCatalog(PAYLOAD);
    expect(labelForLanguage('hi')).toBe('Hindi');
    expect(labelForLanguage('hi-IN')).toBe('Hindi');
  });

  it('degrades to the uppercased tag rather than to raw text', () => {
    setLocaleCatalog(PAYLOAD);
    // `source_language` originates in a conversation. It must never reach the
    // DOM as free text, even when it names a language we do not know.
    expect(labelForLanguage('xx')).toBe('XX');
    expect(labelForLanguage('<script>')).toBe('<SCRIPT>');
  });
});

describe('nameForLocale', () => {
  it('keeps two locales of one language distinguishable', () => {
    setLocaleCatalog(PAYLOAD);
    // This is why an option is labelled by locale, not by language: rendering
    // both of these as "English" would make the picker unusable.
    expect(nameForLocale('en-IN')).toBe('English (India)');
    expect(nameForLocale('en-US')).toBe('English (United States)');
  });

  it('accepts the underscore and casing variants stored config can hold', () => {
    setLocaleCatalog(PAYLOAD);
    expect(nameForLocale('hi_in')).toBe('Hindi (India)');
    expect(nameForLocale('HI-IN')).toBe('Hindi (India)');
  });

  it('falls back to the base-language name for an uncatalogued region', () => {
    setLocaleCatalog(PAYLOAD);
    expect(nameForLocale('hi-XX')).toBe('Hindi');
  });
});

describe('directionForLocale', () => {
  it('reads direction from the catalogue', () => {
    setLocaleCatalog(PAYLOAD);
    expect(directionForLocale('ar-SA')).toBe('rtl');
    expect(directionForLocale('en-IN')).toBe('ltr');
  });

  it('still resolves RTL before the catalogue has loaded', () => {
    // Direction cannot wait for a request: getting it wrong mirrors an entire
    // thread on first paint.
    expect(getLocaleCatalog().ready).toBe(false);
    for (const rtl of ['ar', 'ar-SA', 'he-IL', 'fa', 'ur-PK']) {
      expect(directionForLocale(rtl)).toBe('rtl');
    }
    for (const ltr of ['en', 'hi-IN', 'zh-Hans-CN', null, '']) {
      expect(directionForLocale(ltr)).toBe('ltr');
    }
  });
});

describe('setLocaleCatalog', () => {
  it('notifies subscribers so a rendered name can resolve after first paint', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLocaleCatalog(listener);
    setLocaleCatalog(PAYLOAD);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setLocaleCatalog(PAYLOAD);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops malformed rows instead of throwing', () => {
    setLocaleCatalog({
      locales: [
        { code: 'hi', locale: 'hi-IN', name: 'Hindi (India)', native_name: 'हिन्दी', direction: 'ltr' },
        { code: 'zz' },
        null,
        'not an object',
      ],
      languages: { hi: 'Hindi' },
    });
    expect(getLocaleCatalog().locales).toHaveLength(1);
    expect(labelForLanguage('hi')).toBe('Hindi');
  });

  it('derives base names when the payload omits them', () => {
    setLocaleCatalog({ locales: PAYLOAD.locales });
    expect(labelForLanguage('hi')).toBe('Hindi');
    expect(labelForLanguage('ar')).toBe('Arabic');
  });

  it('leaves the catalogue unloaded when nothing usable arrives', () => {
    // Better to keep degrading to tags than to publish an empty catalogue as
    // if it were the truth.
    setLocaleCatalog({ locales: [] });
    expect(getLocaleCatalog().ready).toBe(false);
    setLocaleCatalog(null);
    expect(getLocaleCatalog().ready).toBe(false);
  });
});

describe('no locale registry survives in the dashboard source', () => {
  /**
   * Phase 5A deleted two hardcoded tables (`LOCALE_NAMES` in the inbox helpers
   * and `OPERATOR_LOCALES` in the translation picker). They existed because
   * there was nowhere central to put them; now there is. This asserts against
   * the source itself so neither can quietly come back, which a behavioural
   * test cannot catch.
   *
   * Read through Vite's raw glob rather than `node:fs`, so the assertion runs
   * under the app's own browser tsconfig with no Node types involved.
   */
  const SOURCES = import.meta.glob('/src/**/*.{ts,tsx,js,jsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  /**
   * Test files are exempt. The rule protects PRODUCTION source from growing a
   * second locale registry; a spec listing a few tags to build a scenario is
   * fixture data, not a registry. This file was already exempted for exactly
   * that reason, and the exemption is generalised rather than special-cased
   * once per new spec.
   */
  const isSpec = (path: string): boolean => /\.test\.tsx?$/.test(path);

  function offendersMatching(pattern: RegExp, allow: (path: string) => boolean = () => false): string[] {
    return Object.entries(SOURCES)
      .filter(([path]) => !isSpec(path) && !allow(path))
      .filter(([, source]) => pattern.test(source))
      .map(([path]) => path);
  }

  it('reads a non-trivial number of source files', () => {
    // Guards the assertions below: an empty glob would make them pass for the
    // wrong reason.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it('has no second copy of the locale list', () => {
    expect(offendersMatching(/\bLOCALE_NAMES\b|\bOPERATOR_LOCALES\b/)).toEqual([]);
  });

  it('has no hardcoded run of BCP-47 tags outside the catalogue module', () => {
    // Three or more quoted locale tags in a row is what a registry looks like.
    const registry = /(['"][a-z]{2}-[A-Z]{2}['"],\s*){2,}['"][a-z]{2}-[A-Z]{2}['"]/;
    expect(offendersMatching(registry, (path) => path.endsWith('/services/localeCatalog.ts'))).toEqual([]);
  });
});

describe('uiTranslated', () => {
  it('is read from the payload', () => {
    setLocaleCatalog({
      locales: [
        { code: 'hi', locale: 'hi-IN', name: 'Hindi (India)', native_name: 'हिन्दी', direction: 'ltr', ui_translated: true },
        { code: 'ur', locale: 'ur-PK', name: 'Urdu (Pakistan)', native_name: 'اردو', direction: 'rtl', ui_translated: false },
      ],
      languages: { hi: 'Hindi', ur: 'Urdu' },
    });
    expect(isUiTranslated('hi-IN')).toBe(true);
    expect(isUiTranslated('ur-PK')).toBe(false);
  });

  it('answers for a bare base code from any locale of that language', () => {
    setLocaleCatalog({
      locales: [
        { code: 'en', locale: 'en-GB', name: 'English (UK)', native_name: 'English (UK)', direction: 'ltr', ui_translated: true },
      ],
      languages: { en: 'English' },
    });
    expect(isUiTranslated('en')).toBe(true);
    expect(isUiTranslated('en-US')).toBe(true);
  });

  it('is false for anything the catalogue does not know', () => {
    // This gates a control that must never offer more than the widget renders,
    // so an unrecognised tag has to be treated as untranslated.
    setLocaleCatalog({ locales: [], languages: {} });
    for (const value of ['zz-ZZ', '', null, undefined, 'not a locale']) {
      expect(isUiTranslated(value as string)).toBe(false);
    }
  });

  it('defaults to true when the API predates the field', () => {
    // Only reachable while a deploy is in flight. Failing open shows the full
    // list for a few seconds; failing closed would empty the picker entirely
    // and read as a broken screen.
    setLocaleCatalog({
      locales: [{ code: 'fr', locale: 'fr-FR', name: 'French', native_name: 'Français', direction: 'ltr' }],
      languages: { fr: 'French' },
    });
    expect(isUiTranslated('fr-FR')).toBe(true);
  });
});
