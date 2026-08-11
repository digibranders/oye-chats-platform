import { useBotContext } from '../context/BotContext';

/**
 * useSelectedBotPlanSlug - the machine-readable plan slug for the agent
 * currently picked in the shell switcher.
 *
 * Sibling of {@link useSelectedBotPlan}, which returns the human plan NAME for
 * display. This returns the SLUG, because feature gates compare against slugs
 * (`'professional'`) and must never depend on a display string a super-admin
 * can rename in the Plans editor.
 *
 * Why per-bot matters: billing attaches to the Bot, not the Client, so one
 * workspace can hold a Professional agent and a Free agent at the same time.
 * The account-level `entitlements.plan_slug` deliberately reports the
 * HIGHEST-priced plan across all agents, so gating agent-scoped data on it
 * would unlock paid UI for a Free agent's leads — the backend would then strip
 * the fields anyway, leaving an empty panel and a button that 403s.
 *
 * The slug comes from `Bot.plan_slug`, resolved server-side by `bot_plan_slug()`
 * in `bot_routes.py` via the same `get_bot_entitlements` the server's own gates
 * use. This hook previously derived it from the credit-balance payload instead,
 * which lists only bots holding their own ledger — a Free agent has none, so it
 * was absent from the map and silently fell back to the account slug, unlocking
 * paid UI on exactly the agent the fallback was meant to protect.
 *
 * Returns `null` while the bot list is still loading so callers can hold the
 * gate closed rather than flashing paid UI.
 *
 * URL-scoped agent pages must NOT use this: it follows the shell switcher, not
 * `:agentId`. Those read `useAgent().agent?.plan_slug` directly.
 */
export function useSelectedBotPlanSlug(): string | null {
  const { selectedBot, loading } = useBotContext();

  if (loading) return null;
  return selectedBot?.plan_slug ?? null;
}

export default useSelectedBotPlanSlug;
