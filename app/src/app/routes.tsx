import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../shell/AppShell';
import { ProtectedLayout } from './ProtectedLayout';
import { OperatorRouteGuard } from './OperatorRouteGuard';
import { AgentScope } from './AgentScope';
import Login from '../pages/Login';
import Register from '../pages/Register';
import VerifyEmail from '../pages/VerifyEmail';
import ForgotPassword from '../pages/ForgotPassword';
import OAuthCallback from '../pages/OAuthCallback';

import { HomePage } from '../features/home/HomePage';
import { AgentsPage } from '../features/agents/AgentsPage';
import { OverviewPage } from '../features/agents/overview/OverviewPage';
import { KnowledgePage } from '../features/agents/knowledge/KnowledgePage';
import { ExperiencePage } from '../features/agents/experience/ExperiencePage';
import { ChannelsPage } from '../features/agents/channels/ChannelsPage';
import { QualificationPage } from '../features/agents/advanced/QualificationPage';
import { BehaviourPage } from '../features/agents/advanced/BehaviourPage';
import { InboxPage } from '../features/inbox/InboxPage';
import { LeadsPage } from '../features/leads/LeadsPage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { JourneyPage } from '../features/analytics/JourneyPage';
import { WorkspaceLayout } from '../features/workspace/WorkspaceLayout';
import { GeneralPage } from '../features/workspace/GeneralPage';
import { MembersPage } from '../features/workspace/MembersPage';
import { BillingPage } from '../features/workspace/BillingPage';
import { UsagePage } from '../features/workspace/UsagePage';
import { ReportsPage } from '../features/workspace/ReportsPage';
import { ApiKeysPage } from '../features/workspace/ApiKeysPage';
import { IntegrationsPage } from '../features/workspace/IntegrationsPage';
import { AffiliatePage } from '../features/affiliate/AffiliatePage';
import { AffiliateInvite } from '../features/affiliate/AffiliateInvite';
import { InviteAirlock } from '../features/workspace/InviteAirlock';
import { SettingsPage } from '../features/settings';
import { SetupPage } from '../onboarding/SetupPage';
import { FirstRunPage } from '../onboarding/FirstRunPage';
import { FirstChatPage } from '../onboarding/FirstChatPage';
import { Moved, MovedAgent } from './Moved';

import { platformRoutes } from '../superadmin/routes';
import { RootErrorBoundary } from './errors/RootErrorBoundary';
import { PageErrorBoundary } from './errors/PageErrorBoundary';
import { NotFoundPage } from './errors/NotFoundPage';

const UiGallery = lazy(() => import('../dev/UiGallery').then((m) => ({ default: m.UiGallery })));

/**
 * The console's routes.
 *
 * Two scopes, matching the rail: workspace destinations at the top level, and a
 * chatbot's destinations under `/chatbots/:agentId`. `AgentScope` mounts the
 * chatbot provider and renders nothing else — the rail carries the chatbot's
 * navigation and the top bar names it, so the per-chatbot layout that used to
 * render its own heading and tab row is gone.
 *
 * Error surfaces are attached as `errorElement`s: a shell or provider crash goes
 * full-screen, while a single page crash renders inside the shell so the rail
 * survives and the user can navigate away.
 */
