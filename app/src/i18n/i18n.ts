/**
 * Dashboard UI-language runtime.
 *
 * This is the admin application's own interface language. It is NOT any of the
 * three language slices that already shipped, and must never be derived from
 * or written into any of them:
 *
 *   - `Operator.preferred_locale` is the language an operator READS LIVE CHAT
 *     in. It spends credits (translation is metered) and is resolved per
 *     message against the database. Changing a menu language must never start
 *     translating conversations.
 *   - `ChatSession.language_code` is the conversation's own language.
 *   - The widget's locale is the visitor's, on the customer's site.
 *
 * A Gujarati-speaking operator may legitimately want this dashboard in English
 * while reading chats translated into Gujarati. Conflating them removes a
 * choice people actually want, and would bill them for the privilege.
 *
 * BUNDLING CONTRACT
 * -----------------
 * No dictionary is imported statically, and English is never loaded at
 * runtime. Every call site carries its own inline English default
 * (`t('app.crumb.home') || 'Home'`), so English already exists in the component
 * renders it. Loading `locales/en.ts` on top of that would ship every string
 * twice to every user, and would make "English output is unchanged" an
 * assertion rather than something structurally true.
 *
 * `locales/en.ts` stays in the tree as the canonical source translators work
 * from and the file the parity tests assert against. It is simply not part of
 * the runtime fallback chain. Do NOT add a static dictionary import here.
 */

import { baseLanguage } from '../services/localeCatalog';

/** Per-device persistence, matching the ThemeProvider precedent (`oc_theme`). */
const STORAGE_KEY = 'oc_ui_locale';

/** The locale used when nothing is stored. English, in the platform's region. */
export const DEFAULT_UI_LOCALE = 'en-IN';

/**
 * Dictionaries this build actually ships, keyed by base language.
 *
 * English deliberately has no entry: it is the inline fallback, not a
 * dictionary. This map is the client half of a contract with the backend's
 * `ADMIN_UI_LANGUAGES`; `api/tests/test_admin_ui_languages_contract.py` fails
 * if the two drift, which is what stops the dashboard offering a language it
 * cannot actually render.
 */
const DICTIONARY_LOADERS: Record<string, () => Promise<unknown>> = {
  hi: () => import('./locales/hi'),
  ar: () => import('./locales/ar'),
};

/** Base language codes this build can present, English included. */
export const ADMIN_UI_LANGUAGES: readonly string[] = Object.freeze([
  'en',
  ...Object.keys(DICTIONARY_LOADERS),
]);

type Dictionary = Record<string, unknown>;

const dictionaries: Record<string, Dictionary> = {};
const listeners = new Set<() => void>();

let currentLocale: string = readStoredLocale();

/**
 * Snapshot token for `useSyncExternalStore`, changed on EVERY notification.
 *
 * It cannot just be the locale. A dictionary arrives asynchronously after the
 * switch, and at that moment the locale is already what it will be, so a
 * locale-valued snapshot is identical before and after the load and React
 * correctly bails out of re-rendering. The result was a language switch that
 * updated `document.lang` and localStorage while every translated string on
 * screen stayed English until an unrelated render happened to flush it.
 */
let version = 0;
let snapshotToken = `${currentLocale}#0`;

function readStoredLocale(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_UI_LOCALE;
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && isSupportedUiLocale(stored) ? stored : DEFAULT_UI_LOCALE;
}

function persist(locale: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Private mode / quota. The locale still applies for this page life.
  }
}

/** True when this build ships an interface for `locale`'s base language. */
export function isSupportedUiLocale(locale: string | null | undefined): boolean {
  const base = baseLanguage(locale);
  return !!base && ADMIN_UI_LANGUAGES.includes(base);
}

export function getLocale(): string {
  return currentLocale;
}

/**
 * Opaque token that changes on every locale change AND every dictionary
 * arrival. React binding only; render from {@link getLocale} and {@link t}.
 */
export function getSnapshotToken(): string {
  return snapshotToken;
}

/** Base language of the active locale: `hi-IN` -> `hi`. */
export function getLanguage(): string {
  return baseLanguage(currentLocale) ?? 'en';
}

function notify(): void {
  version += 1;
  snapshotToken = `${currentLocale}#${version}`;
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[OyeChats] i18n listener error:', err);
    }
  }
}

/**
 * Load a dictionary if it is not already resident.
 *
 * Resolves true only when a dictionary arrived that was not there before, so
 * the caller knows whether a re-render is actually warranted.
 */
async function ensureDictionary(locale: string): Promise<boolean> {
  const lang = baseLanguage(locale);
  if (!lang || lang === 'en' || dictionaries[lang]) return false;

  const loader = DICTIONARY_LOADERS[lang];
  if (!loader) return false;

  try {
    const mod = (await loader()) as { default?: Dictionary } & Dictionary;
    dictionaries[lang] = (mod.default ?? mod) as Dictionary;
    return true;
  } catch (err) {
    // A failed chunk fetch must not break the dashboard: every call site still
    // has its inline English, so the UI degrades to English rather than blank.
    console.warn('[OyeChats] Failed to load UI dictionary for', lang, err);
    return false;
  }
}

