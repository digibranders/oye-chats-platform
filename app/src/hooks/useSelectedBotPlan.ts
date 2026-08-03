import { useEffect, useState } from 'react';
import { getCreditBalance } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useEntitlements } from './useEntitlements';

/**
 * useSelectedBotPlan - the plan name to display for the agent currently picked
 * in the shell switcher.
 *
 * Per-agent plans come from the credit-balance payload (each agent carrying its
 * own subscription reports its `plan_name`); an agent that draws on the shared
 * workspace plan falls back to the account plan from entitlements. Returns
 * `null` until something resolves, so callers can omit the chip while loading.
 */
export function useSelectedBotPlan(): string | null {
  const { selectedBot } = useBotContext();
  const { planName: accountPlan } = useEntitlements();
  const [botPlans, setBotPlans] = useState<Record<number, string>>({});

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
          const name = record.plan_name;
          if (id && typeof name === 'string' && name) next[id] = name;
        }
        setBotPlans(next);
      })
      .catch(() => {
        /* fall back to the account plan */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const perBotPlan = selectedBot ? botPlans[selectedBot.id] : undefined;
  return perBotPlan ?? accountPlan ?? null;
}

export default useSelectedBotPlan;
