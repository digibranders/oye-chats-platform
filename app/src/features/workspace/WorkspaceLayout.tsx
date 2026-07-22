import { type ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../../design-system';

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
 */
const WORKSPACE_SECTIONS: readonly WorkspaceSection[] = [
  { path: 'members', label: 'Members' },
  { path: 'billing', label: 'Billing' },
  { path: 'usage', label: 'Usage' },
  { path: 'security', label: 'Security' },
  { path: 'api-keys', label: 'API Keys' },
  { path: 'integrations', label: 'Integrations' },
];

/**
 * WorkspaceLayout — parent route element for `/workspace/*`. Adds the section
 * navigation the Workspace area was missing, so Members, Billing, Usage,
 * Security, API Keys, and Integrations are all reachable by clicking
 * (previously only Members rendered; the rest were URL-only). Settings moved
 * out to the top-level `/settings` page — see the bottom-anchored secondary
 * nav — since it covers account/profile, not workspace-admin, concerns.
 *
 * Kept deliberately minimal: the app breadcrumb already reads "Workspace" and
 * each section page renders its own title, so this layout is just the tab row —
 * no redundant identity header. The tab row and the content below both align to
 * the standard page measure (matching PageContainer); AppShell's <main> supplies
 * the outer padding.
 */
export function WorkspaceLayout(): ReactElement {
  return (
    <div className="flex min-h-full flex-col">
      {/* Section nav — real nav semantics; NavLink stamps aria-current on the
          active section. Horizontally scrollable so all six fit on mobile. */}
      <nav
        aria-label="Workspace sections"
        className="mx-auto w-full max-w-7xl overflow-x-auto border-b border-[var(--ds-border)]"
      >
        <ul className="-mb-px flex min-w-max items-center gap-1">
          {WORKSPACE_SECTIONS.map((section) => (
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
