import { useMatches } from 'react-router-dom';
import { t as translateNow } from '../i18n/i18n';
import { type Crumb } from '../design-system';

interface RouteHandle {
  crumb?: string;
}

/**
 * Derive the breadcrumb trail from the matched route handles. Each route in
 * the route architecture declares `handle: { crumb: 'Label' }`; this reads
 * them in order, so breadcrumbs stay data-driven and never drift from routing.
 */
/** "API Keys" -> apiKeys, so the key survives a copy edit to the label. */
function crumbKey(crumb: string): string {
  const words = crumb.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

export function useBreadcrumbs(): Crumb[] {
  const matches = useMatches();
  return matches
    .filter((match): match is typeof match & { handle: RouteHandle } => {
      const handle = match.handle as RouteHandle | undefined;
      return Boolean(handle?.crumb);
    })
    .map((match) => {
      const crumb = (match.handle as RouteHandle).crumb as string;
      // The route table is built at import, before a locale exists, so its
      // crumbs are the English fallback and the label resolves here, keyed on
      // the crumb itself. `useMatches` re-runs on every render, so a language
      // switch updates the trail.
      return { label: translateNow(`app.crumb.${crumbKey(crumb)}`) || crumb, to: match.pathname };
    });
}
