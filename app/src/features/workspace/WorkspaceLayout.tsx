import { type ReactElement, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../../design-system';
import { getCurrentUser } from '../../services/api';

interface WorkspaceSection {
  /** URL segment under `/workspace/`. */
  readonly path: string;
  /** Human label shown in the section nav. */
  readonly label: string;
}

/**
 * The workspace-level sections, in mandate order. Each links to
 * `/workspace/<path>`; the router mounts a child route per section. These are
 * workspace-wide settings only — never agent configuration.
 *
 * Affiliate is inserted only for enrolled affiliates (see below) — the program
 * is invite-only, so the tab would be a dead end for everyone else.
 */
const WORKSPACE_SECTIONS: readonly WorkspaceSection[] = [
  { path: 'members', label: 'Members' },
  { path: 'billing', label: 'Billing' },
  { path: 'usage', label: 'Usage' },
  { path: 'security', label: 'Security' },
  { path: 'api-keys', label: 'API Keys' },
  { path: 'integrations', label: 'Integrations' },
  { path: 'settings', label: 'Settings' },
];

const AFFILIATE_SECTION: WorkspaceSection = { path: 'affiliate', label: 'Affiliate' };

/**
 * WorkspaceLayout — parent route element for `/workspace/*`. Adds the section
 * navigation the Workspace area was missing, so Members, Billing, Usage,
 * Security, API Keys, Integrations, and Settings are all reachable by clicking
 * (previously only Members rendered; the rest were URL-only).
 *
 * Kept deliberately minimal: the app breadcrumb already reads "Workspace" and
 * each section page renders its own title, so this layout is just the tab row —
 * no redundant identity header. The tab row and the content below both align to
 * the standard page measure (matching PageContainer); AppShell's <main> supplies
 * the outer padding.
 */
export function WorkspaceLayout(): ReactElement {
  // The Affiliate section is invite-only, so it's shown only once /auth/me
  // confirms the client is an enrolled affiliate. Inserted before Settings to
  // keep Settings last. A failed lookup simply omits it (fail-closed).
  const [isAffiliate, setIsAffiliate] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (!cancelled) setIsAffiliate(user?.is_affiliate === true);
      })
      .catch(() => {
        /* keep the section hidden on failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections: readonly WorkspaceSection[] = isAffiliate
    ? [...WORKSPACE_SECTIONS.slice(0, -1), AFFILIATE_SECTION, WORKSPACE_SECTIONS[WORKSPACE_SECTIONS.length - 1]]
    : WORKSPACE_SECTIONS;

  return (
    <div className="flex min-h-full flex-col">
      {/* Section nav — real nav semantics; NavLink stamps aria-current on the
          active section. Horizontally scrollable so all fit on mobile. */}
      <nav
        aria-label="Workspace sections"
        className="mx-auto w-full max-w-7xl overflow-x-auto border-b border-[var(--ds-border)]"
      >
        <ul className="-mb-px flex min-w-max items-center gap-1">
          {sections.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                    isActive
                      ? 'border-[var(--ds-accent)] text-[var(--ds-text)]'
                      : 'border-transparent text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                  )
                }
              >
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Active section — the gap below the tab row keeps the page title from
          crowding the divider. Page content supplies its own max-width. */}
      <div className="pt-8">
        <Outlet />
      </div>
    </div>
  );
}
