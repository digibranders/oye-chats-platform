import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getApiBaseUrl,
  getBot,
  recordActivationEvent,
  updateBot,
} from '../../../services/api';
import { keys } from '../../../query/keys';
import { useAgent } from '../../../context/AgentContext';
import { useBotContext } from '../../../context/BotContext';
import { getEmbedEnvironment } from './embedEnvironment';
import { VERIFY_POLL_MS, VERIFY_TIMEOUT_MS, installStatus, type InstallStatus } from './deployModel';
import type { PlatformEnv } from '../../../data/platformIntegrations';
import type { Bot } from '../../../types/domain';

/**
 * The chatbot record as this surface reads it.
 *
 * `getBot` returns the full row; the shared `Bot` type is the lightweight list
 * shape. These four fields are the ones Deploy owns and the list omits.
 */
export interface DeployBot extends Bot {
  allowed_domains?: string[] | null;
  domain_check_enabled?: boolean | null;
  session_share_domain?: string | null;
  branding_text?: string | null;
  branding_url?: string | null;
  /** Who the install briefing was last emailed to, and when. */
  dev_invite_email?: string | null;
  dev_invite_sent_at?: string | null;
}

/** Why a section cannot be shown, when it cannot. */
export type LoadFailure = { kind: 'forbidden' } | { kind: 'error'; message: string };

function toFailure(error: unknown): LoadFailure {
  const status = (error as { status?: number } | null)?.status;
  if (status === 403 || status === 404) return { kind: 'forbidden' };
  return {
    kind: 'error',
    message: error instanceof Error ? error.message : 'We could not load this chatbot.',
  };
}

/**
 * "I have added it" is a claim about what the person in front of us just did,
 * not a fact about the workspace, so it is the one thing here that is genuinely
 * local. It is kept per chatbot and per browser on purpose, and it is only ever
 * allowed to make the page work *harder* — it can turn a neutral "waiting" into
 * a troubleshooting checklist, and it can never mark anything installed. The
 * install fact itself is always the server's `widget_installed_at`, which is why
 * this cannot repeat the previous onboarding's mistake of storing progress in
 * `localStorage` and then believing it.
 */
const CLAIM_PREFIX = 'oyechats.deploy.claimed.';

function readClaim(botId: number): boolean {
  try {
    return window.localStorage.getItem(`${CLAIM_PREFIX}${botId}`) === '1';
  } catch {
    // Private mode, blocked storage, or no window. The page degrades to
    // "waiting", which is the honest default.
    return false;
  }
}

function writeClaim(botId: number, claimed: boolean): void {
  try {
    if (claimed) window.localStorage.setItem(`${CLAIM_PREFIX}${botId}`, '1');
    else window.localStorage.removeItem(`${CLAIM_PREFIX}${botId}`);
  } catch {
    // Non-fatal: the claim is a nicety, the install state is server-derived.
  }
}

export interface DeployData {
  agentId: number | null;
  /** The full record, once loaded. */
  bot: DeployBot | null;
  loading: boolean;
  failure: LoadFailure | null;
  retry: () => void;

  /** Which bundle the snippets quote, and the backend they will talk to. */
  env: PlatformEnv;
  apiBaseUrl: string;

  /** The install state machine, already resolved. */
  status: InstallStatus;
  /** Set the moment we first see the widget, so we can say "just now". */
  verifiedNow: boolean;
  checking: boolean;
  /** The customer says the snippet is on their site: start looking. */
  startVerifying: () => void;
  /** They would rather come back to it. Clears the claim, back to "waiting". */
  stopVerifying: () => void;

  /** Persist a partial chatbot update and re-read the normalised result. */
  save: (patch: Record<string, unknown>) => Promise<DeployBot>;
  saving: boolean;
}

/**
 * Everything Deploy needs, in one place.
 *
 * The chatbot is read through TanStack Query so that the same record is shared
 * with every other agent surface rather than re-fetched per section, and every
 * save invalidates it rather than each section keeping its own copy — the four
 * sections on this page all write to the same row, and three private caches of
 * one row is how a saved value reappears as the old one after a tab switch.
 */
