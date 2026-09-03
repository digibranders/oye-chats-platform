/**
 * Mounts the dashboard UI-language runtime at the application root.
 *
 * Deliberately thin. The store itself is module-level (see `i18n.ts`) so that
 * non-React code can read the active locale without a context, exactly like
 * `services/localeCatalog` does. This component exists for the two things that
 * genuinely need a React lifecycle: reflecting the locale onto the document,
 * and warming the dictionary for a restored preference.
 *
 * RTL IS SUPPORTED. The admin converted its physical-direction Tailwind
 * classes (`ml-`, `pr-`, `text-left`, `rounded-tl-`, ...) to logical ones
 * (`ms-`, `pe-`, `text-start`, `rounded-ss-`, ...) so the layout mirrors
 * correctly under `dir="rtl"`, with `scripts/rtl-physical-classes.mjs` and
 * its vitest guard (`src/rtl.test.ts`) as the regression check: any new
 * physical class has to become logical or carry a reviewed `rtl-ok:`
 * exception. `dir` below is resolved per locale through
 * `directionForLocale`, so `ADMIN_UI_LANGUAGES` gaining an RTL locale (`ar`)
 * is exactly what turns it on — see `services/localeCatalog.ts`.
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
