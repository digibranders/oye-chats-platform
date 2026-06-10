import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ToastProvider } from './context/ToastContext';
import { CrawlProvider } from './context/CrawlContext';
import { getAuthState } from './utils/auth';
import { getCurrentUser } from './services/api';

// Layouts
import AdminLayout from './layouts/AdminLayout';
import AffiliateLayout from './layouts/AffiliateLayout';

// Global UI
import GlobalCrawlIndicator from './components/GlobalCrawlIndicator';

// Pages
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import AffiliateAccept from './pages/AffiliateAccept';
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

// Components
import AccessDenied from './components/AccessDenied';

const ProtectedRoute = ({ children }) => {
    const isAuthenticated = !!localStorage.getItem('admin_token');
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    return children;
};

const SuperadminRoute = ({ children }) => {
    const isAuthenticated = !!localStorage.getItem('admin_token');
    const isSuperadmin = localStorage.getItem('is_superadmin') === 'true';
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    if (!isSuperadmin) return <Navigate to="/" replace />;
    return children;
};

/**
 * Guard for the affiliate-only tree. Anyone authenticated can enter — the
 * AffiliateDashboard itself surfaces a 403 EmptyState if the principal
 * isn't actually enrolled. We keep the route ungated by enrollment so a
 * customer who happens to know the URL never sees a "Not Found" — they
 * get the clear "you're not enrolled" message instead.
 */
const AffiliateRoute = ({ children }) => {
    const isAuthenticated = !!localStorage.getItem('admin_token');
    if (!isAuthenticated) return <Navigate to="/login" replace />;
    return children;
};

/**
 * Smart root redirect. The instant the user lands at "/", we fetch
 * /auth/me and route them based on who they are:
 *
 *   - superadmin           → /superadmin/overview
 *   - affiliate-only user  → /affiliate  (dedicated layout)
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
                <Routes>
                    {/* Public */}
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/forgot-password" element={<ForgotPassword />} />
                    {/* Affiliate magic-link landing — public; reads ?token=
                        and either lets the recipient set a password or
                        shows an "expired/invalid" message. */}
                    <Route path="/affiliate-accept" element={<AffiliateAccept />} />

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

                        {/* Accessible to all authenticated users.
                            NOTE: /affiliate moved to its own layout tree
                            below — affiliates get a dedicated shell rather
                            than the customer dashboard. */}
                        <Route path="billing" element={<Billing />} />
                        <Route path="credits" element={<Navigate to="/billing" replace />} />
                        <Route path="subscription" element={<Navigate to="/billing" replace />} />
                        <Route path="chatbot" element={<Chatbot />} />
                        <Route path="support" element={<Support />} />
                        <Route path="team" element={<TeamManagement />} />
                        <Route path="settings" element={<Settings />} />

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

                    {/* Affiliate — dedicated layout. Mirrors /superadmin's
                        shape: a separate tree with its own sidebar so
                        affiliate-only users never see the customer nav. */}
                    <Route
                        path="/affiliate"
                        element={
                            <AffiliateRoute>
                                <AffiliateLayout />
                            </AffiliateRoute>
                        }
                    >
                        <Route index element={<AffiliateDashboard />} />
                    </Route>

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
                        <Route path="affiliates" element={<SuperadminAffiliates />} />
                        <Route path="feedback" element={<SuperadminFeedback />} />
                    </Route>

                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </BrowserRouter>
        </ToastProvider>
    );
}

export default App;
