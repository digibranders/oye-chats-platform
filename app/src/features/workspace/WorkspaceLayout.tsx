import { type ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Building2 } from 'lucide-react';
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
  { path: 'settings', label: 'Settings' },
];

/**
 * WorkspaceLayout — parent route element for `/workspace/*`. Provides the header
 * and the section navigation that the Workspace area was missing, so Members,
 * Billing, Usage, Security, API Keys, Integrations, and Settings are all
 * reachable by clicking (previously only Members rendered and the rest were
 * URL-only). Mirrors the agent-tab pattern for consistency; the active section
 * renders through <Outlet/>.
 */
export function WorkspaceLayout(): ReactElement {
  return (
    <div className="flex min-h-full flex-col bg-[var(--ds-bg-canvas)] text-[var(--ds-text)]">
      <header className="border-b border-[var(--ds-border)] px-4 pt-6 md:px-8">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]"
            aria-hidden="true"
          >
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-[var(--ds-text)]">Workspace</h1>
            <p className="text-[13px] text-[var(--ds-text-subtle)]">
              Members, billing, and workspace-wide settings.
            </p>
          </div>
        </div>

        {/* Section nav — real nav semantics; NavLink stamps aria-current on the
            active section. Horizontally scrollable so all seven fit on mobile. */}
        <nav aria-label="Workspace sections" className="mt-5 -mb-px overflow-x-auto">
          <ul className="flex min-w-max items-center gap-1">
            {WORKSPACE_SECTIONS.map((section) => (
              <li key={section.path}>
                <NavLink
                  to={section.path}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex items-center whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-bg-canvas)]',
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
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
