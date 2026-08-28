import { Outlet, useLocation } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';
import { isOperatorAllowedPath } from '../shell/nav';
import { ForbiddenPage } from './errors/ForbiddenPage';

/**
 * The route-layer half of operator scoping.
 *
 * Hiding owner and admin destinations from the rail is a convenience, not a
 * boundary: a bookmark, a deep link or a workspace switch could still drop a
 * plain operator onto `/chatbots`, `/analytics` or `/settings`. This pathless
 * layout enforces the same allow-list at the router.
 *
 * It waits for the membership list. The guard used to run against the role
 * restored from storage, which was the coarse membership role rather than the
 * effective seat — so on every reload a *linked admin* was read back as an
 * operator and redirected to `/inbox`, throwing away the URL they had opened.
 * A redirect made on a provisional answer cannot be taken back, so the guard
 * makes none until it has the real one.
 *
 * And it **answers** rather than redirecting. Bouncing an operator to `/inbox`
 * discarded the address they had asked for and told them nothing about why —
 * the reader could not tell whether the page had moved, been renamed, or was
 * simply not theirs.
 */
export function OperatorRouteGuard() {
  const { isOperator, isLoading } = useWorkspace();
  const { pathname } = useLocation();

  if (!isLoading && isOperator && !isOperatorAllowedPath(pathname)) {
    return (
      <ForbiddenPage
        description="Your operator seat covers the inbox and the leads it produces. An owner or an admin of this workspace can open the rest."
        to="/inbox"
        toLabel="Go to the inbox"
      />
    );
  }

  return <Outlet />;
}
