import { GTM_ORIGIN } from '../src/lib/analytics/consent.ts';
import { consentBootstrapScript } from '../src/lib/analytics/consentBootstrap.ts';

/**
 * Injects the consent bootstrap and the GTM preconnect pair into the `<head>`
 * of `index.html`, in dev and in build alike.
 *
 * The script is generated from `src/lib/analytics/consentBootstrap.ts` rather
 * than pasted into `index.html` so that the constants stay typed, the string is
 * unit-tested by vitest, and the host gate cannot drift from the source of
 * truth. Vite bundles this config-time import with esbuild, so the `.ts`
 * extension is resolved without a separate compile step.
 *
 * The tags are appended to `<head>` rather than prepended: the HTML spec wants
 * `<meta charset>` inside the first 1024 bytes of the document, and a 1.4KB
 * script ahead of it would push it out. An inline head script still runs
 * synchronously during parse, ahead of the deferred module bundle, so the
 * consent default is in the dataLayer before any other code can execute. The
 * container itself is injected lazily by the bootstrap and never blocks the
 * parser.
 *
 * The preconnect carries no `crossorigin`: gtm.js is a classic (non-CORS)
 * script, and a CORS preconnect opens a connection the real request cannot
 * reuse, which Lighthouse flags as an unused preconnect.
 */
export function oyechatsAnalyticsPlugin() {
  return {
    name: 'oyechats-analytics',
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'preconnect', href: GTM_ORIGIN }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'dns-prefetch', href: GTM_ORIGIN }, injectTo: 'head' },
        {
          tag: 'script',
          attrs: { id: 'consent-bootstrap' },
          children: consentBootstrapScript(),
          injectTo: 'head',
        },
      ];
    },
  };
}
