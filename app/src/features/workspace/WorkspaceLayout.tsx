import { type ReactElement, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { cn } from '../../design-system';
import { getCurrentUser } from '../../services/api';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import type { UpgradeIntentKey } from '../../context/upgradeIntents';

interface WorkspaceSection {
  /** URL segment under `/workspace/`. */
  readonly path: string;
  /** Human label shown in the section nav. */
  readonly label: string;
  /** Present only on Free-plan-gated sections (backend `plan_entitlements_service.py`:
   *  Free's `operators` seat ceiling is 0 and `integrations` is `reply_to_only`).
   *  When set, a Free workspace renders this tab as a locked button that opens
   *  the upgrade modal with this intent instead of navigating. */
  readonly lockIntent?: UpgradeIntentKey;
}

/**
 * The workspace-level sections, in mandate order. Each links to
 * `/workspace/<path>`; the router mounts a child route per section. These are
 * workspace-wide settings only - never agent configuration. Billing is
 * deliberately never gated - it's how a Free workspace upgrades in the first
 * place.
 */
const WORKSPACE_SECTIONS: readonly WorkspaceSection[] = [
  { path: 'general', label: 'General' },
  { path: 'members', label: 'Members', lockIntent: 'view_team' },
  { path: 'billing', label: 'Billing' },
  { path: 'usage', label: 'Usage' },
  // Directly after Usage on purpose: Usage answers "how much did the workspace
  // consume", Reports answers the same question broken out per agent and made
  // exportable - the view an agency hands to each of its own clients.
  { path: 'reports', label: 'Reports' },
  { path: 'api-keys', label: 'API Keys' },
  { path: 'integrations', label: 'Integrations', lockIntent: 'view_integrations' },
];

/** Shown only to enrolled affiliates (invite-only program) - appended last. */
const AFFILIATE_SECTION: WorkspaceSection = { path: 'affiliate', label: 'Affiliate' };

/**
 * WorkspaceLayout - parent route element for `/workspace/*`. Adds the section
 * navigation the Workspace area was missing, so General, Members, Billing,
 * Usage, Security, API Keys, and Integrations are all reachable by clicking
 * (previously only Members rendered; the rest were URL-only). The top-level
 * `/settings` page is account/profile-only (your name, appearance, sign-in
 * security) - General is the org-level counterpart: workspace identity
 * (company, website, agent count) and agent-wide defaults, which never
 * belonged on a personal Settings page.
 *
 * Kept deliberately minimal: the app breadcrumb already reads "Workspace" and
 * each section page renders its own title, so this layout is just the tab row -
 * no redundant identity header. The tab row and the content below both align to
 * the standard page measure (matching PageContainer); AppShell's <main> supplies
 * the outer padding.
 *
 * On a Free-plan workspace, the Members and Integrations tabs render as
 * `<button>`s (never `<NavLink>`s) that open the upgrade modal instead of
 * navigating - everything else, especially Billing, stays fully clickable.
 *
 * The Affiliate tab is invite-only, so it's appended only once `/auth/me`
 * confirms the client is an enrolled affiliate (fail-closed on error).
 */
export function WorkspaceLayout(): ReactElement {
  const { isFree } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();

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
    ? [...WORKSPACE_SECTIONS, AFFILIATE_SECTION]
    : WORKSPACE_SECTIONS;

  return (
    <div className="flex min-h-full flex-col">
      {/* Section nav - real nav semantics; NavLink stamps aria-current on the
          active section. Horizontally scrollable so all fit on mobile.
          The divider lives on the wrapper and `-mb-px` on the scroll container
          itself (never on a child): `overflow-x-auto` forces overflow-y to
          compute to `auto`, so a negative margin inside the scroller would
          leave 1px of vertical overflow and render a stray scrollbar. */}
      <div className="mx-auto w-full max-w-7xl border-b border-[var(--ds-border)]">
        <nav aria-label="Workspace sections" className="-mb-px overflow-x-auto">
          <ul className="flex min-w-max items-center gap-1">
            {sections.map((section) => {
              const lockIntent = isFree ? section.lockIntent : undefined;
              return (
                <li key={section.path}>
                  {lockIntent ? (
                    <button
                      type="button"
                      onClick={() => openUpgradeModal(lockIntent)}
                      className={cn(
                        'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)]',
                        'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                      )}
                    >
                      {section.label}
                      <Lock size={12} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                    </button>
                  ) : (
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
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {/* Active section - the gap below the tab row keeps the page title from
          crowding the divider. Page content supplies its own max-width. */}
      <div className="pt-4">
        <Outlet />
      </div>
    </div>
  );
}
