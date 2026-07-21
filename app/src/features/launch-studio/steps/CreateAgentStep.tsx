import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { createBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 2 — Create Agent. Creates the bot (or reuses an already-selected one) and
 * makes it the active agent for the rest of the flow.
 */
export function CreateAgentStep(props: StepProps) {
  const { selectedBot, selectBot, refreshBots } = useBotContext();
  const [name, setName] = useState(selectedBot?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    // Already have an agent (returning user, or came back to this step) — reuse it.
    if (selectedBot) {
      props.onContinue();
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setError(null);
    try {
      const bot = await createBot({ name: trimmed });
      await refreshBots();
      selectBot(bot);
      void recordActivationEvent('bot_created', { botId: bot.id });
      props.onContinue();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create your agent. Please try again.',
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
      canContinue={(Boolean(selectedBot) || name.trim().length > 0) && !submitting}
      continueLabel={submitting ? 'Creating…' : undefined}
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
              disabled={Boolean(selectedBot) || submitting}
              autoFocus
            />
          </div>
        </label>

        {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}

        <Card className="p-4">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            {selectedBot
              ? `Continuing with your agent “${selectedBot.name}”.`
              : 'This is the name visitors see at the top of the chat. Keep it short and friendly.'}
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
