import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Bot, Search, type LucideIcon } from 'lucide-react';
import { Kbd, cn } from '../ui';
import { useBotContext } from '../context/BotContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { AGENT_NAV, FOOTER_NAV, WORKSPACE_NAV, agentPath, navForRole } from './nav';
import { navHint, navLabel } from './navCopy';
import { useTranslation } from '../i18n/useTranslation';
import { Trans } from '../i18n/Trans';

interface Command {
  id: string;
  label: string;
  /** Matched by the filter, never rendered. */
  hint: string;
  icon: LucideIcon;
  to: string;
  /** Extra text the filter matches but which is not displayed. */
  keywords?: string;
}

interface CommandGroup {
  /** Base UI reads `items`; everything else on the object is ours. */
  label: string;
  items: Command[];
}

const RECENT_KEY = 'oc_palette_recent';
const RECENT_LIMIT = 5;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A browser with storage disabled still gets the palette, just not the memory.
  }
  return next;
}

/**
 * Search, and everything you can go to.
 *
 * The palette this replaces described itself in its own source as a placeholder:
 * it listed the six nav links and told the user that "full search arrives in a
 * later phase". In an IA with a flat rail, the palette is not a convenience —
 * it is how you reach a specific chatbot or a destination one scope away.
 *
 * **One line per result, and real group headers.** Every row used to carry an
 * explanatory sentence ("Open this chatbot", under a chatbot's name) plus the
 * group name stamped down the right-hand edge, which made a 56px row and showed
 * 5.7 of them in a 320px list. With twelve chatbots that was eighty-four rows
 * each tagged "Chatbots". Single-line rows and a `Group`/`GroupLabel` per group
 * put ten on screen in the same box — the biggest density win in the chrome.
 *
 * Built on the same combobox primitive as every other search in the app, so the
 * ARIA relationships, the highlight and the filtering are the library's problem
 * and not ours. The previous one was a hand-rolled `role="dialog"` with no focus
 * trap and no focus restore.
 *
 * It finds destinations and chatbots. It does not find a lead, a conversation,
 * a document or an invoice, so the placeholder no longer claims to — an async
 * group over `/leads?q=` and `/sessions?q=` is the real fix and is filed.
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
  // `t` changes identity with the locale, so listing it below is what
  // rebuilds every command's label and hint on a language switch.
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(readRecent);

  const commands = useMemo<Command[]>(() => {
    const destinations: Command[] = navForRole([...WORKSPACE_NAV, ...FOOTER_NAV], isOperator).map(
      (item) => ({
        id: `nav:${item.to}`,
        label: navLabel(item.label),
        hint: navHint(item.label, item.hint),
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
          const name = bot.name ?? `${navLabel((t('shell.chatbot') || 'Chatbot'))} ${bot.id}`;
          return [
            {
              id: `agent:${bot.id}`,
              label: name,
              hint: t('shell.palette.openChatbot') || 'Open this chatbot',
              icon: Bot,
              to: agentPath(bot.id, 'overview'),
              keywords: bot.bot_key ?? undefined,
            },
            ...AGENT_NAV.map((tab) => ({
              id: `agent:${bot.id}:${tab.segment}`,
              label: `${name} — ${navLabel(tab.label)}`,
              hint: navHint(tab.label, tab.hint),
              icon: tab.icon,
              to: agentPath(bot.id, tab.segment),
              keywords: `${name} ${tab.label} ${navLabel(tab.label)} ${bot.bot_key ?? ''}`,
            })),
          ];
        });

    return [...destinations, ...agents];
  }, [bots, isOperator, t]);

  const groups = useMemo<CommandGroup[]>(() => {
    const byId = new Map(commands.map((command) => [command.id, command]));
    // Opening the palette with an empty query used to show the rail, restated.
    // The five places you were last is the one ordering that makes the palette
    // faster than the rail, which is the only reason to have one.
    const recentCommands = query
      ? []
      : recent.map((id) => byId.get(id)).filter((command): command is Command => Boolean(command));
    const recentIds = new Set(recentCommands.map((command) => command.id));

    return [
      { label: t('shell.recent') || 'Recent', items: recentCommands },
      {
        label: t('shell.goTo') || 'Go to',
        items: commands.filter(
          (command) => command.id.startsWith('nav:') && !recentIds.has(command.id),
        ),
      },
      {
        label: t('shell.chatbots') || 'Chatbots',
        items: commands.filter(
          (command) => command.id.startsWith('agent:') && !recentIds.has(command.id),
        ),
      },
    ].filter((group) => group.items.length > 0);
  }, [commands, recent, query, t]);

  function run(command: Command | null) {
    if (!command) return;
    onOpenChange(false);
    setQuery('');
    setRecent(rememberRecent(command.id));
    navigate(command.to);
  }

  const shownQuery = query.length > 40 ? `${query.slice(0, 40)}…` : query;

  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <BaseDialog.Popup
          className={cn(
            // A fixed offset, not `top-[12vh]` — that was 86px on a laptop and
            // 173px on a monitor, so the palette wandered with the window.
            // rtl-ok: centers the panel on the viewport — the midpoint is the
            // same regardless of reading direction.
            'motion-panel fixed left-1/2 top-24 z-[var(--z-overlay)] w-[calc(100vw-2rem)] max-w-xl',
            '-translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg', // rtl-ok: centering, see above
            'focus:outline-none',
          )}
        >
          <BaseDialog.Title className="sr-only">{t('shell.search') || 'Search'}</BaseDialog.Title>
          <BaseCombobox.Root<Command, false>
            items={groups}
            value={null}
            open
            inputValue={query}
            onInputValueChange={setQuery}
            itemToStringValue={(item) => `${item.label} ${item.hint} ${item.keywords ?? ''}`}
            onValueChange={run}
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <Search aria-hidden className="h-icon-md w-icon-md shrink-0 text-text-tertiary" />
              <BaseCombobox.Input
                autoFocus
                placeholder={t('shell.jumpToAChatbotOr') || 'Jump to a chatbot or a page…'}
                className="h-control-lg w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-disabled"
              />
            </div>

            {/* The Empty root stays mounted whether or not the list is empty, because
                the library uses it as the live region that announces result counts.
                Only its children are conditional, so any padding put here is dead
                space above every non-empty result list. It goes on the child. */}
            <BaseCombobox.Empty>
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-text-secondary">
                  <Trans
                    k="shell.noMatchForQuery"
                    fallback="No match for {query}"
                    values={{
                      query: (
                        <span className="font-medium text-text-primary">“{shownQuery}”</span>
                      ),
                    }}
                  />
                </p>
                <p className="mt-1 text-xs text-text-tertiary">
                  {t('shell.tryAChatbotNameA') || 'Try a chatbot name, a page, or a setting.'}
                </p>
              </div>
            </BaseCombobox.Empty>

            {/* Bounded by the viewport, not by 320 pixels. `max-h-80` showed 8
                of 24 destinations on a 900px screen — a 400px panel with 500px
                of empty canvas under it — and the same 320px on a 600px laptop,
                where it is the whole window. `top-24` above plus a 2rem tail
                is what is actually available. */}
            <BaseCombobox.List className="max-h-[calc(100dvh-14rem)] min-h-0 overflow-y-auto p-1.5">
              {(group: CommandGroup) => (
                <BaseCombobox.Group key={group.label} items={group.items}>
                  <BaseCombobox.GroupLabel className="px-2.5 pb-1 pt-2 font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                    {group.label}
                  </BaseCombobox.GroupLabel>
                  <BaseCombobox.Collection>
                    {(command: Command) => (
                      <BaseCombobox.Item
                        key={command.id}
                        value={command}
                        className={cn(
                          'flex h-8 cursor-pointer items-center gap-3 rounded-sm px-2.5 outline-none',
                          'data-[highlighted]:bg-surface-hover',
                        )}
                      >
                        <command.icon
                          aria-hidden
                          className="h-icon-md w-icon-md shrink-0 text-text-tertiary"
                        />
                        <span className="min-w-0 flex-1 truncate text-base text-text-primary">
                          {command.label}
                        </span>
                      </BaseCombobox.Item>
                    )}
                  </BaseCombobox.Collection>
                </BaseCombobox.Group>
              )}
            </BaseCombobox.List>

            {/* Permanent, not conditional. The two keys a first-time user needs
                were shown only on the highlighted row and inside the input, so
                arrows were never named at all. */}
            <div className="flex items-center gap-4 border-t border-border bg-surface-sunken px-4 py-2 text-2xs text-text-tertiary">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> {t('shell.navigate') || 'navigate'}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> {t('shell.open') || 'open'}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>{t('shell.esc') || 'Esc'}</Kbd> {t('shell.close') || 'close'}
              </span>
            </div>
          </BaseCombobox.Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
