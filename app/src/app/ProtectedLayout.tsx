import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getAuthItem } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';
import { WorkspaceProvider } from '../context/WorkspaceContext';
import { BotProvider } from '../context/BotContext';
import { CrawlProvider } from '../context/CrawlContext';
import { CurrencyProvider } from '../context/CurrencyContext';
import { NotificationProvider } from '../context/NotificationContext';
import { EntitlementsProvider } from '../context/EntitlementsContext';
import { UpgradeModalProvider } from '../context/UpgradeModalContext';
import { sessionNeedsEmailVerification, verifyUrlWithNext } from './emailVerificationGate';
import { VerificationReconciler } from './VerificationReconciler';

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
 * ProtectedLayout - the authenticated boundary for the new app.
 *
 * Gates on the presence of an auth token (reusing the legacy `authStorage`), and
 * mounts the reused data providers around everything below. The three data
 * providers are mutually independent and self-contained (they read `authStorage`
 * + the API client and coordinate via window events), so this is the minimum
 * correct tree to reuse the backend layer. `NotificationProvider` (the TopBar
 * bell's data source) is nested innermost, after Workspace/Currency, since it
 * needs the authenticated + workspace-scoped context to be established first -
 * it listens for `oyechats:workspace-switched` to re-hydrate on workspace switch.
 * `EntitlementsProvider` (plan/limit/feature gating) and `UpgradeModalProvider`
 * (the upsell dialog it opens) are mounted innermost of all, after
 * Workspace/Currency/Notification - entitlements are workspace-scoped and
 * re-fetch on the same `oyechats:workspace-switched` signal. Other chrome-only
 * providers (Toast/Push/…) are added per-surface as migrated pages need them.
 */
export function ProtectedLayout() {
  const { pathname, search } = useLocation();
  // Two credentials open this boundary: a customer's own `admin_token` (shared
  // across tabs via localStorage) and a super-admin's tab-scoped impersonation
  // token. The latter has no `admin_token` at all - without this the redeemed
  // support session would bounce straight to /login.
  const isAuthenticated = isImpersonating() || Boolean(getAuthItem('admin_token'));

  if (!isAuthenticated) {
    return <Navigate to={loginUrlWithNext(pathname, search)} replace />;
  }

  // Second boundary: an authenticated but unverified account is held on
  // `/verify-email` until it proves it owns its address. That route is PUBLIC
  // (declared outside this layout in routes.tsx), so this gate never runs there
  // and cannot loop; the deep link the user was reaching for round-trips as
  // `next`. Logout stays reachable - the verify screen carries its own sign-out.
  // Operators, super-admins and impersonation tabs are exempt; see the gate.
  if (sessionNeedsEmailVerification()) {
    return <Navigate to={verifyUrlWithNext(pathname, search)} replace />;
  }

  return (
    <WorkspaceProvider>
      {/* Renders nothing. Watches the `/auth/me` the shell already fetches and
          bounces a session the server does not consider verified, closing the
          one direction the positive-only gate above cannot. */}
      <VerificationReconciler />
      <BotProvider>
        <CrawlProvider>
          {/* CurrencyProvider (fed by /subscriptions/geo) lets billing surfaces
              render prices in the account's charge currency (INR/USD). */}
          <CurrencyProvider>
            <NotificationProvider>
              <EntitlementsProvider>
                <UpgradeModalProvider>
                  <Outlet />
                </UpgradeModalProvider>
              </EntitlementsProvider>
            </NotificationProvider>
          </CurrencyProvider>
        </CrawlProvider>
      </BotProvider>
    </WorkspaceProvider>
  );
}
