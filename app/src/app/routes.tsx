import { createBrowserRouter, Navigate } from 'react-router-dom';
import {
  Home,
  Bot,
  Inbox,
  Users,
  BarChart3,
  BookOpen,
  Palette,
  Radio,
  SlidersHorizontal,
  LayoutDashboard,
  CreditCard,
  Gauge,
  ShieldCheck,
  KeyRound,
  Plug,
  Settings2,
  UsersRound,
} from 'lucide-react';
import { AppShell } from '../shell/AppShell';
import { PagePlaceholder } from './PagePlaceholder';
import { LaunchStudio } from '../features/launch-studio/LaunchStudio';

/**
 * Route Architecture — the Admin Platform 2.0 information architecture.
 *
 * Two things make this the backbone of the rebuild:
 *   1. The AI Agent is a first-class URL object: `/agents/:agentId/<tab>`,
 *      where the six tabs (overview/knowledge/experience/channels/analytics/
 *      advanced) each answer exactly one question. (Agent scoping decision #1.)
 *   2. Launch Studio is a full-screen route OUTSIDE the shell — temporary
 *      onboarding, never navigation.
 *
 * Phase 1 wires the full tree with placeholder pages so the IA, breadcrumbs,
 * and active-state are all verifiable before any page is built.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    handle: { crumb: 'Home' },
    children: [
      {
        index: true,
        element: (
          <PagePlaceholder
            title="Home"
            description="Your daily operational overview."
            phase={3}
            icon={Home}
          />
        ),
      },

      // ── AI Agents ──────────────────────────────────────────────
      {
        path: 'agents',
        handle: { crumb: 'AI Agents' },
        children: [
          {
            index: true,
            element: (
              <PagePlaceholder
                title="AI Agents"
                description="Create, train and manage your AI agents."
                phase={4}
                icon={Bot}
              />
            ),
          },
          {
            path: ':agentId',
            handle: { crumb: 'Agent' },
            children: [
              { index: true, element: <Navigate to="overview" replace /> },
              {
                path: 'overview',
                handle: { crumb: 'Overview' },
                element: <PagePlaceholder title="Overview" description="Is my AI healthy?" phase={4} icon={LayoutDashboard} />,
              },
              {
                path: 'knowledge',
                handle: { crumb: 'Knowledge' },
                element: <PagePlaceholder title="Knowledge" description="What does my AI know?" phase={4} icon={BookOpen} />,
              },
              {
                path: 'experience',
                handle: { crumb: 'Experience' },
                element: <PagePlaceholder title="Experience" description="What will visitors see?" phase={4} icon={Palette} />,
              },
              {
                path: 'channels',
                handle: { crumb: 'Channels' },
                element: <PagePlaceholder title="Channels" description="Where is my AI connected?" phase={4} icon={Radio} />,
              },
              {
                path: 'analytics',
                handle: { crumb: 'Analytics' },
                element: <PagePlaceholder title="Agent Analytics" description="How is my AI performing?" phase={4} icon={BarChart3} />,
              },
              {
                path: 'advanced',
                handle: { crumb: 'Advanced' },
                element: <PagePlaceholder title="Advanced" description="How do I configure technical behaviour?" phase={4} icon={SlidersHorizontal} />,
              },
            ],
          },
        ],
      },

      // ── Operations ─────────────────────────────────────────────
      {
        path: 'inbox',
        handle: { crumb: 'Inbox' },
        element: <PagePlaceholder title="Inbox" description="Live chat and visitor messages." phase={5} icon={Inbox} />,
      },
      {
        path: 'leads',
        handle: { crumb: 'Leads' },
        element: <PagePlaceholder title="Leads" description="Captured leads and qualification." phase={5} icon={Users} />,
      },
      {
        path: 'analytics',
        handle: { crumb: 'Analytics' },
        element: <PagePlaceholder title="Analytics" description="Performance across all agents." phase={5} icon={BarChart3} />,
      },

      // ── Workspace ──────────────────────────────────────────────
      {
        path: 'workspace',
        handle: { crumb: 'Workspace' },
        children: [
          { index: true, element: <Navigate to="members" replace /> },
          {
            path: 'members',
            handle: { crumb: 'Members' },
            element: <PagePlaceholder title="Members" description="Your team and their roles." phase={5} icon={UsersRound} />,
          },
          {
            path: 'billing',
            handle: { crumb: 'Billing' },
            element: <PagePlaceholder title="Billing" description="Plan, seats and invoices." phase={5} icon={CreditCard} />,
          },
          {
            path: 'usage',
            handle: { crumb: 'Usage' },
            element: <PagePlaceholder title="Usage" description="Credits and consumption." phase={5} icon={Gauge} />,
          },
          {
            path: 'security',
            handle: { crumb: 'Security' },
            element: <PagePlaceholder title="Security" description="Password, sessions and access." phase={5} icon={ShieldCheck} />,
          },
          {
            path: 'api-keys',
            handle: { crumb: 'API Keys' },
            element: <PagePlaceholder title="API Keys" description="Programmatic access to your workspace." phase={5} icon={KeyRound} />,
          },
          {
            path: 'integrations',
            handle: { crumb: 'Integrations' },
            element: <PagePlaceholder title="Integrations" description="Webhooks, meetings and email routing." phase={5} icon={Plug} />,
          },
          {
            path: 'settings',
            handle: { crumb: 'Settings' },
            element: <PagePlaceholder title="Workspace Settings" description="Workspace name, defaults and branding." phase={5} icon={Settings2} />,
          },
        ],
      },
    ],
  },

  // Launch Studio — full-screen 8-step onboarding, OUTSIDE the app shell.
  {
    path: '/launch',
    children: [
      { index: true, element: <Navigate to="connect" replace /> },
      { path: ':step', element: <LaunchStudio /> },
    ],
  },

  // Unknown routes fall back to Home.
  { path: '*', element: <Navigate to="/" replace /> },
]);