export const router = createBrowserRouter([
  {
    errorElement: <RootErrorBoundary />,
    children: [
      // Renders only the design system, so it needs no auth and no data
      // providers — which is also what makes it usable as a smoke test.
      {
        path: '/dev/ui',
        element: (
          <Suspense fallback={null}>
            <UiGallery />
          </Suspense>
        ),
      },

      // The platform console. Its own shell and its own URL space, outside the
      // customer providers: a super-admin has no workspace, no plan and no
      // chatbots, and mounting them would fetch a workspace that does not exist.
      platformRoutes,

      // ── Public ────────────────────────────────────────────────────────────
      { path: '/login', element: <Login /> },
      { path: '/register', element: <Register /> },
      { path: '/verify-email', element: <VerifyEmail /> },
      { path: '/forgot-password', element: <ForgotPassword /> },
      { path: '/auth/callback', element: <OAuthCallback /> },
      { path: '/affiliate-invite', element: <AffiliateInvite /> },
      // The team-invite airlock resolves a magic link and routes on auth state,
      // so it must stay outside the guard: the invited visitor is usually
      // signed out when they land.
      { path: '/invite/:token', element: <InviteAirlock /> },

      // ── Authenticated ─────────────────────────────────────────────────────
      {
        element: <ProtectedLayout />,
        children: [
          {
            path: '/',
            element: <AppShell />,
            errorElement: <RootErrorBoundary />,
            children: [
              {
                errorElement: <PageErrorBoundary />,
                element: <OperatorRouteGuard />,
                children: [
                  { index: true, element: <HomePage /> },
                  { path: 'setup', element: <SetupPage /> },

                  // First run. Inside the shell, deliberately: the wizard this
                  // replaces lived outside it, so a customer could hand over a
                  // card on a screen structurally incapable of telling them
                  // their last payment had failed.
                  { path: 'welcome', element: <FirstRunPage /> },
                  { path: 'welcome/:agentId', element: <FirstChatPage /> },

                  // ── Chatbots ────────────────────────────────────────────
                  {
                    path: 'chatbots',
                    children: [
                      { index: true, element: <AgentsPage /> },
                      {
                        path: ':agentId',
                        element: <AgentScope />,
                        children: [
                          { index: true, element: <Navigate to="overview" replace /> },
                          { path: 'overview', element: <OverviewPage /> },
                          { path: 'knowledge', element: <KnowledgePage /> },
                          { path: 'experience', element: <ExperiencePage /> },
                          { path: 'deploy', element: <ChannelsPage /> },
                          // Qualification is promoted out of the technical tab:
                          // it is a revenue surface, not a configuration corner.
                          { path: 'qualification', element: <QualificationPage /> },
                          { path: 'behaviour', element: <BehaviourPage /> },
                        ],
                      },
                    ],
                  },

                  // ── Operations ──────────────────────────────────────────
                  { path: 'inbox', element: <InboxPage /> },
                  { path: 'leads', element: <LeadsPage /> },
                  { path: 'analytics', element: <AnalyticsPage /> },
                  { path: 'analytics/journey', element: <JourneyPage /> },

                  // ── Billing ─────────────────────────────────────────────
                  { path: 'billing', element: <BillingPage /> },
                  { path: 'billing/usage', element: <UsagePage /> },
                  { path: 'billing/reports', element: <ReportsPage /> },

                  // ── Settings ────────────────────────────────────────────
                  {
                    path: 'settings',
                    element: <WorkspaceLayout />,
                    children: [
                      { index: true, element: <Navigate to="workspace" replace /> },
                      { path: 'workspace', element: <GeneralPage /> },
                      { path: 'team', element: <MembersPage /> },
                      { path: 'integrations', element: <IntegrationsPage /> },
                      { path: 'developers', element: <ApiKeysPage /> },
                      { path: 'affiliate', element: <AffiliatePage /> },
                    ],
                  },

                  // Your own account, distinct from the workspace's settings.
                  { path: 'account', element: <SettingsPage /> },
                  { path: 'account/preferences', element: <SettingsPage /> },

                  // ── Moved ───────────────────────────────────────────────
                  { path: 'agents', element: <Moved to="/chatbots" /> },
                  { path: 'agents/:agentId', element: <MovedAgent /> },
                  { path: 'agents/:agentId/overview', element: <MovedAgent segment="overview" /> },
                  { path: 'agents/:agentId/knowledge', element: <MovedAgent segment="knowledge" /> },
                  { path: 'agents/:agentId/experience', element: <MovedAgent segment="experience" /> },
                  { path: 'agents/:agentId/channels', element: <MovedAgent segment="deploy" /> },
                  { path: 'agents/:agentId/advanced', element: <MovedAgent segment="behaviour" /> },
                  { path: 'agents/:agentId/analytics', element: <MovedAgent segment="overview" /> },
                  { path: 'journey', element: <Moved to="/analytics/journey" /> },
                  { path: 'support', element: <Moved to="/inbox" /> },
                  { path: 'build', element: <Moved to="/setup" /> },
                  { path: 'launch', element: <Moved to="/setup" /> },
                  { path: 'launch/:step', element: <Moved to="/setup" /> },
                  { path: 'workspace', element: <Moved to="/settings/workspace" /> },
                  { path: 'workspace/general', element: <Moved to="/settings/workspace" /> },
                  { path: 'workspace/members', element: <Moved to="/settings/team" /> },
                  { path: 'workspace/billing', element: <Moved to="/billing" /> },
                  { path: 'workspace/usage', element: <Moved to="/billing/usage" /> },
                  { path: 'workspace/reports', element: <Moved to="/billing/reports" /> },
                  { path: 'workspace/api-keys', element: <Moved to="/settings/developers" /> },
                  { path: 'workspace/integrations', element: <Moved to="/settings/integrations" /> },
                  { path: 'workspace/affiliate', element: <Moved to="/settings/affiliate" /> },
                  { path: 'workspace/settings', element: <Moved to="/account" /> },
                  { path: 'workspace/security', element: <Moved to="/account" /> },
                  { path: 'billing/affiliate', element: <Moved to="/settings/affiliate" /> },

                  { path: '*', element: <NotFoundPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
