import { useBotContext } from '../context/BotContext';

/**
 * useSelectedBotPlan - the plan name to display for the agent currently picked
 * in the shell switcher.
 *
 * Both this and {@link useSelectedBotPlanSlug} read `Bot.plan_name` /
 * `Bot.plan_slug`, resolved together server-side by `bot_plan()` in
 * `bot_routes.py`, so the chip can never disagree with the feature switch
 * beside it.
 *
 * This used to derive the name from the credit-balance payload, which lists
 * only agents holding their own ledger. A Free agent has none, so it fell back
 * to the ACCOUNT plan name — and a Free agent in a workspace that also owns a
 * Professional one sat under a "Professional" chip while every paid control
 * around it was (correctly) locked.
 *
 * Returns `null` until the bot list resolves, so callers can omit the chip
 * rather than flash the wrong plan.
 */
export function useSelectedBotPlan(): string | null {
  const { selectedBot, loading } = useBotContext();

  if (loading) return null;
  return selectedBot?.plan_name ?? null;
}

export default useSelectedBotPlan;
