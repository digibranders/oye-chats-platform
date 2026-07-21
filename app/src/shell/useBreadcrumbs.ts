import { useMatches } from 'react-router-dom';
import { type Crumb } from '../design-system';

interface RouteHandle {
  crumb?: string;
}

/**
 * Derive the breadcrumb trail from the matched route handles. Each route in
 * the route architecture declares `handle: { crumb: 'Label' }`; this reads
 * them in order, so breadcrumbs stay data-driven and never drift from routing.
 */
export function useBreadcrumbs(): Crumb[] {
  const matches = useMatches();
  return matches
    .filter((match): match is typeof match & { handle: RouteHandle } => {
      const handle = match.handle as RouteHandle | undefined;
      return Boolean(handle?.crumb);
    })
    .map((match) => ({
      label: (match.handle as RouteHandle).crumb as string,
      to: match.pathname,
    }));
}
