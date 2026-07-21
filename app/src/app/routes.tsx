import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../shell/AppShell';
import { ProtectedLayout } from './ProtectedLayout';
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
import { AgentAnalyticsPage } from '../features/agents/analytics/AgentAnalyticsPage';
import { AdvancedPage } from '../features/agents/advanced/AdvancedPage';
import { InboxPage } from '../features/inbox/InboxPage';
import { LeadsPage } from '../features/leads/LeadsPage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { MembersPage } from '../features/workspace/MembersPage';
import { BillingPage } from '../features/workspace/BillingPage';
import { UsagePage } from '../features/workspace/UsagePage';
import { SecurityPage } from '../features/workspace/SecurityPage';
import { ApiKeysPage } from '../features/workspace/ApiKeysPage';
import { IntegrationsPage } from '../features/workspace/IntegrationsPage';
import { SettingsPage } from '../features/workspace/SettingsPage';

// Launch Studio is a one-time onboarding flow on a separate route — lazy-load it
// so its layout + steps stay out of the initial bundle.
const LaunchStudio = lazy(() =>
  import('../features/launch-studio/LaunchStudio').then((m) => ({ default: m.LaunchStudio })),
);

/**
 * Route Architecture — the Admin Platform 2.0 information architecture.
 * The AI Agent is a first-class URL object: `/agents/:agentId/<tab>` (the six
 * tabs each answer one question). Launch Studio is a full-screen route OUTSIDE
 * the shell — temporary onboarding, never navigation.
 */
export const router = createBrowserRouter([
  // ── Public — reused legacy auth pages; no guard, no data providers ──
  { path: '/login', element: <Login /> },
  { path: '/register', element: <Register /> },
  { path: '/verify-email', element: <VerifyEmail /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/auth/callback', element: <OAuthCallback /> },

  // ── Authenticated area — token guard + reused Workspace/Bot/Crawl providers ──
  {
    element: <ProtectedLayout />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        handle: { crumb: 'Home' },
        children: [
          { index: true, element: <HomePage /> },

          // ── AI Agents ──────────────────────────────────────────────
          {
            path: 'agents',
            handle: { crumb: 'AI Agents' },
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
                  { path: 'analytics', handle: { crumb: 'Analytics' }, element: <AgentAnalyticsPage /> },
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
            children: [
              { index: true, element: <Navigate to="members" replace /> },
              { path: 'members', handle: { crumb: 'Members' }, element: <MembersPage /> },
              { path: 'billing', handle: { crumb: 'Billing' }, element: <BillingPage /> },
              { path: 'usage', handle: { crumb: 'Usage' }, element: <UsagePage /> },
              { path: 'security', handle: { crumb: 'Security' }, element: <SecurityPage /> },
              { path: 'api-keys', handle: { crumb: 'API Keys' }, element: <ApiKeysPage /> },
              { path: 'integrations', handle: { crumb: 'Integrations' }, element: <IntegrationsPage /> },
              { path: 'settings', handle: { crumb: 'Settings' }, element: <SettingsPage /> },
            ],
          },
        ],
      },

      // Launch Studio — full-screen 8-step onboarding, OUTSIDE the app shell.
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

  // Unknown routes fall back to Home.
  { path: '*', element: <Navigate to="/" replace /> },
]);