export function useDeployData(): DeployData {
  const { agent, loading: agentLoading } = useAgent();
  const { refreshBots } = useBotContext();
  const queryClient = useQueryClient();
  const agentId = agent?.id ?? null;

  const apiBaseUrl = getApiBaseUrl();
  const env = useMemo(() => getEmbedEnvironment(apiBaseUrl), [apiBaseUrl]);

  /**
   * Verification is three pieces of state and everything else is derived.
   *
   * `claimSeed` is what the customer told us ("I have added it"), read back from
   * storage. `verifyStartedAt` marks a window in which we are actively polling,
   * and `expired` closes that window. Whether we are *checking*, whether the
   * install was *just* confirmed, and whether the claim still stands are all
   * functions of those three plus the server's stamp — none of them is a second
   * copy of a fact, so none of them can disagree with the server.
   */
  const [claimSeed, setClaimSeed] = useState(false);
  const [verifyStartedAt, setVerifyStartedAt] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);

  /**
   * The last install stamp we have actually seen, and which chatbot it was for.
   *
   * Carrying the id is what separates *observing a transition* from *loading a
   * chatbot that was already live*: without it the activation event would fire
   * on every page load of an installed chatbot, and again on every switch
   * between two of them. Written only from the effect below.
   */
  const seen = useRef<{ botId: number; stamp: string | null } | null>(null);

  // Reseed whenever the chatbot changes. Done during render from the id rather
  // than synced by an effect, so switching chatbots cannot leave one bot's claim
  // showing on another's page for a frame.
  const [seededFor, setSeededFor] = useState<number | null>(null);
  if (agentId != null && seededFor !== agentId) {
    setSeededFor(agentId);
    setClaimSeed(readClaim(agentId));
    setVerifyStartedAt(null);
    setExpired(false);
  }

  const query = useQuery({
    queryKey: keys.agents.detail(agentId ?? 0),
    queryFn: () => getBot(agentId as number) as Promise<DeployBot>,
    enabled: agentId != null,
    staleTime: 30_000,
    retry: false,
    // While we are actively looking for the widget, ask again on a timer. The
    // customer is standing in front of the page waiting for it to change, and a
    // "check again" button they have to keep pressing is exactly the dead end
    // the old wizard's blocking verification step shipped.
    refetchInterval: verifyStartedAt != null && !expired ? VERIFY_POLL_MS : false,
  });

  const bot = query.data ?? null;
  const installedAt = bot?.widget_installed_at ?? null;

  const checking = verifyStartedAt != null && !expired && !installedAt;
  // "Just now" only ever means a window we opened and a stamp that arrived
  // inside it. An already-installed chatbot loading fresh is not a celebration.
  const verifiedNow = verifyStartedAt != null && Boolean(installedAt);
  const claimed = claimSeed && !installedAt;

  // Close the verification window when it runs out. A separate clock from the
  // poll, so a request that fails or hangs cannot leave the page saying "looking
  // for your widget" forever.
  useEffect(() => {
    if (verifyStartedAt == null) return undefined;
    const remaining = Math.max(0, verifyStartedAt + VERIFY_TIMEOUT_MS - Date.now());
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [verifyStartedAt]);

  // The transition itself: null → stamped. This talks to external systems only
  // — storage, analytics, and the chatbot list the rail reads — because every
  // piece of local state it would otherwise set is derived above instead.
  useEffect(() => {
    if (agentId == null || !query.isSuccess) return;
    const previous = seen.current;
    seen.current = { botId: agentId, stamp: installedAt };
    const transitioned =
      previous != null && previous.botId === agentId && !previous.stamp && Boolean(installedAt);
    if (!transitioned) return;

    writeClaim(agentId, false);
    void recordActivationEvent('install_verified', { botId: agentId });
    // The setup checklist and the rail's progress ring read the chatbot list,
    // not this query, so the moment the widget goes live they have to be told.
    void refreshBots();
  }, [agentId, query.isSuccess, installedAt, refreshBots]);

  const refetch = query.refetch;
  const startVerifying = useCallback(() => {
    if (agentId == null) return;
    writeClaim(agentId, true);
    setClaimSeed(true);
    setExpired(false);
    setVerifyStartedAt(Date.now());
    void refetch();
  }, [agentId, refetch]);

  const stopVerifying = useCallback(() => {
    if (agentId == null) return;
    writeClaim(agentId, false);
    setClaimSeed(false);
    setVerifyStartedAt(null);
    setExpired(false);
  }, [agentId]);

  const mutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>): Promise<DeployBot> => {
      if (agentId == null) throw new Error('No chatbot selected.');
      await updateBot(agentId, patch);
      // `PATCH /bots/{id}` returns a message, not the row, and it normalises
      // what it stores (domains lose their scheme and their `www.`), so the
      // only honest thing to show afterwards is a re-read.
      return (await getBot(agentId)) as DeployBot;
    },
    onSuccess: (fresh) => {
      if (agentId != null) queryClient.setQueryData(keys.agents.detail(agentId), fresh);
      void refreshBots();
    },
  });

  const save = useCallback(
    (patch: Record<string, unknown>) => mutation.mutateAsync(patch),
    [mutation],
  );

  const status = installStatus({ installedAt, claimed, checking });

  return {
    agentId,
    bot,
    loading: agentLoading || (agentId != null && query.isPending),
    failure: query.isError ? toFailure(query.error) : null,
    retry: () => void query.refetch(),
    env,
    apiBaseUrl,
    status,
    verifiedNow,
    checking,
    startVerifying,
    stopVerifying,
    save,
    saving: mutation.isPending,
  };
}
