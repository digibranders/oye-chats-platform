import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Spinner } from '../ui';
import { AppShell } from '../shell/AppShell';
import { ProtectedLayout } from './ProtectedLayout';
import { OperatorRouteGuard } from './OperatorRouteGuard';
import { AgentScope } from './AgentScope';
import { Moved, MovedAgent } from './Moved';
import { LEGACY_AGENT_SEGMENTS, LEGACY_PATHS } from './redirects';

// Eager on purpose: the sign-in form is the most common cold entry into the
// app, and making a signed-out visitor wait on a second round trip to see a
// password field is the one place a split chunk is a straight loss.
import Login from '../pages/Login';

import { RootErrorBoundary } from './errors/RootErrorBoundary';
import { PageErrorBoundary } from './errors/PageErrorBoundary';
import { NotFoundPage } from './errors/NotFoundPage';

/* The Suspense wrapper and the lazy helper below are route plumbing, not
   exported components — this file's export is the router. */
/* eslint-disable react-refresh/only-export-components */

/**
 * Every routed surface is split.
 *
 * The bundle was one 2.2MB chunk, so opening the sign-in page downloaded the
 * billing tables, the journey diagram, Recharts, and the whole platform
 * console. Splitting per route means a visitor pays for the screen they asked
 * for; the shell, the guards and the error surfaces stay eager because they are
 * on every path anyway.
 *
 * `named` exists because these modules export named components rather than
 * defaults — the shape `React.lazy` wants — and writing the `.then` by hand
 * thirty times is thirty chances to point one of them at the wrong export.
 */
function named<T, K extends keyof T>(loader: () => Promise<T>, key: K) {
  return lazy(
    () =>
      loader().then((module) => ({
        default: module[key] as unknown as React.ComponentType<Record<string, never>>,
      })),
  );
}

const Register = lazy(() => import('../pages/Register'));
const VerifyEmail = lazy(() => import('../pages/VerifyEmail'));
const ForgotPassword = lazy(() => import('../pages/ForgotPassword'));
const OAuthCallback = lazy(() => import('../pages/OAuthCallback'));

const HomePage = named(() => import('../features/home/HomePage'), 'HomePage');
const AgentsPage = named(() => import('../features/agents/AgentsPage'), 'AgentsPage');
const OverviewPage = named(() => import('../features/agents/overview/OverviewPage'), 'OverviewPage');
const KnowledgePage = named(() => import('../features/agents/knowledge/KnowledgePage'), 'KnowledgePage');
const ExperiencePage = named(() => import('../features/agents/experience/ExperiencePage'), 'ExperiencePage');
const ChannelsPage = named(() => import('../features/agents/channels/ChannelsPage'), 'ChannelsPage');
const QuotationPage = named(() => import('../features/agents/quotation/QuotationPage'), 'QuotationPage');
const QualificationPage = named(() => import('../features/agents/advanced/QualificationPage'), 'QualificationPage');
const BehaviourPage = named(() => import('../features/agents/advanced/BehaviourPage'), 'BehaviourPage');
const InboxPage = named(() => import('../features/inbox/InboxPage'), 'InboxPage');
const LeadsPage = named(() => import('../features/leads/LeadsPage'), 'LeadsPage');
const AnalyticsPage = named(() => import('../features/analytics/AnalyticsPage'), 'AnalyticsPage');
const JourneyPage = named(() => import('../features/analytics/JourneyPage'), 'JourneyPage');
const WorkspaceLayout = named(() => import('../features/workspace/WorkspaceLayout'), 'WorkspaceLayout');
const GeneralPage = named(() => import('../features/workspace/GeneralPage'), 'GeneralPage');
const MembersPage = named(() => import('../features/workspace/MembersPage'), 'MembersPage');
const BillingPage = named(() => import('../features/workspace/BillingPage'), 'BillingPage');
const UsagePage = named(() => import('../features/workspace/UsagePage'), 'UsagePage');
const ReportsPage = named(() => import('../features/workspace/ReportsPage'), 'ReportsPage');
const ApiKeysPage = named(() => import('../features/workspace/ApiKeysPage'), 'ApiKeysPage');
const IntegrationsPage = named(() => import('../features/workspace/IntegrationsPage'), 'IntegrationsPage');
const AffiliatePage = named(() => import('../features/affiliate/AffiliatePage'), 'AffiliatePage');
const AffiliateInvite = named(() => import('../features/affiliate/AffiliateInvite'), 'AffiliateInvite');
const InviteAirlock = named(() => import('../features/workspace/InviteAirlock'), 'InviteAirlock');
const SettingsPage = named(() => import('../features/settings'), 'SettingsPage');
const SetupPage = named(() => import('../onboarding/SetupPage'), 'SetupPage');
const FirstRunPage = named(() => import('../onboarding/FirstRunPage'), 'FirstRunPage');
const UiGallery = named(() => import('../dev/UiGallery'), 'UiGallery');

/**
 * What a split route shows while its chunk arrives.
 *
 * A spinner and nothing else, deliberately: a skeleton here would be a guess at
 * a layout the chunk has not described yet, and guessing wrong costs a layout
 * jump on every navigation.
 */
