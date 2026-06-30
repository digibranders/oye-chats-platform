import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ToastProvider } from './context/ToastContext';
import { UpgradeModalProvider } from './context/UpgradeModalContext';
import { CrawlProvider } from './context/CrawlContext';
import { getAuthState } from './utils/auth';
import { getCurrentUser } from './services/api';

// Layouts
import AdminLayout from './layouts/AdminLayout';
// AffiliateLayout removed — the affiliate dashboard now lives inside the
// main AdminLayout, gated by the conditional Sidebar menu item rather than
// a dedicated shell. The standalone layout is retained on disk for one
// release for git-blame archaeology and will be deleted.

// Global UI
import GlobalCrawlIndicator from './components/GlobalCrawlIndicator';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import ForgotPassword from './pages/ForgotPassword';
import OAuthCallback from './pages/OAuthCallback';
import AffiliateInvite from './pages/AffiliateInvite';
import Dashboard from './pages/Dashboard';
import KnowledgeBase from './pages/KnowledgeBase';
import Settings from './pages/Settings';
import Chatbot from './pages/Chatbot';
import Leads from './pages/Leads';
import Qualification from './pages/Qualification';
import Insights from './pages/Insights';
import Support from './pages/Support';
import TeamManagement from './pages/TeamManagement';
import Integrations from './pages/Integrations';
import Billing from './pages/Billing';
import AffiliateDashboard from './pages/AffiliateDashboard';

// Superadmin
import SuperadminLayout from './layouts/SuperadminLayout';
import SuperadminOverview from './pages/superadmin/Overview';
import SuperadminClients from './pages/superadmin/Clients';
import SuperadminFeedback from './pages/superadmin/Feedback';
import SuperadminAffiliates from './pages/superadmin/Affiliates';
import SuperadminPricingInsights from './pages/superadmin/PricingInsights';

// Components
import AccessDenied from './components/AccessDenied';
import { getAuthItem } from './utils/authStorage';

