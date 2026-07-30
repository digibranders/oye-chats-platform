import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { PRIMARY_NAV, navForRole } from './nav.config';
import { cn } from '../design-system';
import { useWorkspace } from '../context/WorkspaceContext';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Command Palette - PLACEHOLDER (Phase 1).
 * Opens on ⌘K / Ctrl-K and currently offers navigation to the six primary
 * destinations. Full command search (agents, conversations, actions, settings)
 * is wired in a later phase once those surfaces exist. Rendered as a controlled
 * overlay (open state owned by the AppShell) to stay independent of any dialog
 * library internals.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { isOperator } = useWorkspace();
  const navItems = navForRole(PRIMARY_NAV, isOperator);

  if (!open) return null;

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Command palette">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div className="absolute left-1/2 top-[12vh] w-full max-w-lg -translate-x-1/2 px-4">
        <Command
          label="Command palette"
          onKeyDown={(event) => {
            if (event.key === 'Escape') onOpenChange(false);
          }}
          className="overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]"
        >
          <div className="flex items-center gap-2.5 border-b border-[var(--ds-border)] px-4">
            <Search size={16} className="shrink-0 text-[var(--ds-text-subtle)]" />
            <Command.Input
              autoFocus
              placeholder="Go to…"
              className="h-12 w-full bg-transparent text-sm text-[var(--ds-text)] outline-none placeholder:text-[var(--ds-text-subtle)]"
            />
            <kbd className="hidden rounded border border-[var(--ds-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ds-text-subtle)] sm:inline">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-[var(--ds-text-muted)]">
              No results. Full search arrives in a later phase.
            </Command.Empty>

            <Command.Group
              heading="Navigate"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--ds-text-subtle)]"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Command.Item
                    key={item.to}
                    value={`${item.label} ${item.hint ?? ''}`}
                    onSelect={() => go(item.to)}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-[var(--ds-text)]',
                      'data-[selected=true]:bg-[var(--ds-accent-soft)] data-[selected=true]:text-[var(--ds-accent-text)]',
                    )}
                  >
                    <Icon size={16} className="shrink-0 text-[var(--ds-text-subtle)]" />
                    <span className="font-medium">{item.label}</span>
                    {item.hint && (
                      <span className="ml-auto truncate text-[12px] text-[var(--ds-text-subtle)]">
                        {item.hint}
                      </span>
                    )}
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
