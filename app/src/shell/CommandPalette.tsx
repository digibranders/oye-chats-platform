import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Bot, CornerDownLeft, Search, type LucideIcon } from 'lucide-react';
import { Kbd, cn } from '../ui';
import { useBotContext } from '../context/BotContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { AGENT_NAV, FOOTER_NAV, WORKSPACE_NAV, agentPath, navForRole } from './nav';

interface Command {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: LucideIcon;
  to: string;
  /** Matched by the filter but not displayed. */
  keywords?: string;
}

/**
 * Search, and everything you can do.
 *
 * The palette this replaces described itself in its own source as a placeholder:
 * it listed the six nav links and told the user that "full search arrives in a
 * later phase". In an IA with a flat rail, the palette is not a convenience —
 * it is how you reach a specific chatbot, a specific setting, or a destination
 * that is one scope away, so it has to actually find things.
 *
 * Built on the same combobox primitive as every other search in the app, so the
 * ARIA relationships, the highlight and the filtering are the library's problem
 * and not ours. The previous one was a hand-rolled `role="dialog"` with no focus
 * trap and no focus restore.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { bots } = useBotContext();
  const { isOperator } = useWorkspace();
  const [query, setQuery] = useState('');

  const commands = useMemo<Command[]>(() => {
    const destinations: Command[] = navForRole([...WORKSPACE_NAV, ...FOOTER_NAV], isOperator).map(
      (item) => ({
        id: `nav:${item.to}`,
        label: item.label,
        hint: item.hint,
        group: 'Page',
        icon: item.icon,
        to: item.to,
      }),
    );

    // Every chatbot, and every destination inside every chatbot. This is the
    // half the old palette was missing, and the reason a flat rail works: with
    // twenty chatbots, "Northwind knowledge" is two keystrokes rather than
    // three clicks through a list.
    const agents: Command[] = isOperator
      ? []
      : bots.flatMap((bot) => {
          const name = bot.name ?? `Chatbot ${bot.id}`;
          return [
            {
              id: `agent:${bot.id}`,
              label: name,
              hint: 'Open this chatbot',
              group: 'Chatbots',
              icon: Bot,
              to: agentPath(bot.id, 'overview'),
              keywords: bot.bot_key ?? undefined,
            },
            ...AGENT_NAV.map((tab) => ({
              id: `agent:${bot.id}:${tab.segment}`,
              label: `${name} — ${tab.label}`,
              hint: tab.hint,
              group: 'Chatbots',
              icon: tab.icon,
              to: agentPath(bot.id, tab.segment),
              keywords: `${name} ${tab.label} ${bot.bot_key ?? ''}`,
            })),
          ];
        });

    return [...destinations, ...agents];
  }, [bots, isOperator]);

  function run(command: Command | null) {
    if (!command) return;
    onOpenChange(false);
    setQuery('');
    navigate(command.to);
  }

  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <BaseDialog.Popup
          className={cn(
            'motion-panel fixed left-1/2 top-[12vh] z-[var(--z-overlay)] w-[calc(100vw-2rem)] max-w-xl',
            '-translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg',
            'focus:outline-none',
          )}
        >
          <BaseDialog.Title className="sr-only">Search</BaseDialog.Title>
          <BaseCombobox.Root<Command, false>
            items={commands}
            value={null}
            open
            inputValue={query}
            onInputValueChange={setQuery}
            itemToStringValue={(item) => `${item.label} ${item.keywords ?? ''}`}
            onValueChange={run}
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <Search aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
              <BaseCombobox.Input
                autoFocus
                placeholder="Search chatbots, pages and settings…"
                className="h-12 w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-disabled"
              />
              <Kbd className="shrink-0">Esc</Kbd>
            </div>

            {/* The Empty root stays mounted whether or not the list is empty, because
                the library uses it as the live region that announces result counts.
                Only its children are conditional, so any padding put here is dead
                space above every non-empty result list. It goes on the child. */}
            <BaseCombobox.Empty>
              <p className="px-4 py-10 text-center text-sm text-text-secondary">
                Nothing matches “{query}”.
              </p>
            </BaseCombobox.Empty>

            <BaseCombobox.List className="max-h-80 overflow-y-auto p-1.5">
              {(command: Command) => (
                <BaseCombobox.Item
                  key={command.id}
                  value={command}
                  className={cn(
                    'group flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 outline-none',
                    'data-[highlighted]:bg-surface-hover',
                  )}
                >
                  <command.icon aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-text-primary">{command.label}</span>
                    <span className="block truncate text-xs text-text-secondary">{command.hint}</span>
                  </span>
                  <span className="shrink-0 font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                    {command.group}
                  </span>
                  <CornerDownLeft
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 text-text-tertiary opacity-0 group-data-[highlighted]:opacity-100"
                  />
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
