import { useCallback } from 'react';
import { Bot as BotIcon, Check, ChevronsUpDown } from 'lucide-react';
import { cn, Popover } from '../design-system';
import { useBotContext } from '../context/BotContext';
import type { Bot } from '../types/domain';

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
 * Rendered only when the workspace has 2+ bots - a single-bot workspace has no
 * choice to make and the chrome stays quiet.
 */
export function BotSwitcher() {
  const { bots, selectedBot, selectBot } = useBotContext();

  const handleSelect = useCallback(
    (bot: Bot, close: () => void) => {
      close();
      // No-op when the user picks what's already selected - avoids a needless
      // rerender + persistence write and keeps the popover feel snappy.
      if (bot.id === selectedBot?.id) return;
      selectBot(bot);
    },
    [selectBot, selectedBot],
  );

  // The context always resolves a concrete agent when bots exist; guard anyway
  // so a transient null (during the initial load) renders nothing rather than
  // an empty control.
  if (bots.length < 2 || !selectedBot) return null;

  const label = selectedBot.name || 'Agent';

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
          aria-label={`Current agent: ${label}. Switch agent`}
          className="flex h-9 max-w-[42vw] items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5 text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] md:max-w-[200px]"
        >
          <BotAvatar
            logo={selectedBot.bot_logo}
            avatarType={selectedBot.avatar_type}
            orbColor={selectedBot.orb_color}
            primaryColor={selectedBot.primary_color}
            size={18}
          />
          <span className="truncate text-[13px] font-medium">{label}</span>
          <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Switch agent
          </p>
          <div className="max-h-80 overflow-y-auto p-1">
            {bots.map((bot) => (
              <BotOption
                key={bot.id}
                logo={bot.bot_logo}
                avatarType={bot.avatar_type}
                orbColor={bot.orb_color}
                primaryColor={bot.primary_color}
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
