/**
 * The time-of-day greeting.
 *
 * Its own module so `HomePage.tsx` stays components-only, which is the contract
 * Vite's fast refresh enforces. Same reason `utils/trialBanner` was split out
 * from the banner that used it.
 *
 * One table rather than three `if`s returning bare strings, so the word and its
 * emoji cannot drift apart - they are the same fact stated twice, and the
 * afternoon sun turning up beside "Good evening" is the kind of thing nobody
 * notices in review because reviews do not happen at 19:00.
 */

import { t as translateNow } from '../../i18n/i18n';

// The KEY travels with the English, not instead of it: this table is a module
// constant evaluated at import, before any locale exists, so the word has to be
// resolved where it is rendered. Same reason `nav.ts` carries labels.
// @i18n-exempt: fallbacks. Each row carries its own key, resolved at render.
const GREETINGS = [
  { before: 12, key: 'home.goodMorning', text: 'Good morning', emoji: '🌅' },
  { before: 18, key: 'home.goodAfternoon', text: 'Good afternoon', emoji: '☀️' },
  { before: 24, key: 'home.goodEvening', text: 'Good evening', emoji: '🌙' },
] as const;

export type Greeting = (typeof GREETINGS)[number];

export function greeting(now: Date): Greeting {
  const hour = now.getHours();
  return GREETINGS.find((slot) => hour < slot.before) ?? GREETINGS[GREETINGS.length - 1];
}

/**
 * The greeting word for an instant, in the reader's language.
 *
 * Resolved at call time rather than at import. The caller must be subscribed to
 * the locale (every component that renders copy goes through `useTranslation`),
 * or the word would keep whatever language the screen mounted in.
 */
export function greetingFor(now: Date): string {
  const slot = greeting(now);
  return translateNow(slot.key) || slot.text;
}
