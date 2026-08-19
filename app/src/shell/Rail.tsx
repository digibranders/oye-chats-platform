import { useMemo, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronsUpDown, Plus } from 'lucide-react';
import { cn, Tooltip, Badge } from '../ui';
import { agentHealth } from '../features/home/agentHealth';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBotContext } from '../context/BotContext';
import {
  AGENT_NAV,
  FOOTER_NAV,
  WORKSPACE_NAV,
  agentIdFromPath,
  agentPath,
  navForRole,
  type NavItem,
} from './nav';
import { OyeChatsMark } from './OyeChatsMark';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { AgentSwitcher } from './AgentSwitcher';
import { SetupProgress } from './SetupProgress';
import { AccountMenu } from './AccountMenu';

/**
 * The navigation rail.
 *
 * Ink, not paper. It is not a dark theme — it is a dark chrome element, the way
 * Intercom, Superhuman and Height all treat their rails. Two things follow from
 * it: the product has a silhouette recognisable at thumbnail size, and the rail
 * stops competing with the content for the same three near-whites, which is what
 * made the previous shell's four off-whites indistinguishable on an ordinary
 * monitor.
 *
 * It has two states, never a tree. In workspace scope it lists six
 * destinations. Inside a chatbot it swaps to that chatbot's six, with a
 * permanent way back. See `nav.ts` for why.
 */

function RailLink({
  to,
  label,
  icon: Icon,
  end,
  collapsed,
  badge,
  onNavigate,
}: NavItem & { collapsed: boolean; badge?: ReactNode; onNavigate?: () => void }) {
  return (
    <Tooltip content={label} side="right" disabled={!collapsed}>
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium',
            'transition-colors duration-[var(--dur-fast)]',
            collapsed && 'justify-center px-0',
            isActive
              ? 'bg-rail-active text-rail-text'
              : 'text-rail-text-muted hover:bg-rail-hover hover:text-rail-text',
          )
        }
      >
        {({ isActive }) => (
          <>
            {/* The active marker is a rule on the rail's own edge rather than a
                full-width fill, so scanning the rail vertically reads as one
                list with one mark in it. */}
            <span
              aria-hidden
              className={cn(
                'absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-rail-accent',
                'transition-opacity duration-[var(--dur-fast)]',
                isActive ? 'opacity-100' : 'opacity-0',
              )}
            />
            <Icon aria-hidden className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
            {!collapsed && badge}
          </>
        )}
      </NavLink>
    </Tooltip>
  );
}

function RailSectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-4">
      <p className="font-mono text-2xs uppercase tracking-eyebrow text-rail-text-muted">{children}</p>
      {action}
    </div>
  );
}

export interface RailProps {
  collapsed: boolean;
  /** Mobile only: the rail is a drawer, and every link closes it. */
  onNavigate?: () => void;
  /** Waiting conversations, shown on the Inbox row. */
  inboxCount?: number;
}

export function Rail({ collapsed, onNavigate, inboxCount = 0 }: RailProps) {
  const { pathname } = useLocation();
  const { isOperator } = useWorkspace();
  const { bots } = useBotContext();

  const scopedAgentId = agentIdFromPath(pathname);
  const scopedAgent = useMemo(
    () => (scopedAgentId ? (bots.find((bot) => String(bot.id) === scopedAgentId) ?? null) : null),
    [bots, scopedAgentId],
  );

  const primary = navForRole(WORKSPACE_NAV, isOperator);
  const inAgentScope = Boolean(scopedAgentId) && !isOperator;

  return (
    <div className="flex h-full flex-col bg-rail text-rail-text">
      <div
        className={cn(
          'flex h-topbar shrink-0 items-center border-b border-rail-border',
          collapsed ? 'justify-center px-0' : 'px-3',
        )}
      >
        {collapsed ? (
          <OyeChatsMark size={26} onInk />
        ) : (
          <WorkspaceSwitcher onNavigate={onNavigate} />
        )}
      </div>

      <nav
        aria-label={inAgentScope ? 'Chatbot navigation' : 'Primary navigation'}
        className="flex-1 overflow-y-auto px-2 py-2"
      >
        {inAgentScope && scopedAgent ? (
          <>
            <NavLink
              to="/chatbots"
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs',
                'text-rail-text-muted transition-colors hover:bg-rail-hover hover:text-rail-text',
                collapsed && 'justify-center px-0',
              )}
            >
              <ArrowLeft aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {!collapsed && 'All chatbots'}
            </NavLink>

            {!collapsed && (
              <div className="mt-2">
                <AgentSwitcher current={scopedAgent} onNavigate={onNavigate} />
              </div>
            )}

            <div className="mt-3 space-y-0.5">
              {AGENT_NAV.map((item) => (
                <RailLink
                  key={item.segment}
                  to={agentPath(scopedAgent.id, item.segment)}
                  label={item.label}
                  icon={item.icon}
                  hint={item.hint}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="space-y-0.5">
              {primary.map((item) => (
                <RailLink
                  key={item.to}
                  {...item}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                  badge={
                    item.to === '/inbox' && inboxCount > 0 ? (
                      <Badge tone="success" className="shrink-0">
                        {inboxCount}
                      </Badge>
                    ) : undefined
                  }
                />
              ))}
            </div>

            {/* Recent chatbots, so cross-chatbot switching stays one click away
                without the rail growing with the account. */}
            {!isOperator && bots.length > 0 && !collapsed ? (
              <>
                <RailSectionLabel
                  action={
                    <NavLink
                      to="/chatbots?new=1"
                      onClick={onNavigate}
                      aria-label="New chatbot"
                      className="rounded-xs p-0.5 text-rail-text-muted transition-colors hover:text-rail-text"
                    >
                      <Plus aria-hidden className="h-3.5 w-3.5" />
                    </NavLink>
                  }
                >
                  Chatbots
                </RailSectionLabel>
                <div className="space-y-0.5">
                  {bots.slice(0, 3).map((bot) => {
                    // The dot carries health, so the rail answers "is anything
                    // wrong?" without the user opening anything. It is never the
                    // only signal — Home names the chatbot and says what to do.
                    const health = agentHealth(bot);
                    return (
                      <NavLink
                        key={bot.id}
                        to={agentPath(bot.id, 'overview')}
                        onClick={onNavigate}
                        className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-rail-text-muted transition-colors hover:bg-rail-hover hover:text-rail-text"
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            health.tone === 'danger' && 'bg-danger-fill',
                            health.tone === 'warning' && 'bg-warning-fill',
                            health.tone === 'success' && 'bg-success-fill',
                            health.tone === 'neutral' && 'bg-rail-text-muted',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                        <span className="sr-only">{health.label}</span>
                      </NavLink>
                    );
                  })}
                  {bots.length > 3 ? (
                    <NavLink
                      to="/chatbots"
                      onClick={onNavigate}
                      className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-rail-text-muted transition-colors hover:text-rail-text"
                    >
                      <ChevronsUpDown aria-hidden className="h-3 w-3 shrink-0" />
                      Show all {bots.length}
                    </NavLink>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
      </nav>

      <div className="shrink-0 border-t border-rail-border p-2">
        {!isOperator ? <SetupProgress collapsed={collapsed} onNavigate={onNavigate} /> : null}
        <div className="mt-1 space-y-0.5">
          {navForRole(FOOTER_NAV, isOperator).map((item) => (
            <RailLink key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
        <div className={cn('mt-1', collapsed && 'flex justify-center')}>
          <AccountMenu collapsed={collapsed} />
        </div>
      </div>
    </div>
  );
}
