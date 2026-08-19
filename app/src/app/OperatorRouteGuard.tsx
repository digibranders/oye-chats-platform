import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';
import { isOperatorAllowedPath } from '../shell/nav';

/**
 * OperatorRouteGuard - the route-layer half of operator scoping.
 *
 * Hiding owner/admin destinations from the sidebar (see `navForRole`) is a
 * convenience, not a boundary: a bookmark, a deep link, or `switchWorkspace`'s
 * redirect could still drop an operator onto `/agents`, `/analytics`, `/workspace`
 * or the dashboard. This pathless layout enforces the same allow-list at the
 * router, redirecting a plain operator to their live-chat console instead.
 *
 * It only ever narrows access for `isOperator` (a plain-operator membership in
 * someone else's workspace); owners and admins fall straight through to
 * `<Outlet />`. When the caller switches back into their own workspace they act
 * as owner again and the guard is inert.
 */
export function OperatorRouteGuard() {
  const { isOperator } = useWorkspace();
  const { pathname } = useLocation();

  if (isOperator && !isOperatorAllowedPath(pathname)) {
    return <Navigate to="/inbox" replace />;
  }

  return <Outlet />;
}
