import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../shell/AppShell';
import { ProtectedLayout } from './ProtectedLayout';
import { OperatorRouteGuard } from './OperatorRouteGuard';
import Login from '../pages/Login';
import Register from '../pages/Register';
import VerifyEmail from '../pages/VerifyEmail';
import ForgotPassword from '../pages/ForgotPassword';
import OAuthCallback from '../pages/OAuthCallback';

// Admin 2.0 pages
import { HomePage } from '../features/home/HomePage';
import { AgentsPage } from '../features/agents/AgentsPage';
import { AgentLayout } from '../features/agents/AgentLayout';
import { OverviewPage } from '../features/agents/overview/OverviewPage';
import { KnowledgePage } from '../features/agents/knowledge/KnowledgePage';
import { ExperiencePage } from '../features/agents/experience/ExperiencePage';
import { ChannelsPage } from '../features/agents/channels/ChannelsPage';
import { AdvancedPage } from '../features/agents/advanced/AdvancedPage';
import { InboxPage } from '../features/inbox/InboxPage';
import { LeadsPage } from '../features/leads/LeadsPage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { WorkspaceLayout } from '../features/workspace/WorkspaceLayout';
import { GeneralPage } from '../features/workspace/GeneralPage';
import { MembersPage } from '../features/workspace/MembersPage';
import { BillingPage } from '../features/workspace/BillingPage';
import { UsagePage } from '../features/workspace/UsagePage';
import { ApiKeysPage } from '../features/workspace/ApiKeysPage';
import { IntegrationsPage } from '../features/workspace/IntegrationsPage';
import { AffiliatePage } from '../features/affiliate/AffiliatePage';
import { AffiliateInvite } from '../features/affiliate/AffiliateInvite';
import { InviteAirlock } from '../features/workspace/InviteAirlock';
import { SettingsPage } from '../features/settings';

// Error surfaces - attached as `errorElement`s so route/render crashes render an
// on-brand recovery UI instead of React Router's default developer screen.
import { RootErrorBoundary } from './errors/RootErrorBoundary';
import { PageErrorBoundary } from './errors/PageErrorBoundary';
import { NotFoundPage } from './errors/NotFoundPage';

// Launch Studio is a one-time onboarding flow on a separate route - lazy-load it
// so its layout + steps stay out of the initial bundle.
const LaunchStudio = lazy(() =>
  import('../features/launch-studio/LaunchStudio').then((m) => ({ default: m.LaunchStudio })),
);

/**
 * Route Architecture - the Admin Platform 2.0 information architecture.
 * The AI Agent is a first-class URL object: `/agents/:agentId/<tab>` (the six
 * tabs each answer one question). Launch Studio is a full-screen route OUTSIDE
 * the shell - temporary onboarding, never navigation.
 *
 * Error handling: a pathless root layout owns the app-wide `errorElement`
 * (`RootErrorBoundary`) so a shell/provider crash or a public-page loader error
 * surfaces on-brand full-screen. In-shell pages sit under a pathless
 * `PageErrorBoundary` so a single page crash renders inside the shell - the
 * sidebar/top bar survive and the user can navigate away.
 */
