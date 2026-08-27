/**
 * The dashboard's locale registry - one copy, filled from `GET /locales`.
 *
 * Phase 5A. Every language name and direction the admin renders resolves
 * through here, so the backend's `KNOWN_LOCALES` is the only place a locale is
 * ever defined. Before this existed the dashboard carried two hardcoded tables
 * that disagreed with the backend and with each other.
 *
 * Deliberately free of React AND of the API client:
 *
 * - No React, so `liveChatHelpers` (pure, importable anywhere) can read it.
 * - No `services/api`, so those helpers' unit tests don't drag axios and app
 *   bootstrap into a test of a string function.
 *
 * The fetch therefore lives in `hooks/useLocaleCatalog`, which pushes the
 * result in here via {@link setLocaleCatalog}. Reads are synchronous and never
 * throw: before the catalogue lands, a name degrades to its uppercased tag and
 * a direction falls back to the script table below.
 */

/** One locale, mirroring the backend's `LocaleInfo`. */
export interface LocaleEntry {
  /** Base language code: `en`, `hi`. */
  code: string;
  /** BCP-47 tag: `en-IN`, `hi-IN`. */
  locale: string;
  /** English display name including the region: "English (India)". */
  name: string;
  /** Endonym: "हिन्दी". */
  nativeName: string;
  direction: 'ltr' | 'rtl';
  /**
   * Whether the WIDGET's own buttons and labels are translated into this
   * language, as opposed to the AI merely being able to converse in it.
   *
   * False means a visitor who picks it reads the chatbot's answers in their
   * language and the widget's chrome in English. On an RTL language the layout
   * also mirrors, so the result is an English interface laid out backwards.
   * The language picker offers only the true ones.
   */
  uiTranslated: boolean;
  /**
   * Whether the ADMIN DASHBOARD's own interface is translated into this
   * language (Phase 7).
   *
   * Deliberately NOT `uiTranslated`, which describes the chat widget. The two
   * surfaces ship different dictionaries and can reach a language at different
   * times, so reusing one flag would offer a language the other renders in
   * English. `api/tests/test_admin_ui_languages_contract.py` holds the pair
   * apart on the backend side.
   */
  adminUiTranslated: boolean;
}

export interface LocaleCatalog {
  /** Every locale the platform supports, in catalogue order. */
  locales: LocaleEntry[];
  /** Base language code to English name: `hi` -> "Hindi". */
  languages: Readonly<Record<string, string>>;
  /** False until `GET /locales` has resolved at least once. */
  ready: boolean;
}

/**
 * Scripts that render right-to-left, used only until the catalogue arrives.
 *
 * Direction cannot wait for a network round trip: getting it wrong mirrors a
 * whole message thread for the first paint. Kept to the four RTL base codes
 * rather than a name table, so it is a fact about scripts and not a second
 * locale registry to drift.
 */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

const EMPTY: LocaleCatalog = { locales: [], languages: {}, ready: false };

let snapshot: LocaleCatalog = EMPTY;
const listeners = new Set<() => void>();

/** Base language code from a locale tag: `hi-IN` -> `hi`, `ar` -> `ar`. */
export function baseLanguage(locale: string | null | undefined): string | null {
  if (!locale || typeof locale !== 'string') return null;
  const trimmed = locale.trim();
  if (!trimmed) return null;
  return trimmed.split(/[-_]/)[0].toLowerCase() || null;
}

/**
 * English name for a language or locale, resolved from the catalogue.
 *
 * Takes the BASE language, because that is what a conversation carries:
 * `ChatSession.language_code` and `ChatMessage.source_language` are base
 * codes. An unrecognised code renders as its uppercased tag rather than as raw
 * conversation-derived text reaching the DOM.
 */
export function labelForLanguage(code: string | null | undefined): string | null {
  const base = baseLanguage(code);
  if (!base) return null;
  return snapshot.languages[base] ?? base.toUpperCase();
}

/**
 * Name for a specific locale, region and all: `en-IN` -> "English (India)".
 *
 * Use this to label a locale *option*. `en-IN` and `en-US` are different
 * choices, and {@link labelForLanguage} would render both as "English".
 * Unknown tags fall back to the base-language name.
 */
export function nameForLocale(locale: string | null | undefined): string | null {
  if (!locale || typeof locale !== 'string') return null;
  const trimmed = locale.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/_/g, '-').toLowerCase();
  const match = snapshot.locales.find((entry) => entry.locale.toLowerCase() === normalized);
  return match ? match.name : labelForLanguage(trimmed);
}

/**
 * Whether the widget's own UI is translated into this locale's language.
 *
 * Unknown tags return false: an unrecognised locale certainly has no
 * dictionary, and this gates a control that must not offer more than the
 * widget can actually render.
 */
