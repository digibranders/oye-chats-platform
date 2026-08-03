import { type ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Bot as BotIcon, Lock } from 'lucide-react';
import { AgentProvider, useAgent } from '../../context/AgentContext';
import { Skeleton, cn } from '../../design-system';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import type { UpgradeIntentKey } from '../../context/upgradeIntents';

interface AgentTab {
  /** URL segment under `/agents/:agentId/`. */
  readonly path: string;
  /** Human label shown in the tab. */
  readonly label: string;
  /**
   * When set, Free-plan workspaces see this tab locked: it renders as a
   * lock affordance that opens the upgrade modal (with this intent's copy)
   * instead of routing. Paid plans see a normal tab. The destination route
   * is guarded independently, so a direct URL hit is also caught.
   */
  readonly gateIntent?: UpgradeIntentKey;
}

/**
 * The canonical agent tabs, in mandate order. Each links to
 * `/agents/:agentId/<path>`; the orchestrator mounts a child route per tab.
 * (Per-agent performance lives on the workspace Analytics page, which is
 * already agent-scoped, so a separate per-agent Analytics tab is redundant.)
 *
 * Advanced bundles the power-user knobs (qualification, widget behaviour,
 * timing, developer access) - all paid features - so it's Free-plan-gated as
 * a whole via `gateIntent: 'advanced_settings'`.
 */
const AGENT_TABS: readonly AgentTab[] = [
  { path: 'overview', label: 'Overview' },
  { path: 'knowledge', label: 'Knowledge' },
  { path: 'experience', label: 'Experience' },
  { path: 'channels', label: 'Channels' },
  { path: 'advanced', label: 'Advanced', gateIntent: 'advanced_settings' },
];

/** Shared tab-row geometry so the locked button lines up pixel-for-pixel with
 * the routing `NavLink` tabs (same height, padding, and border rail). */
const TAB_BASE_CLASS =
  'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]';

interface LockedTabProps {
  label: string;
  onClick: () => void;
}

/**
 * LockedTab - the Free-plan stand-in for a gated agent tab. A `<button>`
 * (never a `NavLink`, since it must not navigate) styled like an inactive tab,
 * with a trailing lock glyph. Clicking opens the upgrade modal.
 */
function LockedTab({ label, onClick }: LockedTabProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} — upgrade to unlock`}
      className={cn(
        TAB_BASE_CLASS,
        'border-transparent text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
      )}
    >
      {label}
      <Lock size={12} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
    </button>
  );
}

/**
 * AgentShell - the per-agent chrome (rendered inside <AgentProvider>). A header
 * naming the active agent, a horizontal tab row that routes to each section,
 * and an <Outlet/> for the active tab. Kept presentational: all data resolution
 * lives in AgentContext.
 */
function AgentShell(): ReactElement {
  const { agent, agentId, loading, error } = useAgent();
  // Free-plan tab gating. `loading` guards the initial entitlements fetch (which
  // defaults to the restrictive Free fallback) so a paid workspace never flashes
  // a locked tab before its real plan resolves.
  const { isFree, loading: entitlementsLoading } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();

  return (
    <div className="flex min-h-full flex-col bg-[var(--ds-bg-canvas)] text-[var(--ds-text)]">
      {/* Header - who am I configuring? */}
      <header className="border-b border-[var(--ds-border)] pt-2">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]"
            aria-hidden="true"
          >
            <BotIcon size={18} />
          </div>
          {loading && !agent ? (
            <Skeleton className="h-6 w-40" />
          ) : agent ? (
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold tracking-tight text-[var(--ds-text)]">
                {agent.name}
              </h1>
              {agent.website ? (
                <p className="truncate text-[13px] text-[var(--ds-text-subtle)]">{agent.website}</p>
              ) : null}
            </div>
          ) : (
            <h1 className="text-lg font-bold tracking-tight text-[var(--ds-text)]">
              {error ? 'Couldn’t load this agent' : 'Agent not found'}
            </h1>
          )}
        </div>

        {/* Tab row - real nav semantics so screen readers announce the section
            list; NavLink stamps aria-current="page" on the active tab. */}
        <nav aria-label="Agent sections" className="mt-5 -mb-px overflow-x-auto">
          <ul className="flex min-w-max items-center gap-1">
            {AGENT_TABS.map((tab) => {
              const locked =
                tab.gateIntent !== undefined && !entitlementsLoading && isFree;
              return (
                <li key={tab.path}>
                  {locked ? (
                    <LockedTab
                      label={tab.label}
                      onClick={() => openUpgradeModal(tab.gateIntent!)}
                    />
                  ) : (
                    <NavLink
                      to={agentId ? `/agents/${agentId}/${tab.path}` : '.'}
                      className={({ isActive }) =>
                        cn(
                          TAB_BASE_CLASS,
                          isActive
                            ? 'border-[var(--ds-accent)] text-[var(--ds-text)]'
                            : 'border-transparent text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                        )
                      }
                    >
                      {tab.label}
                    </NavLink>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      {/* Active tab */}
      <main className="flex-1 pt-4">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * AgentLayout - parent route element for `/agents/:agentId`. Wraps the shell in
 * <AgentProvider> so every tab child (via <Outlet/>) can call useAgent().
 */
export function AgentLayout(): ReactElement {
  return (
    <AgentProvider>
      <AgentShell />
    </AgentProvider>
  );
}
