/**
 * React binding for the dashboard UI-language runtime.
 *
 * Uses `useSyncExternalStore` over the module-level store, matching how
 * `ThemeProvider` already subscribes to the OS colour-scheme query. That
 * matters for correctness, not style: a component that reads `getLocale()`
 * during render without subscribing would freeze whatever string it resolved
 * at mount, and the screen would half-update on a language switch. Every
 * component that renders copy must go through this hook.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { getLanguage, getLocale, subscribeLocale, t as translate } from './i18n';

export interface Translation {
  /** Active BCP-47 tag: `en-IN`, `hi-IN`. */
  locale: string;
  /** Active base language: `en`, `hi`. */
  language: string;
  /** Translate a dotted key. Returns null on a miss, so `|| 'English'` works. */
  t: (key: string, params?: Record<string, unknown>) => string | null;
}

function getServerSnapshot(): string {
  // No localStorage during SSR/prerender; English is the canonical default.
  return 'en-IN';
}

export function useTranslation(): Translation {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getServerSnapshot);

  // Re-created whenever the locale changes, so memoised children that close
  // over `t` are invalidated too. A stable identity here would leave
  // React.memo subtrees rendering the previous language.
  const t = useCallback(
    (key: string, params?: Record<string, unknown>) => translate(key, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity must follow the locale
    [locale],
  );

  return { locale, language: getLanguage(), t };
}