// Build a "?next=..." login URL that round-trips the deep-link target through
// authentication. Used so push-notification clicks (which land on a specific
// /support?session=<id> URL) survive an intervening login bounce — without
// this, the operator would log in and lose track of which waiting chat they
// were trying to open.
//
// Only same-origin relative paths are preserved; anything else falls back to
// a bare /login redirect (prevents open-redirect via a crafted notification).
function loginUrlPreservingNext() {
    if (typeof window === 'undefined') return '/login';
    const next = window.location.pathname + window.location.search;
    const safe = next.startsWith('/') && !next.startsWith('//') && next !== '/login';
    return safe ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

const ProtectedRoute = ({ children }) => {
    const isAuthenticated = !!getAuthItem('admin_token');
    if (!isAuthenticated) return <Navigate to={loginUrlPreservingNext()} replace />;
    return children;
};

const SuperadminRoute = ({ children }) => {
    const isAuthenticated = !!getAuthItem('admin_token');
    const isSuperadmin = getAuthItem('is_superadmin') === 'true';
    if (!isAuthenticated) return <Navigate to={loginUrlPreservingNext()} replace />;
    if (!isSuperadmin) return <Navigate to="/" replace />;
    return children;
};

// AffiliateRoute removed — the dedicated layout guard is gone, the
// AffiliateDashboard now lives inside the main AdminLayout tree which
// is already wrapped in ProtectedRoute. AffiliateDashboard's own 403
// EmptyState handles unenrolled-but-curious visitors.

/**
 * One-release backwards-compat redirect: invites delivered before the
 * cut-over land at /affiliate-accept?token=… and need to be forwarded
 * to /affiliate-invite preserving the query string. Once the longest
 * unaccepted invite ages out (14 days post-cutover) this route can be
 * deleted.
 */
const LegacyAffiliateAcceptRedirect = () => {
    const search = typeof window !== 'undefined' ? window.location.search : '';
    return <Navigate to={`/affiliate-invite${search}`} replace />;
};

/**
 * Smart root redirect. The instant the user lands at "/", we fetch
 * /auth/me and route them based on who they are:
 *
 *   - superadmin           → /superadmin/overview
 *   - affiliate-only user  → /affiliate  (inside the main admin layout
 *                                          — the dedicated affiliate
 *                                          shell was removed; the page
 *                                          now lives alongside Billing,
 *                                          Settings, etc., with the
 *                                          Sidebar conditionally
 *                                          rendering the menu item)
 *   - everyone else        → render the customer Dashboard inline
 *
 * Failure to fetch /auth/me falls through to the customer Dashboard so
 * stale localStorage tokens don't trap users in an infinite loading
 * state. The 401 interceptor in services/api will redirect them to
 * /login if the token is actually invalid.
 */
const RootRedirect = ({ fallback }) => {
    const [destination, setDestination] = useState(null);
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getCurrentUser()
            .then((me) => {
                if (cancelled) return;
                if (me?.is_superadmin) {
                    setDestination('/superadmin/overview');
                } else if (me?.is_affiliate_only) {
                    setDestination('/affiliate');
                }
            })
            .catch(() => {
                /* fallback handles it */
            })
            .finally(() => {
                if (!cancelled) setResolved(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!resolved) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 size={28} className="animate-spin text-primary-500" />
            </div>
        );
    }
    if (destination) return <Navigate to={destination} replace />;
    return fallback;
};

/**
 * Renders children for workspace owners/admins.
 * Shows an in-place AccessDenied screen for regular operators — does NOT redirect,
 * so bookmarks continue to work if the user's role is later elevated.
 */
const ClientOnlyPage = ({ children, pageName }) => {
    const { isOperator, isBotManager } = getAuthState();
    if (isOperator && !isBotManager) return <AccessDenied pageName={pageName} />;
    return children;
};

function App() {
    return (
        <ToastProvider>
            <BrowserRouter>
                <UpgradeModalProvider>
                <Routes>
                    {/* Public */}
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    <Route path="/forgot-password" element={<ForgotPassword />} />
                    {/* OAuth callback — backend redirects here with the api_key
                        in the URL fragment after a successful Google sign-in. */}
                    <Route path="/auth/callback" element={<OAuthCallback />} />
                    {/* Partners invite landing — public; reads ?token= and
                        either auto-accepts (logged-in) or shows two CTAs
                        (sign in / sign up) for the recipient to choose. */}
                    <Route path="/affiliate-invite" element={<AffiliateInvite />} />
                    {/* Legacy URL — invites sent before the cut-over still
                        point at /affiliate-accept. Preserve the token. */}
                    <Route
                        path="/affiliate-accept"
                        element={<LegacyAffiliateAcceptRedirect />}
                    />

                    {/* App Routes (root) */}
                    {/* CrawlProvider wraps the authenticated admin tree so the
                        floating GlobalCrawlIndicator survives every page
                        navigation — the user can start a crawl on /knowledge,
                        wander over to /insights, and still see live progress.
                        Mounted inside ProtectedRoute so unauthenticated pages
                        (login / register / forgot-password) don't pay the
                        cost of the background poll loop. */}
                    <Route
                        path="/"
                        element={
                            <ProtectedRoute>
                                <CrawlProvider>
                                    <AdminLayout />
                                    <GlobalCrawlIndicator />
                                </CrawlProvider>
                            </ProtectedRoute>
                        }
                    >
                        {/* Owner-only pages — regular agents see AccessDenied in-place.
                            The index route gets a RootRedirect wrapper so superadmins
                            and affiliate-only users get bounced to their dedicated
                            shells before the customer Dashboard renders. */}
                        <Route
                            index
                            element={
                                <RootRedirect
                                    fallback={
                                        <ClientOnlyPage pageName="Overview"><Dashboard /></ClientOnlyPage>
                                    }
                                />
                            }
                        />
                        <Route path="knowledge" element={<ClientOnlyPage pageName="Sources"><KnowledgeBase /></ClientOnlyPage>} />
                        <Route path="insights" element={<ClientOnlyPage pageName="Insights"><Insights /></ClientOnlyPage>} />
                        <Route path="leads" element={<ClientOnlyPage pageName="Leads"><Leads /></ClientOnlyPage>} />
                        <Route path="qualification" element={<ClientOnlyPage pageName="Qualification"><Qualification /></ClientOnlyPage>} />
                        <Route path="integrations" element={<ClientOnlyPage pageName="Integrations"><Integrations /></ClientOnlyPage>} />
                        {/* Backward-compat redirects for old routes */}
                        <Route path="webhooks" element={<Navigate to="/integrations?tab=webhooks" replace />} />
                        <Route path="integrations/email" element={<Navigate to="/integrations?tab=email" replace />} />

                        {/* Accessible to all authenticated users. */}
                        <Route path="billing" element={<Billing />} />
                        <Route path="credits" element={<Navigate to="/billing" replace />} />
                        <Route path="subscription" element={<Navigate to="/billing" replace />} />
                        <Route path="chatbot" element={<Chatbot />} />
                        <Route path="support" element={<Support />} />
                        <Route path="team" element={<TeamManagement />} />
                        <Route path="settings" element={<Settings />} />
                        {/* Affiliate dashboard — visible in the sidebar only
                            when the current Client has an active affiliates
                            row (Sidebar.jsx checks /auth/me.is_affiliate).
                            The page itself surfaces a typed 403 EmptyState
                            for curious URL-walkers who aren't enrolled. */}
                        <Route path="affiliate" element={<AffiliateDashboard />} />

                        {/* Redirects for old URLs */}
                        <Route path="analytics" element={<Navigate to="/insights?tab=analytics" replace />} />
                        <Route path="users" element={<Navigate to="/insights?tab=conversations" replace />} />
                        <Route path="feedback" element={<Navigate to="/insights?tab=feedback" replace />} />
                        <Route path="live-chat" element={<Navigate to="/support?tab=live-chat" replace />} />
                        <Route path="messages" element={<Navigate to="/support?tab=messages" replace />} />
                        <Route path="interface" element={<Navigate to="/chatbot?tab=appearance" replace />} />
                        <Route path="canned-responses" element={<Navigate to="/team" replace />} />
                    </Route>

                    {/* Backwards compat: /admin/* → /* */}
                    <Route path="/admin" element={<Navigate to="/" replace />} />
                    <Route path="/admin/*" element={<Navigate to="/" replace />} />

                    {/* Superadmin */}
                    <Route
                        path="/superadmin"
                        element={
                            <SuperadminRoute>
                                <SuperadminLayout />
                            </SuperadminRoute>
                        }
                    >
                        <Route path="overview" element={<SuperadminOverview />} />
                        <Route path="clients" element={<SuperadminClients />} />
                        <Route path="pricing-insights" element={<SuperadminPricingInsights />} />
                        <Route path="affiliates" element={<SuperadminAffiliates />} />
                        <Route path="feedback" element={<SuperadminFeedback />} />
                    </Route>

                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
                </UpgradeModalProvider>
            </BrowserRouter>
        </ToastProvider>
    );
}

export default App;
