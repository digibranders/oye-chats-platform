import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot as BotIcon, Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn, Input, Popover } from '../design-system';
import { useBotContext } from '../context/BotContext';
import type { Bot } from '../types/domain';
import {
  agentIdFromPath,
  filterAgents,
  shouldShowAgentFilter,
  swapAgentInPath,
} from './agentSwitcherModel';

/**
 * BotSwitcher - the TopBar control that scopes the whole dashboard to one
 * agent. Sits next to `WorkspaceSwitcher` so scope choices are colocated in a
 * single premium chrome region - the user picks a workspace, then narrows to an
 * agent inside it.
 *
 * Backed by `BotContext.selectedBot`, which is persisted via localStorage and
 * consumed by Home, Analytics, Leads, Inbox, and Integrations. The dashboard is
 * always scoped to a single agent - there is no workspace-aggregated view.
 *
 * Two scopes, one control
 * -----------------------
 * Agent pages are URL objects (`/agents/:agentId/<tab>`) and `AgentContext`
 * resolves the active agent from the route param, deliberately never from
 * `selectedBot`. So on those routes this control must NAVIGATE - writing the
 * shell scope alone would relabel the chip while the page kept rendering the
 * previous agent. Off those routes (`/workspace/*`, `/leads`, `/inbox`, ...)
 * pages read `selectedBot`, so switching is a pure state write and the URL is
 * left alone.
 *
 * The same split keeps the persisted choice honest: while an agent-scoped
 * route is open the URL is the authority and this component mirrors it back
 * into `selectBot` (which persists it). Without that, opening an agent from
 * the Agents grid - which navigates without touching the shell scope - would
 * leave localStorage pointing at a different agent than the address bar, and a
 * reload would silently rescope every workspace-level page to the stale one.
 * `AgentContext` documents this component as the sole writer of that scope,
 * and it stays that way.
 *
 * Rendered only when the workspace has 2+ bots - a single-bot workspace has no
 * choice to make and the chrome stays quiet.
 */
export function BotSwitcher() {
  const { bots, selectedBot, selectBot } = useBotContext();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // The agent the URL is pinned to, when the current route is agent-scoped.
  const routeBot = useMemo<Bot | null>(() => {
    const routeAgentId = agentIdFromPath(pathname);
    if (routeAgentId === null) return null;
    return bots.find((bot) => String(bot.id) === routeAgentId) ?? null;
  }, [bots, pathname]);

  // URL wins on agent routes: fold it back into the shell scope so the
  // persisted id and the address bar can never disagree across a reload.
  // Skipped when the route id resolves to no known agent (deleted, or another
  // workspace's) - there is nothing truthful to sync in that case.
  useEffect(() => {
    if (routeBot !== null && routeBot.id !== selectedBot?.id) {
      selectBot(routeBot);
    }
  }, [routeBot, selectedBot, selectBot]);

  // Prefer the URL's agent for display so a direct navigation renders the
  // right label immediately, without waiting a frame for the sync effect.
  const activeBot = routeBot ?? selectedBot;

  const handleSelect = useCallback(
    (bot: Bot, close: () => void) => {
      close();
      // No-op when the user picks what's already active - avoids a needless
      // rerender + persistence write and keeps the popover feel snappy.
      if (bot.id === activeBot?.id) return;
      selectBot(bot);
      // Same tab, new agent. `null` means this route isn't agent-scoped, so
      // the state write above is the whole switch.
      const nextPath = swapAgentInPath(pathname, bot.id);
      if (nextPath !== null) navigate(nextPath);
    },
    [activeBot, navigate, pathname, selectBot],
  );

  // The context always resolves a concrete agent when bots exist; guard anyway
  // so a transient null (during the initial load) renders nothing rather than
  // an empty control.
  if (bots.length < 2 || !activeBot) return null;

  const label = activeBot.name || 'Chatbot';

  return (
    <Popover
      align="start"
      role="menu"
      panelClassName="w-72"
      trigger={(triggerProps) => (
        <button
          type="button"
          ref={triggerProps.setRef}
          onClick={triggerProps.onClick}
          aria-haspopup={triggerProps['aria-haspopup']}
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label={`Current chatbot: ${label}. Switch chatbot`}
          className="flex h-9 max-w-[42vw] items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5 text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] md:max-w-[200px]"
        >
          <BotAvatar
            logo={activeBot.bot_logo}
            avatarType={activeBot.avatar_type}
            orbColor={activeBot.orb_color}
            primaryColor={activeBot.primary_color}
            size={18}
          />
          <span className="truncate text-[13px] font-medium">{label}</span>
          <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
        </button>
      )}
    >
      {(close) => (
        <AgentPickerPanel
          bots={bots}
          activeBotId={activeBot.id}
          onSelect={(bot) => handleSelect(bot, close)}
        />
      )}
    </Popover>
  );
}

/**
 * AgentPickerPanel - the switcher's popover body: an optional filter box above
 * a scrolling list of agents.
 *
 * Deliberately its own component rather than inline JSX. `Popover` unmounts
 * its panel on close, so the filter query lives and dies with one open/close
 * cycle - reopening the switcher always starts from the full list, with no
 * reset effect or `onOpenChange` callback to keep in sync.
 */
