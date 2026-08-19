import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, Handshake, Lock, Plug, Terminal, Users, type LucideIcon } from 'lucide-react';
import { Page, cn } from '../../ui';
import { getCurrentUser } from '../../services/api';
import { keys } from '../../query/keys';
import { useEntitlements } from '../../hooks/useEntitlements';

/**
 * Settings — one home, with a secondary column.
 *
 * The console this replaces had eight workspace tabs, each of which opened its
 * own second-level strip, plus a *separate* top-level "Settings" page for the
 * personal account. Three levels of navigation, none of them in the URL, and
 * two different pages called settings. This is the one home the mandate asks
 * for: workspace-level configuration in a single column, with the personal
 * account deliberately outside it at `/account`, reached from the account menu.
 *
 * Billing is not here on purpose. Running out of credits stops the chatbot
 * answering customers, which is an outage rather than a preference, so it is a
 * top-level destination in the rail (see `shell/nav.ts`).
 *
 * A section the plan does not include is still a **link**, never a button that
 * opens a modal. Middle-click, copy-link and `aria-current` all matter, and the
 * page behind it renders the locked state with a preview of what is being sold
 * — which is a better upgrade argument than a dialog that appears where the
 * user expected navigation.
 */

interface SettingsSection {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Rendered with a lock affordance when the workspace's plan excludes it. */
  locked?: boolean;
}

export function WorkspaceLayout() {
  const { isFree, hasFeature } = useEntitlements();

  // Fail closed: the Affiliate section is invite-only, so it appears only once
  // `/auth/me` positively confirms enrolment. An errored or pending query keeps
  // it hidden rather than showing a link that 403s.
  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const sections: SettingsSection[] = [
    {
      to: '/settings/workspace',
      label: 'Workspace',
      icon: Building2,
    },
    {
      to: '/settings/team',
      label: 'Team',
      icon: Users,
      locked: isFree,
    },
    {
      to: '/settings/integrations',
      label: 'Integrations',
      icon: Plug,
      locked: !hasFeature('webhooks'),
    },
    {
      to: '/settings/developers',
      label: 'Developers',
      icon: Terminal,
    },
  ];

  if (me.data?.is_affiliate === true) {
    sections.push({
      to: '/settings/affiliate',
      label: 'Affiliate',
      icon: Handshake,
    });
  }

  return (
    <Page width="wide" className="lg:flex lg:gap-8">
      {/* `lg:w-56` rather than a flex basis: the column holds five fixed labels,
          so letting it size to content makes it jump as sections appear. */}
      <nav
        aria-label="Settings sections"
        className="mb-6 shrink-0 lg:mb-0 lg:w-56 lg:self-start"
      >
        <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {sections.map((section) => (
            <li key={section.to} className="shrink-0 lg:shrink">
              <NavLink
                to={section.to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-base transition-colors',
                    'duration-[var(--dur-fast)]',
                    isActive
                      ? 'bg-accent-50 font-medium text-accent-700'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <section.icon
                      aria-hidden
                      className={cn(
                        'h-4 w-4 shrink-0',
                        isActive ? 'text-accent-600' : 'text-text-tertiary',
                      )}
                    />
                    <span className="whitespace-nowrap lg:whitespace-normal">{section.label}</span>
                    {section.locked ? (
                      <span className="ml-auto flex items-center">
                        <Lock aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
                        <span className="sr-only">— not included on your plan</span>
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Reading width, not the full flex row: a settings form stretched to
          1,200px puts a label and its control a screen apart. Tables that need
          more scroll inside their own card instead.

          `min-w-0` so that scroll actually happens — without it a wide table
          stretches the flex row and pushes the nav column off-screen. */}
      <div className="min-w-0 flex-1 lg:max-w-reading">
        <Outlet />
      </div>
    </Page>
  );
}
