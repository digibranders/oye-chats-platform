import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../query/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { router } from './routes';

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
 *
 * **The product's own chat widget is not embedded here.** The root used to
 * inject `cdn.oyechats.com/oyechats-widget.js` on every admin page. It sat over
 * the bottom-right corner of every surface — which is where the console puts
 * real controls: the Leads table's paging, a `SaveBar`'s buttons, the inbox
 * composer — and its launcher and greeting panel covered them. It is a support
 * channel for *customers of our customers*, running inside the tool its own
 * operators work in all day. Support for this app belongs in the feedback
 * launcher the shell already has.
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>
  );
}
