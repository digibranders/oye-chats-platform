/**
 * Nav copy in the reader's language.
 *
 * `nav.ts` is a module constant evaluated at import, before any locale exists,
 * so its English strings cannot themselves be translated. They are the KEY and
 * the fallback: resolved here at render time, by whoever is drawing them.
 *
 * The key is DERIVED from the English rather than stored beside it, which is
 * the rule `useBreadcrumbs` already established — a copy edit to a nav label
 * cannot silently orphan its translation, it either resolves or falls back to
 * the English that is already on screen.
 *
 * Labels live under `app.crumb.*` and hints under `nav.hint.*`, both keyed off
 * the LABEL. One home each: the breadcrumb trail and the rail render the same
 * words, and two dictionaries for one label is how they drift apart.
 */

import { t as translateNow } from '../i18n/i18n';

/** "API Keys" -> apiKeys, so the key survives a copy edit to the label. */
export function crumbKey(text: string): string {
  const words = text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

/**
 * A nav or crumb label, translated.
 *
 * A chatbot's own name is never passed through here. It is the customer's text,
 * and translating it would rename their chatbot on screen.
 */
export function navLabel(label: string): string {
  return translateNow(`app.crumb.${crumbKey(label)}`) || label;
}

/** The one-line hint under a nav item, keyed off its label. */
export function navHint(label: string, hint: string): string {
  return translateNow(`nav.hint.${crumbKey(label)}`) || hint;
}
