import { useCallback } from 'react';
import { Check, ChevronsUpDown, LayoutGrid, type LucideIcon } from 'lucide-react';
import { cn, Popover } from '../design-system';
import { useBotContext } from '../context/BotContext';
import type { Bot } from '../types/domain';

/**
 * BotSwitcher - the TopBar control that scopes the whole dashboard to one
 * agent (or aggregates across every agent). Sits next to `WorkspaceSwitcher`
 * so scope choices are colocated in a single premium chrome region - the user
 * picks a workspace, then narrows to an agent inside it.
 *
 * Backed by `BotContext.selectedBot`, which is persisted via localStorage and
 * consumed by Home, Analytics, Leads, Inbox, and Integrations. `selectedBot`
 * being `null` means the workspace-aggregated "All agents" view; the sentinel
 * is a first-class value, not an absence.
 *
 * Rendered only when the workspace has 2+ bots - a single-bot workspace has no
 * choice to make and the chrome stays quiet.
 */
export function BotSwitcher() {
  const { bots, selectedBot, selectBot } = useBotContext();

  const handleSelect = useCallback(
    (bot: Bot | null, close: () => void) => {
      close();
      // No-op when the user picks what's already selected - avoids a needless
      // rerender + persistence write and keeps the popover feel snappy.
      if ((bot?.id ?? null) === (selectedBot?.id ?? null)) return;
      selectBot(bot);
    },
    [selectBot, selectedBot],
  );

  if (bots.length < 2) return null;

  const isAllAgents = selectedBot === null;
  const label = isAllAgents ? 'All agents' : selectedBot?.name || 'Agent';

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
          aria-label={`Current scope: ${label}. Switch agent scope`}
          className="flex h-9 max-w-[42vw] items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5 text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] md:max-w-[200px]"
        >
          {isAllAgents ? (
            <LayoutGrid size={15} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
          ) : (
            <BotAvatar name={selectedBot?.name ?? ''} logo={selectedBot?.bot_logo} size={18} />
          )}
          <span className="truncate text-[13px] font-medium">{label}</span>
          <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Scope dashboard to
          </p>
          <div className="max-h-80 overflow-y-auto p-1">
            <BotOption
              icon={LayoutGrid}
              label="All agents"
              sublabel={`Aggregate across ${bots.length} agents`}
              active={isAllAgents}
              onSelect={() => handleSelect(null, close)}
            />
            <div className="my-1 h-px bg-[var(--ds-border)]" aria-hidden="true" />
            {bots.map((bot) => (
              <BotOption
                key={bot.id}
                name={bot.name}
                logo={bot.bot_logo}
                label={bot.name || `Agent #${bot.id}`}
                sublabel={bot.bot_key ?? undefined}
                active={selectedBot?.id === bot.id}
                onSelect={() => handleSelect(bot, close)}
              />
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

/**
 * BotAvatar - the agent's launcher logo when set, otherwise a monogram of its
 * name. Ensures every agent reads as a distinct visual identity in the switcher
 * (never a blank/generic glyph). Square-rounded to sit cleanly inline with text.
 */
function BotAvatar({
  name,
  logo,
  size = 18,
}: {
  name: string;
  logo?: string | null;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) }}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--ds-bg-sunken)] font-semibold text-[var(--ds-text-muted)]"
    >
      {logo ? (
        <img src={logo} alt="" className="h-full w-full object-cover" />
      ) : (
        name.trim().charAt(0).toUpperCase() || '?'
      )}
    </span>
  );
}

interface BotOptionProps {
  /** Fallback glyph when the row isn't an agent (e.g. the "All agents" row). */
  icon?: LucideIcon;
  /** Agent name - drives the monogram fallback when there's no logo. */
  name?: string;
  /** Agent launcher logo URL, when set. */
  logo?: string | null;
  label: string;
  sublabel?: string;
  active: boolean;
  onSelect: () => void;
}

function BotOption({ icon: Icon, name, logo, label, sublabel, active, onSelect }: BotOptionProps) {
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
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[12px] font-semibold',
          active
            ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
            : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
        )}
      >
        {logo ? (
          <img src={logo} alt="" className="h-full w-full object-cover" />
        ) : name ? (
          <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || '?'}</span>
        ) : Icon ? (
          <Icon size={15} aria-hidden="true" />
        ) : null}
      </span>
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
