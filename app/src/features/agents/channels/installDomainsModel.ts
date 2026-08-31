/**
 * The per-domain install inventory, as pure data.
 *
 * The card this feeds used to answer one bit — has any page anywhere ever
 * loaded this chatbot — from a single first-seen stamp, plus one overwritten
 * hostname it was careful to label as unproven. That answers "did my first
 * paste work" and nothing after it.
 *
 * Two signals arrive per domain and they are not interchangeable, so the
 * wording is derived here rather than left to the component:
 *
 * - **Observed** — a real browser on a real page loaded the widget. The
 *   strongest evidence there is, and the only one that survives a site whose
 *   snippet is injected by JavaScript.
 * - **Probed** — we fetched the page ourselves and read the served HTML. The
 *   only signal that can report an *absent* snippet, and the only one that can
 *   see a widget belonging to a different chatbot. Blind to anything a tag
 *   manager adds after load.
 *
 * Where they disagree, observation wins (see `_domain_state` in
 * `api/app/api/bot_routes.py`, which does the collapse server-side). What is
 * left here is turning a state into words a customer can act on.
 */
import type { Tone } from '../../../ui';
import { t as translateNow } from '../../../i18n/i18n';

export type DomainState = 'live' | 'installed' | 'missing' | 'unreachable' | 'unchecked';

export interface DomainInstall {
  hostname: string;
  state: DomainState;
  observed_first_at: string | null;
  observed_last_at: string | null;
  probe_status: string | null;
  probe_checked_at: string | null;
  probe_detail: string | null;
  /** Another chatbot's key, when the probe found one instead of this bot's. */
  other_chatbot: string | null;
  /** Whether the allow-list would admit this origin today. */
  allowed: boolean;
}

export interface InstallDomains {
  domains: DomainInstall[];
  checking: boolean;
  last_checked_at: string | null;
}

export interface DomainPresentation {
  label: string;
  tone: Tone;
  detail: string;
  /** True when this row is the reason the customer should keep reading. */
  needsAttention: boolean;
}

export function describeDomain(domain: DomainInstall): DomainPresentation {
  // Checked first, and independently of the state, because it is the one
  // finding that is a problem on an otherwise perfect install: the widget is
  // working today and stops the moment enforcement is switched on.
  if (domain.state === 'live' && !domain.allowed) {
    return {
      label: translateNow('agents.liveButNotAllowed') || 'Live, but not on your allow-list',
      tone: 'warning',
      detail:
        translateNow('agents.liveButNotAllowedDetail') ||
        'Visitors are using it here now. Turning on domain restriction would block this site until you add it.',
      needsAttention: true,
    };
  }

  switch (domain.state) {
    case 'live':
      return {
        label: translateNow('agents.live') || 'Live',
        tone: 'success',
        detail:
          translateNow('agents.liveDomainDetail') ||
          'Real visitors have loaded your chatbot on this domain.',
        needsAttention: false,
      };
    case 'installed':
      return {
        label: translateNow('agents.snippetFound') || 'Snippet found',
        tone: 'success',
        detail:
          translateNow('agents.snippetFoundDetail') ||
          'We fetched this page and your snippet is on it. No visitor has opened the chatbot here yet.',
        needsAttention: false,
      };
    case 'missing':
      // Two quite different findings share this state, so they must not share
      // a sentence. Telling someone their snippet is missing when what we
      // actually found was a colleague's chatbot sends them to re-paste a
      // snippet that is not the problem.
      if (domain.other_chatbot) {
        return {
          label: translateNow('agents.differentChatbot') || 'A different chatbot',
          tone: 'warning',
          detail:
            translateNow('agents.differentChatbotDetail') ||
            'This page is running an OyeChats widget for another chatbot, not this one.',
          needsAttention: true,
        };
      }
      return {
        label: translateNow('agents.snippetNotFound') || 'Snippet not found',
        tone: 'warning',
        detail:
          domain.probe_detail ||
          translateNow('agents.snippetNotFoundDetail') ||
          'We fetched this page and the snippet was not in it.',
        needsAttention: true,
      };
    case 'unreachable':
      return {
        label: translateNow('agents.couldNotCheck') || 'Could not check',
        tone: 'neutral',
        detail:
          domain.probe_detail ||
          translateNow('agents.couldNotCheckDetail') ||
          'We could not load this domain. That is often a login wall or a firewall, not a broken install.',
        // Deliberately not attention-worthy. We failed to look; that is our
        // problem to describe, not a fault the customer must go and fix.
        needsAttention: false,
      };
    default:
      return {
        label: translateNow('agents.notCheckedYet') || 'Not checked yet',
        tone: 'neutral',
        detail:
          translateNow('agents.notCheckedYetDetail') ||
          'On your allow-list. Nothing has loaded from here and we have not looked yet.',
        needsAttention: false,
      };
  }
}

/** One line summarising the whole inventory, for the section heading. */
export function summariseDomains(domains: readonly DomainInstall[]): string {
  if (domains.length === 0) return translateNow('agents.noDomainsYet') || 'No domains yet';

  const live = domains.filter((d) => d.state === 'live' || d.state === 'installed').length;
  const problems = domains.filter((d) => describeDomain(d).needsAttention).length;

  if (problems > 0) {
    return (
      translateNow('agents.domainsNeedAttention') ||
      `${live} of ${domains.length} working · ${problems} need attention`
    ).replace('{live}', String(live)).replace('{total}', String(domains.length)).replace('{problems}', String(problems));
  }
  if (live === domains.length) {
    return (translateNow('agents.allDomainsWorking') || `Working on all ${domains.length}`).replace(
      '{total}',
      String(domains.length),
    );
  }
  return (translateNow('agents.someDomainsWorking') || `${live} of ${domains.length} working`)
    .replace('{live}', String(live))
    .replace('{total}', String(domains.length));
}

/** Rows first that a customer has to make a decision about. */
export function sortDomains(domains: readonly DomainInstall[]): DomainInstall[] {
  return [...domains].sort((a, b) => {
    const aAttention = describeDomain(a).needsAttention ? 0 : 1;
    const bAttention = describeDomain(b).needsAttention ? 0 : 1;
    if (aAttention !== bAttention) return aAttention - bAttention;
    return a.hostname.localeCompare(b.hostname);
  });
}