export const router = createBrowserRouter([
  {
    errorElement: <RootErrorBoundary />,
    children: [
      // ── Public - reused legacy auth pages; no guard, no data providers ──
      { path: '/login', element: <Login /> },
      { path: '/register', element: <Register /> },
      { path: '/verify-email', element: <VerifyEmail /> },
      { path: '/forgot-password', element: <ForgotPassword /> },
      { path: '/auth/callback', element: <OAuthCallback /> },
      { path: '/affiliate-invite', element: <AffiliateInvite /> },
      // Team-invite airlock - public magic link; resolves the token and routes
      // on auth state. Must stay OUTSIDE the ProtectedLayout guard so an
      // invited (often signed-out) visitor can land and accept.
      { path: '/invite/:token', element: <InviteAirlock /> },

      // ── Authenticated area - token guard + reused Workspace/Bot/Crawl providers ──
      {
        element: <ProtectedLayout />,
        children: [
          {
            path: '/',
            element: <AppShell />,
            // A crash in the shell chrome itself escalates to the full-screen boundary.
            errorElement: <RootErrorBoundary />,
            handle: { crumb: 'Home' },
            children: [
              // Pathless layout: page-level crashes bubble here and render the
              // in-shell PageErrorBoundary through the shell's <Outlet />, so the
              // sidebar and top bar survive and the user can navigate away.
              // `OperatorRouteGuard` also runs here so a plain operator can't
              // deep-link into owner/admin-only sections - it redirects them to
              // the live-chat console while owners/admins pass through.
              {
                errorElement: <PageErrorBoundary />,
                element: <OperatorRouteGuard />,
                children: [
                  { index: true, element: <HomePage /> },

                  // ── AI Agents ──────────────────────────────────────────────
                  {
                    path: 'agents',
                    handle: { crumb: 'AI Chatbots' },
                    children: [
                      { index: true, element: <AgentsPage /> },
                      {
                        path: ':agentId',
                        handle: { crumb: 'Agent' },
                        element: <AgentLayout />,
                        children: [
                          { index: true, element: <Navigate to="overview" replace /> },
                          { path: 'overview', handle: { crumb: 'Overview' }, element: <OverviewPage /> },
                          { path: 'knowledge', handle: { crumb: 'Knowledge' }, element: <KnowledgePage /> },
                          { path: 'experience', handle: { crumb: 'Experience' }, element: <ExperiencePage /> },
                          { path: 'channels', handle: { crumb: 'Channels' }, element: <ChannelsPage /> },
                          // Per-agent Analytics tab removed - performance lives on the
                          // agent-scoped workspace Analytics page. Redirect old links.
                          { path: 'analytics', element: <Navigate to="../overview" replace /> },
                          { path: 'advanced', handle: { crumb: 'Advanced' }, element: <AdvancedPage /> },
                        ],
                      },
                    ],
                  },

                  // ── Operations ─────────────────────────────────────────────
                  { path: 'inbox', handle: { crumb: 'Inbox' }, element: <InboxPage /> },
                  { path: 'leads', handle: { crumb: 'Leads' }, element: <LeadsPage /> },
                  { path: 'analytics', handle: { crumb: 'Analytics' }, element: <AnalyticsPage /> },

                  // ── Workspace ──────────────────────────────────────────────
                  {
                    path: 'workspace',
                    handle: { crumb: 'Workspace' },
                    element: <WorkspaceLayout />,
                    children: [
                      { index: true, element: <Navigate to="general" replace /> },
                      { path: 'general', handle: { crumb: 'General' }, element: <GeneralPage /> },
                      { path: 'members', handle: { crumb: 'Members' }, element: <MembersPage /> },
                      { path: 'billing', handle: { crumb: 'Billing' }, element: <BillingPage /> },
                      { path: 'usage', handle: { crumb: 'Usage' }, element: <UsagePage /> },
                      { path: 'api-keys', handle: { crumb: 'API Keys' }, element: <ApiKeysPage /> },
                      { path: 'integrations', handle: { crumb: 'Integrations' }, element: <IntegrationsPage /> },
                      { path: 'affiliate', handle: { crumb: 'Affiliate' }, element: <AffiliatePage /> },
                    ],
                  },
                  // Old Workspace ▸ Settings and ▸ Security moved to the top-level
                  // account pages - redirect so existing links/bookmarks keep working.
                  { path: 'workspace/settings', element: <Navigate to="/settings" replace /> },
                  { path: 'workspace/security', element: <Navigate to="/settings" replace /> },

                  // ── Settings - bottom-anchored secondary nav, not an object tab ──
                  { path: 'settings', handle: { crumb: 'Settings' }, element: <SettingsPage /> },

                  // Unknown routes get a real, in-shell 404 (sidebar/topbar survive).
                  { path: '*', element: <NotFoundPage /> },
                ],
              },
            ],
          },

          // Launch Studio - full-screen 8-step onboarding, OUTSIDE the app shell.
          {
            path: '/launch',
            children: [
              { index: true, element: <Navigate to="welcome" replace /> },
              {
                path: ':step',
                element: (
                  <Suspense fallback={null}>
                    <LaunchStudio />
                  </Suspense>
                ),
              },
            ],
          },
        ],
      },
    ],
  },
]);
