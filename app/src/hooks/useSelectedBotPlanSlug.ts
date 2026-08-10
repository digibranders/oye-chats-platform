import { useEffect, useState } from 'react';
import { getCreditBalance } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useEntitlements } from './useEntitlements';

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
 * the fields anyway, leaving an empty panel and a button that 403s. Mirrors
 * `is_visitor_intelligence_enabled_for_bot` on the server.
 *
 * Falls back to the account slug when the agent has no subscription of its own
 * (matching the backend's `get_bot_entitlements` account fallback), and returns
 * `null` while still loading so callers can hold the gate closed rather than
 * flashing paid UI.
 */
export function useSelectedBotPlanSlug(): string | null {
  const { selectedBot } = useBotContext();
  const { planSlug: accountSlug, loading: entitlementsLoading } = useEntitlements();
  const [botSlugs, setBotSlugs] = useState<Record<number, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCreditBalance()
      .then((raw) => {
        if (cancelled) return;
        const rows = Array.isArray(raw?.bots) ? raw.bots : [];
        const next: Record<number, string> = {};
        for (const row of rows) {
          const record = (row ?? {}) as Record<string, unknown>;
          const id = Number(record.bot_id);
          const slug = record.plan_slug;
          if (id && typeof slug === 'string' && slug) next[id] = slug;
        }
        setBotSlugs(next);
      })
      .catch(() => {
        // Per-bot lookup unavailable - fall back to the account slug below.
        if (!cancelled) setBotSlugs({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (entitlementsLoading || botSlugs === null) return null;
  if (selectedBot) {
    const perBot = botSlugs[selectedBot.id];
    if (perBot) return perBot;
  }
  return accountSlug ?? null;
}

export default useSelectedBotPlanSlug;
