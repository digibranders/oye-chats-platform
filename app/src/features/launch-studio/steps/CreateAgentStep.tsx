import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { createBot, updateBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 2 — Create Agent. Names the agent. Creates a new bot, or (for a returning
 * user with an existing agent) renames the selected one — the field stays
 * editable so the name is never locked.
 */
export function CreateAgentStep(props: StepProps) {
  const { selectedBot, selectBot, refreshBots } = useBotContext();
  const [name, setName] = useState(selectedBot?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setError(null);
    try {
      if (selectedBot) {
        // Existing agent — rename it if the name changed, then continue.
        if (trimmed !== selectedBot.name) {
          await updateBot(selectedBot.id, { name: trimmed });
          await refreshBots();
        }
      } else {
        const bot = await createBot({ name: trimmed });
        await refreshBots();
        selectBot(bot);
        void recordActivationEvent('bot_created', { botId: bot.id });
      }
      props.onContinue();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save your agent. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StepShell
      title="Create your agent"
      description="Give your AI agent a name. You can change it anytime."
      onBack={props.onBack}
      onContinue={handleContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={name.trim().length > 0 && !submitting}
      continueLabel={submitting ? 'Saving…' : undefined}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Agent name
          </span>
          <div className="relative">
            <Bot
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Support Assistant"
              className="pl-9"
              disabled={submitting}
              autoFocus
            />
          </div>
        </label>

        {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}

        <Card className="p-4">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            This is the name visitors see at the top of the chat. Keep it short and friendly —
            “Support”, “Ava”, or your brand name all work well.
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
