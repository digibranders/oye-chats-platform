import { useQuery } from '@tanstack/react-query';
import { getLeadStats } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { keys } from '../query/keys';
import { agentPath } from '../shell/nav';
import type { Bot } from '../types/domain';
import { t as translateNow } from '../i18n/i18n';

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
/** Seeded on every new chatbot (`Bot.primary_color` / `Bot.avatar_type`). */
const DEFAULT_PRIMARY_COLOR = '#ba68c8';
const DEFAULT_AVATAR_TYPE = 'upload';

export function useSetupChecklist() {
  const { bots, loading: botsLoading } = useBotContext();

  // The first chatbot is the one onboarding is about. A workspace that already
  // has several is past this checklist by definition.
  const primary: Bot | null = bots[0] ?? null;

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

  const indexedChunks = Number(primary?.indexed_chunk_count ?? 0);
  const capturedLeads = Number(leads.data?.total ?? 0);
  // "Make it yours" ticked on every chatbot ever created, because
  // `avatar_type` is a STYLE SELECTOR with a default of `'upload'`, not a
  // record of anyone having chosen anything. `Boolean(bot_logo || avatar_type)`
  // was therefore true from the moment the row existed, and the checklist
  // struck the step through on a chatbot still carrying the seeded colour and
  // no avatar at all.
  //
  // What actually answers it: the customer set or removed an avatar
  // (`bot_logo_source === 'manual'`), picked a style other than the default, or
  // moved the brand colour off the seeded one. A crawl-DERIVED favicon is
  // deliberately not enough — the product did that, not them.
  const branded =
    primary?.bot_logo_source === 'manual' ||
    (primary?.avatar_type ?? DEFAULT_AVATAR_TYPE) !== DEFAULT_AVATAR_TYPE ||
    (primary?.primary_color ?? DEFAULT_PRIMARY_COLOR).toLowerCase() !== DEFAULT_PRIMARY_COLOR;
  const installed = Boolean(primary?.widget_installed_at);

  // Every step carries one. Two of the six used to pass `''`, so the checklist
  // drew four 75px rows and two 55px ones down a single card — and one of the
  // four ended in a full stop while the other three did not. They are labels,
  // not sentences: no terminal punctuation, and none of them optional.
  const steps: SetupStep[] = [
    {
      id: 'create',
      label: translateNow('onboarding.createYourChatbot') || 'Create your chatbot',
      description: translateNow('onboarding.nameItPointItAt') || 'Name it, point it at your site',
      done: bots.length > 0,
      to: '/welcome',
    },
    {
      id: 'train',
      label: translateNow('onboarding.giveItSomethingToKnow') || 'Give it something to know',
      description: translateNow('onboarding.crawlYourSiteOrUpload') || 'Crawl your site or upload documents',
      done: indexedChunks > 0,
      to: primary ? agentPath(primary.id, 'knowledge') : '/chatbots',
    },
    {
      id: 'brand',
      label: translateNow('onboarding.makeItYours') || 'Make it yours',
      description: translateNow('onboarding.yourColoursYourAvatarYour') || 'Your colours, your avatar, your greeting',
      done: branded,
      to: primary ? agentPath(primary.id, 'experience') : '/chatbots',
    },
    {
      id: 'install',
      label: translateNow('onboarding.putItOnYourWebsite') || 'Put it on your website',
      description: translateNow('onboarding.oneScriptTag') || 'One script tag',
      done: installed,
      to: primary ? agentPath(primary.id, 'deploy') : '/chatbots',
    },
    {
      id: 'lead',
      label: translateNow('onboarding.captureYourFirstLead') || 'Capture your first lead',
      description: translateNow('onboarding.happensOnItsOwn') || 'Happens on its own',
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
