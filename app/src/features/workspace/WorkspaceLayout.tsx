import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, Handshake, Lock, Plug, Terminal, Users, type LucideIcon } from 'lucide-react';
import { Page, PageHeader, SidebarLayout, cn } from '../../ui';
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
 * **The page title is rendered here, not by the routed child.** The nav used to
 * be the first flex child of the `Page`, so every child rendered its own
 * `PageHeader` inside the right-hand column and the settings `h1` landed 288px
 * from the page gutter while `/billing`'s sat at 32 — three left edges for one
 * page title, which reads as a rendering fault rather than a decision. The
 * layout owns the header and the children own their content.
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
  const location = useLocation();

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

  const active = sections.find((section) => location.pathname.startsWith(section.to));

  return (
    <Page>
      <PageHeader eyebrow="Settings" title={active?.label ?? 'Settings'} />
      <SidebarLayout
        navLabel="Settings sections"
        navWidth="sm"
        nav={sections.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            className={({ isActive }) =>
              cn(
                'flex h-control-lg items-center gap-2.5 rounded-md px-3 text-base',
                'transition-colors duration-[var(--dur-fast)]',
                isActive
                  ? // The same marker the rail uses, rotated nowhere: a 2px ink
                    // leading rule. A filled blue pill would be a second
                    // active-nav language one click away from `/billing`'s
                    // underline, and `--color-accent-50` is a selected *row*.
                    'bg-surface-active font-medium text-text-primary shadow-[inset_2px_0_0_var(--color-ink)]'
                  : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
              )
            }
          >
            {({ isActive }) => (
              <>
                <section.icon
                  aria-hidden
                  className={cn(
                    'h-icon-sm w-icon-sm shrink-0',
                    isActive ? 'text-text-primary' : 'text-text-tertiary',
                  )}
                />
                <span className="whitespace-nowrap">{section.label}</span>
                {section.locked ? (
                  // `lg:ml-auto` only: in the horizontal scroller `ml-auto`
                  // pinned the lock to the right edge of its own item, so
                  // "Team 🔒" read as "Team … 🔒" with a variable gap.
                  <span className="flex items-center @4xl/page:ml-auto">
                    <Lock aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
                    <span className="sr-only">— not included on your plan</span>
                  </span>
                ) : null}
              </>
            )}
          </NavLink>
        ))}
      >
        <Outlet />
      </SidebarLayout>
    </Page>
  );
}
