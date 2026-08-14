import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { createBot, updateBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { requiresSubscription } from '../../../utils/apiErrors';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 2 - Create Agent. Names the agent. Creates a new bot, or (for a returning
 * user with an existing agent) renames the selected one - the field stays
 * editable so the name is never locked.
 *
 * Create-vs-rename keys on `selectedBot`, never on what the field happens to
 * contain. That makes the bot list's load state load-bearing: `selectedBot` is
 * null for EVERY user until `BotContext` resolves, so acting on it early would
 * mint a duplicate chatbot for someone who already owns one.
 */
export function CreateAgentStep(props: StepProps) {
  const {
    bots,
    selectedBot,
    selectBot,
    refreshBots,
    loading: botsLoading,
    error: botsError,
  } = useBotContext();
  const { openUpgradeModal } = useUpgradeModal();
  const { planName } = useEntitlements();
  const [name, setName] = useState(() => selectedBot?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Has the user typed in the name field? A ref, not state: it gates the
  // prefill effect below and must never re-trigger it.
  const nameEdited = useRef(false);
  // Mirrors `submitting` for the re-entrancy guard in `handleContinue`, which
  // has to hold before React can re-render the button into its disabled state.
  const inFlight = useRef(false);

  const namePrefill = selectedBot?.name ?? '';

  // `selectedBot` resolves asynchronously, so a one-shot `useState` initialiser
  // would be computed from `undefined` on a fresh load of this route and never
  // correct itself. Sync when the agent arrives, but never over the top of
  // something the user typed.
  useEffect(() => {
    if (nameEdited.current || !namePrefill) return;
    setName(namePrefill);
  }, [namePrefill]);

  /**
   * True once the bot list is known to be accurate.
   *
   * `selectedBot === null` is ambiguous while the list is loading or after it
   * failed: it means "no agent" only when the fetch actually succeeded (see
   * `BotContext.refreshBots`, which resolves to a concrete bot whenever any
   * exist). Continuing on the ambiguous null takes the create branch and mints
   * a duplicate chatbot - unbounded on a plan with unlimited agents.
   */
  const botsResolved = !botsLoading && !botsError;

  const handleContinue = async () => {
    // Re-entrancy: a double-click or a slow response must not create twice.
    if (inFlight.current) return;
    // Never guess create-vs-rename from an unresolved bot list.
    if (!botsResolved) return;

    const trimmed = name.trim();
    // Only a genuinely new account needs a name up front - there is nothing to
    // rename yet. A returning user always continues, blank field or not.
    if (!selectedBot && !trimmed) return;

    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (selectedBot) {
        // Existing agent - rename it if the name changed, then continue. A
        // blank field means "leave the name alone", never a rename to nothing.
        if (trimmed && trimmed !== selectedBot.name) {
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
      if (requiresSubscription(err)) {
        // Should only happen for a returning visitor who lands back on
        // onboarding with an existing bot already on the account - route to
        // the same upgrade modal every other paywall gate uses instead of a
        // raw error.
        openUpgradeModal('add_bot', { current: bots.length, planName });
      } else {
        setError(
          err instanceof Error ? err.message : 'Could not save your chatbot. Please try again.',
        );
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <StepShell
      title="Create your chatbot"
      description="Give your AI chatbot a name. You can change it anytime."
      onBack={props.onBack}
      onContinue={handleContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={botsResolved && !submitting && (Boolean(selectedBot) || name.trim().length > 0)}
      continueLabel={submitting ? 'Saving…' : botsLoading ? 'Loading…' : undefined}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Chatbot name
          </span>
          <div className="relative">
            <Bot
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
            <Input
              value={name}
              onChange={(event) => {
                nameEdited.current = true;
                setName(event.target.value);
              }}
              placeholder="Support Assistant"
              className="pl-9"
              disabled={submitting}
              autoFocus
            />
          </div>
        </label>

        {botsError && (
          <p className="text-[12px] text-[var(--ds-danger)]">
            We couldn&apos;t load your existing chatbots. Refresh the page and try again - continuing
            now could create a duplicate.
          </p>
        )}

        {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}

        <Card className="p-4">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            This is the name visitors see at the top of the chat. Keep it short and friendly -
            “Support”, “Ava”, or your brand name all work well.
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