function AgentPickerPanel({
  bots,
  activeBotId,
  onSelect,
}: {
  bots: Bot[];
  activeBotId: number;
  onSelect: (bot: Bot) => void;
}) {
  const [query, setQuery] = useState('');
  // Short lists are scannable at a glance; the input would be pure chrome.
  const showFilter = shouldShowAgentFilter(bots.length);
  const visibleBots = useMemo(
    () => (showFilter ? filterAgents(bots, query) : bots),
    [bots, query, showFilter],
  );

  return (
    <div>
      <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
        Switch chatbot
      </p>

      {showFilter && (
        <div className="relative border-b border-[var(--ds-border)] p-2">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
          />
          {/* Not auto-focused on purpose: `Popover` focuses its panel on open,
              and a focus race with that would be fragile. From the panel, one
              Tab or ArrowDown lands here - it is the first focusable item. */}
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter chatbots"
            placeholder="Filter chatbots"
            autoComplete="off"
            className="h-9 pl-8 text-[13px]"
          />
        </div>
      )}

      <div className="max-h-80 overflow-y-auto p-1">
        {visibleBots.length === 0 ? (
          <p role="status" className="px-3 py-6 text-center text-[13px] text-[var(--ds-text-muted)]">
            No chatbots match &ldquo;{query.trim()}&rdquo;
          </p>
        ) : (
          visibleBots.map((bot) => (
            <BotOption
              key={bot.id}
              logo={bot.bot_logo}
              avatarType={bot.avatar_type}
              orbColor={bot.orb_color}
              primaryColor={bot.primary_color}
              label={bot.name || `Chatbot #${bot.id}`}
              sublabel={bot.bot_key ?? undefined}
              active={activeBotId === bot.id}
              onSelect={() => onSelect(bot)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * BotAvatar - renders an agent's *configured* avatar so the switcher mirrors
 * exactly what the widget shows (see AvatarPicker's `AvatarPreview`):
 *   - a logo set (`upload`) → the uploaded image
 *   - `orb` → a lightweight gradient puck in the configured orb colour (not the
 *     heavy WebGL orb, which would spin up one GL context per switcher row)
 *   - otherwise (mascot / no logo yet) → the widget's own fallback: a robot
 *     glyph on the agent's primary colour (NOT a name monogram)
 * Square-rounded to sit cleanly inline with text.
 */
function BotAvatar({
  logo,
  avatarType,
  orbColor,
  primaryColor,
  size = 18,
  rounded = 'rounded-md',
}: {
  logo?: string | null;
  avatarType?: string | null;
  orbColor?: string | null;
  primaryColor?: string | null;
  size?: number;
  rounded?: string;
}) {
  const box = { width: size, height: size };

  if (avatarType === 'orb') {
    const color = orbColor || primaryColor || 'var(--ds-accent)';
    return (
      <span
        aria-hidden="true"
        style={{
          ...box,
          background: `radial-gradient(circle at 32% 28%, rgba(255, 255, 255, 0.7), ${color} 72%)`,
        }}
        className={cn('shrink-0', rounded)}
      />
    );
  }

  if (avatarType === 'upload' && logo) {
    return (
      <span aria-hidden="true" style={box} className={cn('block shrink-0 overflow-hidden', rounded)}>
        <img src={logo} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }

  // mascot, or upload with no logo yet - mirror the widget's fallback avatar.
  return (
    <span
      aria-hidden="true"
      style={{ ...box, backgroundColor: primaryColor || 'var(--ds-accent)' }}
      className={cn('flex shrink-0 items-center justify-center text-white', rounded)}
    >
      <BotIcon size={Math.round(size * 0.55)} />
    </span>
  );
}

interface BotOptionProps {
  /** Agent launcher logo URL, when set. */
  logo?: string | null;
  /** Configured avatar style ('upload' | 'orb' | 'mascot'). */
  avatarType?: string | null;
  /** Orb avatar colour, used when avatarType === 'orb'. */
  orbColor?: string | null;
  /** Agent primary colour - the orb's fallback tint. */
  primaryColor?: string | null;
  label: string;
  sublabel?: string;
  active: boolean;
  onSelect: () => void;
}

function BotOption({
  logo,
  avatarType,
  orbColor,
  primaryColor,
  label,
  sublabel,
  active,
  onSelect,
}: BotOptionProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-[var(--ds-radius-md)] px-3 py-2 text-left transition-colors',
        active ? 'bg-[var(--ds-accent-soft)]' : 'hover:bg-[var(--ds-bg-hover)]',
      )}
    >
      <BotAvatar
        logo={logo}
        avatarType={avatarType}
        orbColor={orbColor}
        primaryColor={primaryColor}
        size={32}
        rounded="rounded-lg"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-[var(--ds-text)]">{label}</span>
        {sublabel ? (
          <span className="block truncate text-[11px] text-[var(--ds-text-subtle)]">{sublabel}</span>
        ) : null}
      </span>
      {active ? (
        <Check size={15} aria-hidden="true" className="shrink-0 text-[var(--ds-accent)]" />
      ) : null}
    </button>
  );
}
