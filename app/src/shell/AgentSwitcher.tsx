import { useNavigate } from 'react-router-dom';
import { Combobox, Skeleton } from '../ui';
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
 * another. It therefore takes the id from the URL and the chatbot itself only
 * when the list has arrived; while it has not, the trigger holds a placeholder
 * rather than the rail rewriting itself a frame later.
 *
 * `size="sm"` puts its text at x=18 — the rail's glyph column, and the same
 * left edge as every group label. At `md` it started at 20, which was a fourth
 * text edge in a column that already had too many. It carries no "New chatbot"
 * button of its own either: the Chatbots group label owns that action in
 * workspace scope, and one action wants one affordance.
 */
export function AgentSwitcher({
  agentId,
  agent,
  onNavigate,
}: {
  agentId: string;
  agent: Bot | null;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const { bots } = useBotContext();

  if (!agent) {
    return (
      <div className="flex h-control-sm items-center rounded-md border border-rail-border bg-rail-hover px-2.5">
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }

  return (
    <Combobox
      size="sm"
      label="Chatbot"
      value={agentId}
      placeholder="Select a chatbot"
      searchPlaceholder="Find a chatbot…"
      emptyMessage="No chatbots match"
      options={bots.map((bot) => ({
        value: String(bot.id),
        label: bot.name ?? `Chatbot ${bot.id}`,
        description: bot.bot_key ?? undefined,
      }))}
      onValueChange={(next) => {
        if (!next || next === agentId) return;
        onNavigate?.();
        navigate(agentPath(next, 'overview'));
      }}
      className="border-rail-border bg-rail-hover text-rail-text hover:border-rail-text-muted"
    />
  );
}
