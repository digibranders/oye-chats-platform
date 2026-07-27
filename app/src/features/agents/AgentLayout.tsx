import { type ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Bot as BotIcon } from 'lucide-react';
import { AgentProvider, useAgent } from '../../context/AgentContext';
import { Skeleton, cn } from '../../design-system';

interface AgentTab {
  /** URL segment under `/agents/:agentId/`. */
  readonly path: string;
  /** Human label shown in the tab. */
  readonly label: string;
}

/**
 * The six canonical agent tabs, in mandate order. Each links to
 * `/agents/:agentId/<path>`; the orchestrator mounts a child route per tab.
 */
const AGENT_TABS: readonly AgentTab[] = [
  { path: 'overview', label: 'Overview' },
  { path: 'knowledge', label: 'Knowledge' },
  { path: 'experience', label: 'Experience' },
  { path: 'channels', label: 'Channels' },
  { path: 'analytics', label: 'Analytics' },
  { path: 'advanced', label: 'Advanced' },
];

/**
 * AgentShell — the per-agent chrome (rendered inside <AgentProvider>). A header
 * naming the active agent, a horizontal tab row that routes to each section,
 * and an <Outlet/> for the active tab. Kept presentational: all data resolution
 * lives in AgentContext.
 */
function AgentShell(): ReactElement {
  const { agent, agentId, loading, error } = useAgent();

  return (
    <div className="flex min-h-full flex-col bg-[var(--ds-bg-canvas)] text-[var(--ds-text)]">
      {/* Header — who am I configuring? */}
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

        {/* Tab row — real nav semantics so screen readers announce the section
            list; NavLink stamps aria-current="page" on the active tab. */}
        <nav aria-label="Agent sections" className="mt-5 -mb-px overflow-x-auto">
          <ul className="flex min-w-max items-center gap-1">
            {AGENT_TABS.map((tab) => (
              <li key={tab.path}>
                <NavLink
                  to={agentId ? `/agents/${agentId}/${tab.path}` : '.'}
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
                  {tab.label}
                </NavLink>
              </li>
            ))}
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
 * AgentLayout — parent route element for `/agents/:agentId`. Wraps the shell in
 * <AgentProvider> so every tab child (via <Outlet/>) can call useAgent().
 */
export function AgentLayout(): ReactElement {
  return (
    <AgentProvider>
      <AgentShell />
    </AgentProvider>
  );
}