export function isUiTranslated(locale: string | null | undefined): boolean {
  if (!locale || typeof locale !== 'string') return false;
  const normalized = locale.trim().replace(/_/g, '-').toLowerCase();
  const match = snapshot.locales.find((entry) => entry.locale.toLowerCase() === normalized);
  if (match) return match.uiTranslated;
  // A bare base code ('hi') is still answerable: any locale of that language
  // shares its dictionary.
  const base = baseLanguage(locale);
  return base ? snapshot.locales.some((e) => e.code === base && e.uiTranslated) : false;
}

/**
 * Whether the dashboard itself is translated into this locale.
 *
 * Gates the Settings language selector, exactly as {@link isUiTranslated}
 * gates the widget's. Unknown tags return false: an unrecognised locale
 * certainly has no dictionary.
 */
export function isAdminUiTranslated(locale: string | null | undefined): boolean {
  if (!locale || typeof locale !== 'string') return false;
  const normalized = locale.trim().replace(/_/g, '-').toLowerCase();
  const match = snapshot.locales.find((entry) => entry.locale.toLowerCase() === normalized);
  if (match) return match.adminUiTranslated;
  const base = baseLanguage(locale);
  return base ? snapshot.locales.some((e) => e.code === base && e.adminUiTranslated) : false;
}

/** Text direction for a locale or bare language code. */
export function directionForLocale(locale: string | null | undefined): 'ltr' | 'rtl' {
  if (!locale || typeof locale !== 'string') return 'ltr';
  const normalized = locale.trim().replace(/_/g, '-').toLowerCase();
  const match = snapshot.locales.find((entry) => entry.locale.toLowerCase() === normalized);
  if (match) return match.direction;
  const base = baseLanguage(locale);
  return base && RTL_LANGUAGES.has(base) ? 'rtl' : 'ltr';
}

/** The current catalogue. Stable by reference until it actually changes. */
export function getLocaleCatalog(): LocaleCatalog {
  return snapshot;
}

/** Subscribe to catalogue changes. Returns the unsubscribe function. */
export function subscribeLocaleCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseLocale(value: unknown): LocaleEntry | null {
  const row = asRecord(value);
  const code = typeof row.code === 'string' ? row.code : '';
  const locale = typeof row.locale === 'string' ? row.locale : '';
  const name = typeof row.name === 'string' ? row.name : '';
  if (!code || !locale || !name) return null;
  return {
    code,
    locale,
    name,
    nativeName: typeof row.native_name === 'string' && row.native_name ? row.native_name : name,
    direction: row.direction === 'rtl' ? 'rtl' : 'ltr',
    // Absent means an API older than the field, which can only happen for the
    // seconds a deploy is in flight. Failing OPEN there shows the full list
    // briefly; failing closed would empty the picker and read as broken.
    uiTranslated: typeof row.ui_translated === 'boolean' ? row.ui_translated : true,
    // Absent means an API older than the field. Fails CLOSED, unlike
    // `uiTranslated` above: offering a dashboard language that turns out to
    // have no dictionary produces a half-translated console, whereas briefly
    // offering one language too few is invisible.
    adminUiTranslated: typeof row.admin_ui_translated === 'boolean' ? row.admin_ui_translated : false,
  };
}

/**
 * Install a fetched catalogue and notify subscribers.
 *
 * Loss-tolerant on purpose: a malformed row is dropped rather than throwing,
 * because a bad locale row must never take down the console. A payload with no
 * usable locales at all leaves the catalogue unset, so reads keep degrading to
 * uppercased tags instead of rendering an empty language list as truth.
 */
export function setLocaleCatalog(payload: unknown): void {
  const raw = asRecord(payload);
  const locales = Array.isArray(raw.locales)
    ? raw.locales.map(parseLocale).filter((entry): entry is LocaleEntry => entry !== null)
    : [];
  if (locales.length === 0) return;

  const languages: Record<string, string> = {};
  for (const [code, name] of Object.entries(asRecord(raw.languages))) {
    if (typeof name === 'string' && name) languages[code.toLowerCase()] = name;
  }
  // A backend that ever stops sending `languages` still yields usable base
  // names rather than a console full of "HI".
  for (const entry of locales) {
    if (!languages[entry.code]) languages[entry.code] = entry.name.split(' (')[0];
  }

  snapshot = { locales, languages, ready: true };
  for (const listener of listeners) listener();
}

/** Reset to the unloaded state. Test-only; no production caller. */
export function resetLocaleCatalog(): void {
  snapshot = EMPTY;
  for (const listener of listeners) listener();
}
