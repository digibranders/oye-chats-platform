import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getAuthItem } from '../utils/authStorage';
import { WorkspaceProvider } from '../context/WorkspaceContext';
import { BotProvider } from '../context/BotContext';
import { CrawlProvider } from '../context/CrawlContext';

/**
 * Build a `/login?next=…` URL that round-trips the current deep link through
 * authentication. Only same-origin relative paths are preserved (guards against
 * open-redirect via a crafted URL).
 */
function loginUrlWithNext(pathname: string, search: string): string {
  const next = `${pathname}${search}`;
  const safe = next.startsWith('/') && !next.startsWith('//') && next !== '/login';
  return safe ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

/**
 * ProtectedLayout — the authenticated boundary for the new app.
 *
 * Gates on the presence of an auth token (reusing the legacy `authStorage`), and
 * mounts the reused data providers around everything below. The three providers
 * are mutually independent and self-contained (they read `authStorage` + the API
 * client and coordinate via window events), so this is the minimum correct tree
 * to reuse the backend layer. Chrome-only providers (Toast/Notification/Push/…)
 * are added per-surface as migrated pages need them.
 */
export function ProtectedLayout() {
  const { pathname, search } = useLocation();
  const isAuthenticated = Boolean(getAuthItem('admin_token'));

  if (!isAuthenticated) {
    return <Navigate to={loginUrlWithNext(pathname, search)} replace />;
  }

  return (
    <WorkspaceProvider>
      <BotProvider>
        <CrawlProvider>
          <Outlet />
        </CrawlProvider>
      </BotProvider>
    </WorkspaceProvider>
  );
}
