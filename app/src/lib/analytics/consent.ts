/**
 * Cookie consent constants for the admin console, mirrored from the marketing
 * site (`oyechats-website/src/lib/consent.ts`). The two properties share one
 * GTM container and one consent cookie name, so a change to either value here
 * must land on the website in the same release.
 *
 * Everything here is a plain value: the module is imported by `vite.config.js`
 * under Node to generate the inline head script, so it must not touch the DOM.
 */

/** Documented in the Cookie Policy; changing it breaks that promise. */
export const CONSENT_COOKIE = 'oyechats_consent';

export const GTM_CONTAINER_ID = 'GTM-MLWDW8VR';
export const GTM_ORIGIN = 'https://www.googletagmanager.com';

/**
 * The container loads only here. Keeps local dev, `vite preview` and every
 * Vercel preview deployment out of the analytics property.
 */
export const ANALYTICS_HOST = 'app.oyechats.com';

/**
 * EEA/UK/CH zones that do not carry the `Europe/` prefix. The prefix check
 * covers the rest. Blanket-matching `Europe/` over-includes non-EEA countries
 * (Russia, Turkiye, Ukraine, Serbia); that is deliberate. Defaulting a visitor
 * who did not legally need it to "denied" is harmless, the reverse is not.
 */
export const RESTRICTED_ZONES: readonly string[] = [
  'Atlantic/Reykjavik',
  'Atlantic/Canary',
  'Atlantic/Madeira',
  'Atlantic/Azores',
  'Atlantic/Faroe',
  'Indian/Reunion',
  'Indian/Mayotte',
  'America/Cayenne',
];
