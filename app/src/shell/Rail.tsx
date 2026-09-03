import { useMemo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bot, PanelLeft, Plus, X } from 'lucide-react';
import {
  RailBackLink,
  RailFrame,
  RailGroupLabel,
  RailItem,
  Tooltip,
  cn,
  formatBadgeCount,
} from '../ui';
import { agentHealth } from '../features/home/agentHealth';
import { navLabel } from './navCopy';
import { useTranslation } from '../i18n/useTranslation';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBotContext } from '../context/BotContext';
import {
  AGENT_NAV,
  CHATBOTS_ITEM,
  agentIdFromPath,
  agentPath,
  railFooter,
  railPrimary,
} from './nav';
import { OyeChatsMark } from './OyeChatsMark';
import { RailBrand } from './RailBrand';
import { AgentSwitcher } from './AgentSwitcher';
import { BotScopeSwitcher } from './BotScopeSwitcher';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { SetupProgress } from './SetupProgress';
import { TrialCard } from './TrialCard';
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
 * It has two states, never a tree. In workspace scope it lists the workspace's
 * destinations and its chatbots; inside a chatbot it swaps to that chatbot's
 * six, with a permanent way back. See `nav.ts` for why.
 *
 * **Every row is a `RailItem`.** The geometry is `src/ui/layout/RailFrame`'s,
 * not this file's: three row heights (36 / 32 / 30) and six left text edges
 * (20 / 34 / 40 / 40.5 / 42 / 44) used to live in this one 248px column, and
 * the recent-chatbot names started ten pixels to the left of the nav labels
 * directly above them. One item shape, one 16px glyph box, one label column.
 *
 * **Scope comes from the URL, not from the bot list.** `inAgentScope` used to
 * require the resolved chatbot, which arrives asynchronously — so a hard reload
 * of `/chatbots/12/knowledge` painted the workspace rail first and rewrote the
 * whole column a frame later, with no row keeping its position.
 */

/** A health dot, sized for the shared 16px glyph box. */
function HealthDot({ tone }: { tone: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 rounded-full',
        // The rail's own status scale. The paper fills these replaced measure
        // 2.94:1 (danger), 3.13 (success) and 3.85 (warning) against
        // `--color-rail` — the one dot a customer must not miss was the least
        // visible of the four, and it failed SC 1.4.11.
        tone === 'danger' && 'bg-rail-danger',
        tone === 'warning' && 'bg-rail-warning',
        tone === 'success' && 'bg-rail-success',
        tone === 'neutral' && 'bg-rail-text-muted',
      )}
    />
  );
}

