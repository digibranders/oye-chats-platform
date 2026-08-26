import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../query/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { router } from './routes';

/** CDN URL for the embeddable OyeChats chat widget. */
const OYECHATS_WIDGET_SRC = 'https://cdn.oyechats.com/oyechats-widget.js';

/**
 * Application root (Admin Platform 2.0 foundation).
 *
 * Composes the global providers and the routes.
 *
 * The query client is the outermost provider because everything below it reads
 * server state through the cache — including the shell itself, which needs the
 * signed-in identity and the chatbot list before it can render a rail. The
 * workspace-scoped data contexts are mounted inside the authenticated boundary
 * in `ProtectedLayout`, where a token is guaranteed to exist.
 *
 * `I18nProvider` sits outside the router, because the dashboard's interface
 * language is a presentation preference of the same class as theme or
 * contrast: every route renders through it, and a language change must not be
 * a navigation. It is unrelated to `Operator.preferred_locale` (the language
 * an operator reads live chat in) and must never be derived from it.
 *
 * There is no theme provider. The console is light-only by design: one theme
 * done properly, and every ground in the token file a known quantity because of
 * it. See `DESIGN.md`.
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
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>
  );
}