function Route({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-64 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

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
          <Route>
            <UiGallery />
          </Route>
        ),
      },

      // ── Public ────────────────────────────────────────────────────────────
      { path: '/login', element: <Login /> },
      { path: '/register', element: <Route><Register /></Route> },
      { path: '/verify-email', element: <Route><VerifyEmail /></Route> },
      { path: '/forgot-password', element: <Route><ForgotPassword /></Route> },
      { path: '/auth/callback', element: <Route><OAuthCallback /></Route> },
      { path: '/affiliate-invite', element: <Route><AffiliateInvite /></Route> },
      // The team-invite airlock resolves a magic link and routes on auth state,
      // so it must stay outside the guard: the invited visitor is usually
      // signed out when they land.
      { path: '/invite/:token', element: <Route><InviteAirlock /></Route> },

      // ── Authenticated ─────────────────────────────────────────────────────
      {
        element: <ProtectedLayout />,
        children: [
          {
            path: '/',
            element: <AppShell />,
            // Shell or provider crash: full-screen, because there is no rail
            // left to render into. The outer registration on the root route
            // object catches what fails above this one.
            errorElement: <RootErrorBoundary />,
            children: [
              {
                errorElement: <PageErrorBoundary />,
                element: <OperatorRouteGuard />,
                children: [
                  { index: true, element: <Route><HomePage /></Route> },
                  { path: 'setup', element: <Route><SetupPage /></Route> },

                  // First run. Inside the shell, deliberately: the wizard this
                  // replaces lived outside it, so a customer could hand over a
                  // card on a screen structurally incapable of telling them
                  // their last payment had failed.
                  { path: 'welcome', element: <Route><FirstRunPage /></Route> },

                  // ── Chatbots ────────────────────────────────────────────
                  {
                    path: 'chatbots',
                    children: [
                      { index: true, element: <Route><AgentsPage /></Route> },
                      {
                        path: ':agentId',
                        element: <AgentScope />,
                        children: [
                          { index: true, element: <Navigate to="overview" replace /> },
                          { path: 'overview', element: <Route><OverviewPage /></Route> },
                          { path: 'knowledge', element: <Route><KnowledgePage /></Route> },
                          { path: 'experience', element: <Route><ExperiencePage /></Route> },
                          { path: 'deploy', element: <Route><ChannelsPage /></Route> },
                          // Qualification is promoted out of the technical tab:
                          // it is a revenue surface, not a configuration corner.
                          { path: 'qualification', element: <Route><QualificationPage /></Route> },
                          // Quotation is a revenue surface too, and sits beside
                          // Qualification for the same reason it was promoted
                          // out of the technical tab.
                          { path: 'quotation', element: <Route><QuotationPage /></Route> },
                          { path: 'behaviour', element: <Route><BehaviourPage /></Route> },
                        ],
                      },
                    ],
                  },

                  // ── Operations ──────────────────────────────────────────
                  { path: 'inbox', element: <Route><InboxPage /></Route> },
                  { path: 'leads', element: <Route><LeadsPage /></Route> },
                  // Its own top-level page and its own single lazy chunk — not
                  // nested under Analytics. It sat at `/analytics/journey` for a
                  // while; see `REBUILD.md`'s Consolidations table for the full
                  // history of why it moved there and why it moved back.
                  { path: 'journey', element: <Route><JourneyPage /></Route> },
                  // A splat, because Analytics owns its own views — the same
                  // shape `platformRoutes` gives the super-admin record lists.
                  { path: 'analytics/*', element: <Route><AnalyticsPage /></Route> },

                  // ── Billing ─────────────────────────────────────────────
                  { path: 'billing', element: <Route><BillingPage /></Route> },
                  { path: 'billing/usage', element: <Route><UsagePage /></Route> },
                  { path: 'billing/reports', element: <Route><ReportsPage /></Route> },

                  // ── Settings ────────────────────────────────────────────
                  {
                    path: 'settings',
                    element: <Route><WorkspaceLayout /></Route>,
                    children: [
                      { index: true, element: <Navigate to="workspace" replace /> },
                      { path: 'workspace', element: <Route><GeneralPage /></Route> },
                      { path: 'team', element: <Route><MembersPage /></Route> },
                      { path: 'integrations', element: <Route><IntegrationsPage /></Route> },
                      { path: 'developers', element: <Route><ApiKeysPage /></Route> },
                      { path: 'affiliate', element: <Route><AffiliatePage /></Route> },
                    ],
                  },

                  // Your own account, distinct from the workspace's settings.
                  { path: 'account', element: <Route><SettingsPage /></Route> },

                  // ── Moved ───────────────────────────────────────────────
                  // Declared as data in `redirects.ts`. Twenty-five lines of
                  // this router were a rename table, and it was going to keep
                  // growing.
                  ...LEGACY_AGENT_SEGMENTS.map(([from, segment]) => ({
                    path: from,
                    element: <MovedAgent segment={segment} />,
                  })),
                  ...LEGACY_PATHS.map(([from, to]) => ({
                    path: from,
                    element: <Moved to={to} />,
                  })),

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
