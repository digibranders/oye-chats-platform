import { useQuery } from '@tanstack/react-query';
import { getDashboardStats, getLeadStats } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { keys } from '../query/keys';
import { agentPath } from '../shell/nav';
import type { Bot } from '../types/domain';

export interface SetupStep {
  id: string;
  label: string;
  /** One clause, only where the label cannot carry it. Empty when it can. */
  description: string;
  done: boolean;
  /** Where the step is actually performed. Never a wizard screen. */
  to: string;
}

/**
 * The setup checklist.
 *
 * Two decisions carry the whole design.
 *
 * **Every step is derived from server state, not from a stored flag.** The flow
 * this replaces recorded progress in `localStorage`, which meant it could — and
 * did — claim a step was done on one browser and not on another, survive a
 * logout into a different account on the same machine, and go on insisting on
 * "Resume setup" forever for anyone who finished by hand. Derived state cannot
 * lie about what is actually true of the workspace.
 *
 * **Three of the six facts are cumulative and can never regress**: a
 * conversation happened, the widget was seen live, a lead was captured. The
 * other three regress only if the user genuinely undoes the thing — deletes
 * every chatbot, deletes all its knowledge, resets its branding — which is the
 * correct behaviour, not flapping. There is deliberately no monotonic override
 * on top: a checklist that keeps claiming a chatbot is trained after its
 * knowledge base has been emptied is worse than one that tells the truth.
 *
 * The checklist never becomes a gate. Every step deep-links to the real surface
 * where that work is done, and the user can do them in any order or not at all.
 */
export function useSetupChecklist() {
  const { bots, loading: botsLoading } = useBotContext();

  // The first chatbot is the one onboarding is about. A workspace that already
  // has several is past this checklist by definition.
  const primary: Bot | null = bots[0] ?? null;

  const stats = useQuery({
    queryKey: keys.analytics.dashboard(primary?.id ?? null, null),
    queryFn: () => getDashboardStats(primary!.id),
    enabled: Boolean(primary),
    staleTime: 60_000,
  });

  const leads = useQuery({
    queryKey: keys.leads.stats(primary?.id ?? null, null),
    queryFn: () => getLeadStats(primary!.id),
    enabled: Boolean(primary),
    staleTime: 60_000,
    // A workspace whose plan does not include the leads dashboard gets a 403
    // here. That is not an error the user needs to see on a checklist — the
    // step simply stays open.
    retry: false,
  });

  const conversations = Number(stats.data?.total_conversations ?? 0);
  const indexedChunks = Number(primary?.indexed_chunk_count ?? 0);
  const capturedLeads = Number(leads.data?.total ?? 0);
  const branded = Boolean(primary?.bot_logo || primary?.avatar_type);
  const installed = Boolean(primary?.widget_installed_at);

  // Every step carries one. Two of the six used to pass `''`, so the checklist
  // drew four 75px rows and two 55px ones down a single card — and one of the
  // four ended in a full stop while the other three did not. They are labels,
  // not sentences: no terminal punctuation, and none of them optional.
  const steps: SetupStep[] = [
    {
      id: 'create',
      label: 'Create your chatbot',
      description: 'Name it, point it at your site',
      done: bots.length > 0,
      to: '/welcome',
    },
    {
      id: 'train',
      label: 'Give it something to know',
      description: 'Crawl your site or upload documents',
      done: indexedChunks > 0,
      to: primary ? agentPath(primary.id, 'knowledge') : '/chatbots',
    },
    {
      id: 'brand',
      label: 'Make it yours',
      description: 'Your colours, your avatar, your greeting',
      done: branded,
      to: primary ? agentPath(primary.id, 'experience') : '/chatbots',
    },
    {
      id: 'test',
      label: 'Ask it a question',
      description: 'See exactly what a visitor gets',
      done: conversations > 0,
      to: primary ? agentPath(primary.id, 'overview') : '/chatbots',
    },
    {
      id: 'install',
      label: 'Put it on your website',
      description: 'One script tag',
      done: installed,
      to: primary ? agentPath(primary.id, 'deploy') : '/chatbots',
    },
    {
      id: 'lead',
      label: 'Capture your first lead',
      description: 'Happens on its own',
      done: capturedLeads > 0,
      to: '/leads',
    },
  ];

  const done = steps.filter((step) => step.done).length;

  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    // Only the chatbot list gates the first paint. The two stat queries fill in
    // afterwards; showing a half-empty ring for a moment is better than showing
    // no rail footer at all while they resolve.
    loading: botsLoading,
  };
}
