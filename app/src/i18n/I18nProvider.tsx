/**
 * Mounts the dashboard UI-language runtime at the application root.
 *
 * Deliberately thin. The store itself is module-level (see `i18n.ts`) so that
 * non-React code can read the active locale without a context, exactly like
 * `services/localeCatalog` does. This component exists for the two things that
 * genuinely need a React lifecycle: reflecting the locale onto the document,
 * and warming the dictionary for a restored preference.
 *
 * RTL IS OUT OF SCOPE. Both launch languages are LTR, and the admin carries
 * ~216 physical direction-dependent Tailwind classes against 7 logical ones,
 * so flipping `dir` would mirror padding, borders and icon positions with no
 * automated way to verify the result. `dir` is therefore pinned to `ltr` and
 * `ADMIN_UI_LANGUAGES` must never gain an RTL locale until that conversion is
 * done as its own piece of work.
 */

import { useEffect, type ReactNode } from 'react';

import { getLocale, preloadDictionary, subscribeLocale } from './i18n';
import { directionForLocale } from '../services/localeCatalog';

function applyDocumentLocale(locale: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('lang', locale);

  // Only ever ltr for the shipped languages. Resolved rather than hardcoded so
  // that if an RTL locale is ever added to ADMIN_UI_LANGUAGES the attribute
  // tells the truth instead of silently lying about the layout.
  root.setAttribute('dir', directionForLocale(locale));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyDocumentLocale(getLocale());

    // A restored non-English preference has no dictionary in memory yet on a
    // cold load, so without this the first paint is English and then flips.
    void preloadDictionary(getLocale());

    return subscribeLocale(() => {
      applyDocumentLocale(getLocale());
    });
  }, []);

  return <>{children}</>;
}