/** A count on a rail row: mono, capped, and in the rail's own accent. */
function RailCount({ value, label }: { value: number; label: string }) {
  return (
    <span className="figure rounded-xs bg-rail-accent px-1 text-2xs font-medium text-rail">
      {formatBadgeCount(value)}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/** A 24px ghost control in the rail header — collapse on desktop, close on mobile. */
function RailHeaderButton({
  label,
  icon,
  onClick,
  controls,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** The id of the region it expands, when it expands one. */
  controls?: string;
}) {
  return (
    <Tooltip content={label} side="inline-end">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-expanded={controls ? true : undefined}
        aria-controls={controls}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-rail-text-muted transition-colors hover:bg-rail-hover hover:text-rail-text focus-visible:outline-rail-accent"
      >
        {icon}
      </button>
    </Tooltip>
  );
}

export interface RailProps {
  collapsed: boolean;
  /** Mobile only: the rail is a drawer, and every link closes it. */
  onNavigate?: () => void;
  /** Desktop only: collapse and expand. Lives here, not in the top bar. */
  onToggle?: () => void;
  /** Mobile only: dismiss the drawer without navigating. */
  onClose?: () => void;
  /**
   * Mobile only: the rail is the drawer, so anything it opens (the account
   * menu) has to stay inside it rather than beside it.
   */
  inDrawer?: boolean;
  /** Waiting conversations, shown on the Inbox row. */
  inboxCount?: number;
}

export function Rail({
  collapsed,
  onNavigate,
  onToggle,
  onClose,
  inDrawer = false,
  inboxCount = 0,
}: RailProps) {
  // Re-render on a language switch. Every label below is resolved at call
  // time through `navLabel`, so without this subscription the rail would keep
  // whatever language it mounted in while the rest of the chrome moved.
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { isOperator, hasMultipleWorkspaces } = useWorkspace();
  const { bots } = useBotContext();

  const scopedAgentId = agentIdFromPath(pathname);
  const scopedAgent = useMemo(
    () => (scopedAgentId ? (bots.find((bot) => String(bot.id) === scopedAgentId) ?? null) : null),
    [bots, scopedAgentId],
  );

  const primary = railPrimary(isOperator);
  // `/welcome` *is* Home for a workspace with no chatbot — `HomePage` redirects
  // there rather than rendering a page of zeros, and `/welcome/:agentId` is the
  // second half of the same flow. `NavLink end` matched neither, so the rail
  // went blank on the first two screens a new customer ever sees, at exactly the
  // moment they most need to know where they are.
  const onFirstRun = pathname === '/welcome' || pathname.startsWith('/welcome/');
  const footerItems = railFooter(isOperator);
  const inAgentScope = Boolean(scopedAgentId) && !isOperator;
  // The first three in workspace order, not the three most recently opened —
  // the comment here used to promise recency the code never delivered, so on a
  // twelve-chatbot account the same three were pinned forever and looked like a
  // bug. The tail row goes to all of them; the palette finds any of them by
  // name in two keystrokes.
  const firstThree = bots.slice(0, 3);

  const header = collapsed ? (
    // Collapsed, the mark is the expander. At 60px there is room for one 24px
    // control, and throwing the brand away to keep a chevron is the wrong trade.
    <Tooltip content="Expand navigation" side="inline-end">
      <button
        type="button"
        onClick={onToggle}
        aria-label={t('shell.expandNavigation') || 'Expand navigation'}
        aria-expanded={false}
        aria-controls="app-rail"
        className="mx-auto flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-rail-hover focus-visible:outline-rail-accent"
      >
        <OyeChatsMark size={22} onInk />
      </button>
    </Tooltip>
  ) : (
    <>
      <RailBrand />
      {onClose ? (
        <RailHeaderButton
          label={t('shell.closeNavigation') || 'Close navigation'}
          onClick={onClose}
          icon={<X aria-hidden className="h-icon-md w-icon-md" />}
        />
      ) : onToggle ? (
        <RailHeaderButton
          label={t('shell.collapseNavigation') || 'Collapse navigation'}
          onClick={onToggle}
          controls="app-rail"
          icon={<PanelLeft aria-hidden className="h-icon-md w-icon-md" />}
        />
      ) : null}
    </>
  );

  const footer = (
    <div className="flex flex-col gap-0.5">
      {/* Directly above Billing: the fact and the place to act on it, adjacent.
          Operators never see it; a trial is a fact about the workspace owner's
          account, not about the person answering chats in it. */}
      {!isOperator ? <TrialCard collapsed={collapsed} /> : null}
      <ul className="flex flex-col gap-0.5">
        {footerItems.map((item) => (
          <RailItem
            key={item.to}
            to={item.to}
            label={navLabel(item.label)}
            end={item.end}
            collapsed={collapsed}
            onNavigate={onNavigate}
            glyph={<item.icon aria-hidden className="h-icon-md w-icon-md" />}
          />
        ))}
      </ul>
      <div className={cn(collapsed && 'flex justify-center')}>
        <AccountMenu collapsed={collapsed} inDrawer={inDrawer} />
      </div>
    </div>
  );

  return (
    <RailFrame
      header={header}
      footer={footer}
      navLabel={
        inAgentScope
          ? t('nav.secondaryLandmark') || 'Chatbot navigation'
          : t('nav.primaryLandmark') || 'Primary navigation'
      }
    >
      {/* Above both scopes, because it scopes both: the chatbot list, the
          inbox and every figure below it belong to one workspace. Gated here
          rather than inside the component so a solo account - which has
          nothing to switch between - does not carry an empty row's padding. */}
      {hasMultipleWorkspaces && !collapsed ? (
        <li className="pb-1">
          <WorkspaceSwitcher onNavigate={onNavigate} />
        </li>
      ) : null}

      {inAgentScope ? (
        <>
          <RailBackLink to="/chatbots" onNavigate={onNavigate}>
            {t('shell.allChatbots') || 'All chatbots'}
          </RailBackLink>

          {!collapsed ? (
            <li className="py-1">
              <AgentSwitcher agentId={scopedAgentId!} agent={scopedAgent} onNavigate={onNavigate} />
            </li>
          ) : null}

          {AGENT_NAV.map((item) => (
            <RailItem
              key={item.segment}
              to={agentPath(scopedAgentId!, item.segment)}
              label={navLabel(item.label)}
              collapsed={collapsed}
              onNavigate={onNavigate}
              glyph={<item.icon aria-hidden className="h-icon-md w-icon-md" />}
            />
          ))}
        </>
      ) : (
        <>
          {/* Which chatbot the workspace pages below are showing. Renders
              nothing for a single-chatbot account, which is every plan except
              Enterprise — so for almost everyone the rail is unchanged.

              Above the nav rather than beside it because it scopes what those
              items open, the same reason `WorkspaceSwitcher` sits above this.
              It does NOT scope Billing or Settings further down: a plan and a
              credit balance belong to one chatbot, and those pages carry their
              own chatbot selection. */}
          {!collapsed ? (
            <li className="pb-1">
              <BotScopeSwitcher />
            </li>
          ) : null}

          {primary.map((item) => (
            <RailItem
              key={item.to}
              to={item.to}
              label={navLabel(item.label)}
              end={item.end}
              active={item.to === '/' && onFirstRun ? true : undefined}
              collapsed={collapsed}
              onNavigate={onNavigate}
              glyph={<item.icon aria-hidden className="h-icon-md w-icon-md" />}
              trailing={
                item.to === '/inbox' && inboxCount > 0 ? (
                  <RailCount value={inboxCount} label={t('shell.waiting') || 'waiting'} />
                ) : undefined
              }
            />
          ))}

          {/* The chatbots, and the way to all of them. The group is rendered
              whatever the count: gating it on `bots.length > 0` left every new
              signup looking at four nav rows and nothing else, with no way to
              create the one object the product exists for. */}
          {!isOperator ? (
            <>
              <RailGroupLabel
                collapsed={collapsed}
                action={
                  <Tooltip content="New chatbot">
                    {/* A `Link`, not a `NavLink`. `/chatbots?new=1` matches the
                        path `/chatbots`, so on the list page `NavLink` stamped
                        this button with `aria-current="page"` — a screen reader
                        announced the create control as the current destination,
                        alongside the "All chatbots" row that actually was. */}
                    <Link
                      to="/chatbots?new=1"
                      onClick={onNavigate}
                      aria-label={t('shell.newChatbot') || 'New chatbot'}
                      className="-me-1 flex h-6 w-6 items-center justify-center rounded-sm text-rail-text-muted transition-colors hover:bg-rail-hover hover:text-rail-text focus-visible:outline-rail-accent"
                    >
                      <Plus aria-hidden className="h-icon-sm w-icon-sm" />
                    </Link>
                  </Tooltip>
                }
              >
                {t('shell.chatbots') || 'Chatbots'}
              </RailGroupLabel>

              {firstThree.map((bot) => {
                // The dot carries health, so the rail answers "is anything
                // wrong?" without the user opening anything. It is never the
                // only signal — the row's own screen-reader text names the
                // state, and Home says what to do about it.
                const health = agentHealth(bot);
                return (
                  <RailItem
                    key={bot.id}
                    to={agentPath(bot.id, 'overview')}
                    label={bot.name ?? `${navLabel((t('shell.chatbot') || 'Chatbot'))} ${bot.id}`}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                    glyph={
                      <>
                        <HealthDot tone={health.tone} />
                        <span className="sr-only">{health.label}</span>
                      </>
                    }
                  />
                );
              })}

              <RailItem
                to={CHATBOTS_ITEM.to}
                label={navLabel(t('shell.allChatbots') || 'All chatbots')}
                end
                collapsed={collapsed}
                onNavigate={onNavigate}
                glyph={<Bot aria-hidden className="h-icon-md w-icon-md" />}
                trailing={
                  bots.length > 0 ? (
                    <span className="figure text-2xs text-rail-text-muted">{bots.length}</span>
                  ) : undefined
                }
              />
            </>
          ) : null}

          {/* Onboarding, directly under the destinations rather than in the
              footer beside Settings. It removes itself when complete, so it
              costs an established account nothing. */}
          {!isOperator ? <SetupProgress collapsed={collapsed} onNavigate={onNavigate} /> : null}
        </>
      )}
    </RailFrame>
  );
}