/**
 * Switch the dashboard's interface language.
 *
 * Applies synchronously so persistence and `document.lang` update at once,
 * then notifies a second time when a lazily-fetched dictionary lands, so
 * subscribed components re-render with real strings instead of English.
 */
export function setLocale(next: string | null | undefined): void {
  if (!next || !isSupportedUiLocale(next) || next === currentLocale) return;

  currentLocale = next;
  persist(next);
  notify();

  void ensureDictionary(next).then((didLoad) => {
    // Guard a stale load resolving after the user switched again.
    if (didLoad && currentLocale === next) notify();
  });
}

/**
 * Fetch a dictionary without switching to it, to avoid a flash of English.
 *
 * MUST notify when the fetch lands. `I18nProvider` calls this on mount for a
 * RESTORED preference, at which point the tree has already painted English
 * because the dictionary was not in memory yet. Without the notify the flash
 * never ends: the chunk arrives, `t()` would resolve, and nothing re-renders,
 * so a reader who picked Hindi and reloaded sat looking at an English
 * dashboard until some unrelated state change happened to flush the tree.
 *
 * `setLocale` already does this for an in-session switch, which is why the
 * language picker appeared to work and a reload appeared not to.
 */
export async function preloadDictionary(locale: string): Promise<boolean> {
  const loaded = await ensureDictionary(locale);
  if (loaded && baseLanguage(currentLocale) === baseLanguage(locale)) notify();
  return loaded;
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dictionaryFor(locale: string): Dictionary | null {
  const lang = baseLanguage(locale);
  return (lang && dictionaries[lang]) || null;
}

function resolveKey(dict: Dictionary, keyPath: string): string | null {
  let curr: unknown = dict;
  for (const part of keyPath.split('.')) {
    if (!curr || typeof curr !== 'object') return null;
    curr = (curr as Record<string, unknown>)[part];
  }
  return typeof curr === 'string' ? curr : null;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The dictionary entry for `key`, placeholders left intact, or null on a miss.
 *
 * `t()` is the right call for everything that renders as a plain string. This
 * exists for the one case it cannot serve: a sentence with a React element
 * interpolated into it, where the caller has to split the template itself. It
 * deliberately does NOT warn about unsubstituted placeholders, because leaving
 * them in is the entire point here.
 */
export function template(key: string): string | null {
  if (!key || typeof key !== 'string') return null;
  const dict = dictionaryFor(currentLocale);
  return dict ? resolveKey(dict, key) : null;
}

/**
 * Translate a dotted key, with `{name}` interpolation.
 *
 * Returns **null** on a miss, never the key path. That is what makes the
 * `t('a.b') || 'English'` idiom work: a missing key falls through to the
 * caller's inline English. Returning the key instead would put raw strings
 * like "app.crumb.home" in front of users AND make every `|| 'English'` in the
 * codebase unreachable dead code. The widget shipped the key-returning
 * variant first and had exactly that bug.
 */
export function t(key: string, params?: Record<string, unknown>): string | null {
  if (!key || typeof key !== 'string') return null;

  const dict = dictionaryFor(currentLocale);
  const raw = dict ? resolveKey(dict, key) : null;
  if (raw === null) return null;

  if (!params) {
    // An un-parameterised call against a parameterised string would render
    // "{count}" to the user. Surface it in development instead of shipping it.
    if (import.meta.env?.DEV && PLACEHOLDER.test(raw)) {
      PLACEHOLDER.lastIndex = 0;
      console.warn(`[OyeChats] i18n: "${key}" expects parameters but received none`);
    }
    PLACEHOLDER.lastIndex = 0;
    return raw;
  }

  return raw.replace(PLACEHOLDER, (match, name: string) => {
    if (!(name in params)) {
      // Never silently swallow: an unresolved placeholder is a dictionary bug,
      // and the parity guard exists to catch it before it ships.
      if (import.meta.env?.DEV) {
        console.warn(`[OyeChats] i18n: "${key}" has no value for placeholder "{${name}}"`);
      }
      return match;
    }
    const value = params[name];
    return String(value ?? '');
  });
}

/** Test-only reset. Not referenced by application code. */
/**
 * Drop loaded dictionaries but keep the active locale.
 *
 * Reproduces the cold-load state a full reset cannot: the reader's language is
 * known from storage, and its dictionary has not arrived yet.
 */
export function __clearDictionariesForTests(): void {
  for (const lang of Object.keys(dictionaries)) delete dictionaries[lang];
}

export function __resetI18nForTests(): void {
  currentLocale = DEFAULT_UI_LOCALE;
  version = 0;
  snapshotToken = `${DEFAULT_UI_LOCALE}#0`;
  listeners.clear();
  for (const lang of Object.keys(dictionaries)) delete dictionaries[lang];
}
