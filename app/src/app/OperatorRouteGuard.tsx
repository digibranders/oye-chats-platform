import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';
import { isOperatorAllowedPath } from '../shell/nav';

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
 */
export function OperatorRouteGuard() {
  const { isOperator, isLoading } = useWorkspace();
  const { pathname } = useLocation();

  if (!isLoading && isOperator && !isOperatorAllowedPath(pathname)) {
    return <Navigate to="/inbox" replace />;
  }

  return <Outlet />;
}
