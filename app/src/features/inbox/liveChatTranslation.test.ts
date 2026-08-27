import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  directionFor,
  languageLabel,
  parseHistoryMessage,
  resolveDisplay,
  translationMissing,
} from './liveChatHelpers';
import type { OperatorMessage } from './liveChatProtocol';
import { resetLocaleCatalog, setLocaleCatalog } from '../../services/localeCatalog';

/**
 * A slice of what `GET /locales` returns. Names and directions now come from
 * the backend catalogue rather than a table in the frontend, so these tests
 * seed it explicitly instead of relying on a hardcoded list.
 */
const CATALOG = {
  locales: [
    { code: 'en', locale: 'en-IN', name: 'English (India)', native_name: 'English (India)', direction: 'ltr' },
    { code: 'hi', locale: 'hi-IN', name: 'Hindi (India)', native_name: 'हिन्दी', direction: 'ltr' },
    { code: 'ar', locale: 'ar-SA', name: 'Arabic (Saudi Arabia)', native_name: 'العربية', direction: 'rtl' },
  ],
  languages: { en: 'English', hi: 'Hindi', ar: 'Arabic', he: 'Hebrew', fa: 'Persian', ur: 'Urdu' },
};

beforeEach(() => setLocaleCatalog(CATALOG));
afterEach(() => resetLocaleCatalog());

const visitorMessage = (over: Partial<OperatorMessage> = {}): OperatorMessage => ({
  key: 'srv-1',
  dbId: 1,
  role: 'user',
  content: 'मुझे pricing चाहिए',
  timestamp: '2026-08-24T10:00:00Z',
  sourceLanguage: 'hi',
  translations: { en: { content: 'I need pricing information.', status: 'ok' } },
  ...over,
});

describe('resolveDisplay', () => {
  it('shows the translation to an operator reading in another language', () => {
    const d = resolveDisplay(visitorMessage(), 'en-IN', false);
    expect(d.text).toBe('I need pricing information.');
    expect(d.isTranslated).toBe(true);
    expect(d.language).toBe('en');
  });

  it('shows the original when the operator toggles to it', () => {
    const d = resolveDisplay(visitorMessage(), 'en-IN', true);
    expect(d.text).toBe('मुझे pricing चाहिए');
    expect(d.isTranslated).toBe(false);
  });

  it('shows the original when operator and message share a language', () => {
    // No translation should ever have been made, and none is shown.
    const d = resolveDisplay(visitorMessage({ sourceLanguage: 'en', content: 'Hi' }), 'en-IN', false);
    expect(d.text).toBe('Hi');
    expect(d.isTranslated).toBe(false);
  });

  it('shows the original when the operator has no language set', () => {
    const d = resolveDisplay(visitorMessage(), null, false);
    expect(d.text).toBe('मुझे pricing चाहिए');
    expect(d.isTranslated).toBe(false);
  });

  it('falls back to the original when the translation failed', () => {
    const d = resolveDisplay(visitorMessage({ translations: { en: { status: 'failed' } } }), 'en-IN', false);
    expect(d.text).toBe('मुझे pricing चाहिए');
    expect(d.isTranslated).toBe(false);
  });

  it('falls back to the original when the translation has not arrived yet', () => {
    // The out-of-band window: original delivered, translation still in flight.
    const d = resolveDisplay(visitorMessage({ translations: undefined }), 'en-IN', false);
    expect(d.text).toBe('मुझे pricing चाहिए');
    expect(d.isTranslated).toBe(false);
  });

  it('never renders an empty translated bubble over a non-empty original', () => {
    const d = resolveDisplay(visitorMessage({ translations: { en: { content: '', status: 'ok' } } }), 'en', false);
    expect(d.text).toBe('मुझे pricing चाहिए');
  });

  it('reports the direction of the text actually rendered', () => {
    // An Arabic translation inside an English conversation still needs rtl.
    const arabic = visitorMessage({
      sourceLanguage: 'en',
      content: 'Hello',
      translations: { ar: { content: 'مرحبا', status: 'ok' } },
    });
    expect(resolveDisplay(arabic, 'ar-SA', false).direction).toBe('rtl');
    expect(resolveDisplay(arabic, 'ar-SA', true).direction).toBe('ltr'); // original is English
  });
});

describe('translationMissing', () => {
  it('is true when a translation was expected but is unusable', () => {
    expect(translationMissing(visitorMessage({ translations: undefined }), 'en')).toBe(true);
    expect(translationMissing(visitorMessage({ translations: { en: { status: 'failed' } } }), 'en')).toBe(true);
  });

  it('is false when the translation is present', () => {
    expect(translationMissing(visitorMessage(), 'en')).toBe(false);
  });

  it('is false when no translation was ever expected', () => {
    // Same language, or no operator preference: there is nothing to retry, so
    // the bubble must not offer one.
    expect(translationMissing(visitorMessage({ sourceLanguage: 'en' }), 'en')).toBe(false);
    expect(translationMissing(visitorMessage(), null)).toBe(false);
    expect(translationMissing(visitorMessage({ sourceLanguage: null }), 'en')).toBe(false);
  });
});

describe('parseHistoryMessage', () => {
  it('carries translations through a reload', () => {
    // Regression for the audit's C2: without these fields a refresh dropped
    // every translation and the thread reverted to the original language.
    const parsed = parseHistoryMessage({
      id: 7,
      role: 'user',
      content: 'नमस्ते',
      created_at: '2026-08-24T10:00:00Z',
      source_language: 'hi',
      translations: { en: { content: 'Hello', status: 'ok' } },
    });
    expect(parsed.sourceLanguage).toBe('hi');
    expect(parsed.translations?.en.content).toBe('Hello');
    expect(parsed.content).toBe('नमस्ते'); // original untouched
  });

  it('tolerates rows without translation fields', () => {
    const parsed = parseHistoryMessage({ id: 8, role: 'bot', content: 'Answer' });
    expect(parsed.sourceLanguage).toBeNull();
    expect(parsed.translations).toBeUndefined();
    expect(parsed.content).toBe('Answer');
  });
});

describe('directionFor', () => {
  it('matches the server RTL set', () => {
    for (const rtl of ['ar', 'ar-SA', 'he-IL', 'fa', 'ur-PK']) expect(directionFor(rtl)).toBe('rtl');
    for (const ltr of ['en', 'hi-IN', 'zh-Hans-CN', null, '']) expect(directionFor(ltr)).toBe('ltr');
  });
});

describe('languageLabel', () => {
  it('renders names from the fetched catalogue, never raw input', () => {
    expect(languageLabel('hi-IN')).toBe('Hindi');
    expect(languageLabel('en')).toBe('English');
    expect(languageLabel('ar-SA')).toBe('Arabic');
  });

  it('degrades an unknown code to its tag rather than free text', () => {
    expect(languageLabel('xx')).toBe('XX');
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel('')).toBeNull();
  });

  it('degrades the same way before the catalogue has loaded', () => {
    // The catalogue arrives after first paint. A name that is not there yet
    // must render as its tag, never as raw conversation-derived text.
    resetLocaleCatalog();
    expect(languageLabel('hi-IN')).toBe('HI');
    expect(languageLabel(null)).toBeNull();
  });
});
