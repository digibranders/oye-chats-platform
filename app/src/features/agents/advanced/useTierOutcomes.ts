import { useCallback, useEffect, useState } from 'react';
import { getClientSettings, getWebhooks } from '../../../services/api';
import type { Webhook } from '../../../types/domain';
import { listeningWebhooks, qualifiedLeadRecipients } from './tierOutcomes';

export interface TierOutcomeFacts {
  /** `Bot.email_on_qualified` — the master switch on the SQL email. */
  emailEnabled: boolean;
  /** Who would receive it, resolved exactly as the server resolves it. */
  recipients: string[];
  /** Registered webhooks, active and subscribed to `tier_transition`. */
  webhooks: Webhook[];
  /** Registered webhooks that exist but would not hear a tier change. */
  silentWebhooks: number;
}

export interface TierOutcomesState {
  facts: TierOutcomeFacts | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Load the live outcome facts for a chatbot.
 *
 * It fetches independently of the page's own draft on purpose. Both halves are
 * configured on *other* surfaces — recipients on Experience, webhooks in
 * Settings ▸ Integrations — so a customer who fixes one in another tab must be
 * able to refresh this panel alone, without discarding an unsaved rubric to do
 * it.
 */
export function useTierOutcomes(agentId: number | null): TierOutcomesState {
  const [facts, setFacts] = useState<TierOutcomeFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [loadedAgentId, setLoadedAgentId] = useState<number | null>(agentId);
  if (agentId !== loadedAgentId) {
    setLoadedAgentId(agentId);
    setFacts(null);
    setError(null);
  }

  useEffect(() => {
    if (agentId === null) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [settings, hooks] = await Promise.all([
          getClientSettings(agentId),
          // A workspace without the webhooks entitlement still gets an empty
          // list rather than a failed panel: the email half of this answer is
          // useful on every plan, and one 403 must not hide it.
          getWebhooks(agentId).catch(() => [] as Webhook[]),
        ]);
        if (cancelled) return;
        const listening = listeningWebhooks(hooks);
        setFacts({
          emailEnabled: settings.email_on_qualified !== false,
          recipients: qualifiedLeadRecipients(settings),
          webhooks: listening,
          silentWebhooks: hooks.length - listening.length,
        });
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error && cause.message
            ? cause.message
            : 'We could not check what fires at each tier.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  return {
    facts,
    loading: agentId !== null && facts === null && error === null,
    error,
    retry,
  };
}
