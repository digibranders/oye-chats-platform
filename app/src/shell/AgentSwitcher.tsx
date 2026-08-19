import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Combobox } from '../ui';
import { useBotContext } from '../context/BotContext';
import { agentPath } from './nav';
import type { Bot } from '../types/domain';

/**
 * Which chatbot the agent scope is showing.
 *
 * A searchable combobox rather than a list, because the rail must not grow with
 * the account — a workspace with twenty chatbots is a workspace we sold to, not
 * an edge case.
 *
 * **It navigates; it does not set a separate "selected" state.** The chatbot is
 * in the URL, and the URL is the only scope the agent pages read. The system
 * this replaces kept a shell-level selection beside the URL one, and the two
 * disagreeing is what let a user configure one chatbot while chatting with
 * another.
 */
export function AgentSwitcher({ current, onNavigate }: { current: Bot; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { bots } = useBotContext();

  return (
    <div className="space-y-1.5">
      <Combobox
        label="Chatbot"
        value={String(current.id)}
        placeholder="Select a chatbot"
        searchPlaceholder="Find a chatbot…"
        emptyMessage="No chatbots match"
        options={bots.map((bot) => ({
          value: String(bot.id),
          label: bot.name ?? `Chatbot ${bot.id}`,
          description: bot.bot_key ?? undefined,
        }))}
        onValueChange={(next) => {
          if (!next || next === String(current.id)) return;
          onNavigate?.();
          navigate(agentPath(next, 'overview'));
        }}
        className="border-rail-border bg-rail-hover text-rail-text hover:border-rail-text-muted"
      />
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          navigate('/chatbots?new=1');
        }}
        className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-rail-text-muted transition-colors hover:text-rail-text"
      >
        <Plus aria-hidden className="h-3 w-3 shrink-0" />
        New chatbot
      </button>
    </div>
  );
}
