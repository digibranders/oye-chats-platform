import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { ThemeProvider } from '../design-system';
import { I18nProvider } from '../i18n/I18nProvider';
import { router } from './routes';

/** CDN URL for the embeddable OyeChats chat widget. */
const OYECHATS_WIDGET_SRC = 'https://cdn.oyechats.com/oyechats-widget.js';

/**
 * Application root (Admin Platform 2.0 foundation).
 *
 * Composes the global providers and the route architecture. Phase 1 keeps the
 * provider tree intentionally lean - data contexts (Workspace, Agent,
 * Notifications, etc.) are mounted as the pages that need them are built in
 * later phases, per the strangler-fig migration (decision #3).
 *
 * `I18nProvider` sits INSIDE `ThemeProvider` and outside the router: it owns
 * the dashboard's own interface language, which is a presentation preference
 * of the same class as theme and contrast. It is unrelated to
 * `Operator.preferred_locale` (the language an operator reads live chat in)
 * and must never be derived from it.
 */
export default function App() {
  // Embed the OyeChats chat widget on the admin app itself. Guarded against
  // double-injection - React StrictMode double-invokes effects in dev and the
  // root can remount - so the self-initializing widget IIFE runs at most once.
  useEffect(() => {
    if (document.querySelector(`script[src="${OYECHATS_WIDGET_SRC}"]`)) return;
    const script = document.createElement('script');
    script.src = OYECHATS_WIDGET_SRC;
    script.async = true;
    script.setAttribute('data-bot-key', 'bot-ba37e8a8216a');
    document.body.appendChild(script);
  }, []);

  return (
    <ThemeProvider>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </ThemeProvider>
  );
}
