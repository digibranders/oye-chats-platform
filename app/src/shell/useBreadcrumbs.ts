import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
import { t as translateNow } from '../i18n/i18n';
import { useTranslation } from '../i18n/useTranslation';
import {
  ACCOUNT_SECTIONS,
  AGENT_NAV,
  FOOTER_NAV,
  NAV_SECTIONS,
  STANDALONE_CRUMBS,
  WORKSPACE_NAV,
  agentIdFromPath,
  agentPath,
} from './nav';

export interface Crumb {
  label: string;
  to?: string;
  /** The name has not arrived yet; render a placeholder rather than an id. */
  pending?: boolean;
}

/**
 * The trail, derived from the URL and the chatbot list.
 *
 * Derived rather than declared on each route, because a route can only carry a
 * static string: the previous shell's chatbot crumb was the literal word
 * "Chatbot", so on a twelve-chatbot workspace every configuration page read
 * `Home › AI Chatbots › Chatbot › Knowledge` and never said which one.
 *
 * **The chatbot is always named.** That is the whole point of this hook: the one
 * object a user can be configuring the wrong copy of is the one the chrome must
 * never leave anonymous. While its name is still in flight the crumb is marked
 * `pending` and the bar draws a placeholder, rather than printing `Chatbot 12`
 * and swapping it for `Northwind` a frame later.
 *
 * **The trail is never empty and never wrong.** It used to stop at the matched
 * top-level destination with the comment "the page owns its own title", which
 * meant `/billing/usage` rendered one crumb reading "Billing" — carrying
 * `aria-current="page"`, so the chrome told a screen-reader user the current
 * page was Billing while they were on Usage. Six more routes matched nothing at
 * all and rendered an empty `<ol>`, `/welcome` — the first screen a new
 * customer sees — among them.
 */
/** "API Keys" -> apiKeys, so the key survives a copy edit to the label. */
function crumbKey(crumb: string): string {
  const words = crumb.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

/**
 * A crumb's label in the reader's language.
 *
 * The nav config's English label is the KEY, not the output: the trail is
 * built from `nav.ts`, which is a module constant evaluated at import, before
 * any locale exists. Deriving the key from the label rather than storing one
 * beside it means a copy edit to a nav label cannot silently orphan its
 * translation — it resolves, or it falls back to the English that is already
 * there.
 *
 * A chatbot's own name is never passed through here. It is the customer's
 * text, and translating it would rename their chatbot on screen.
 */
function label(crumb: string): string {
  return translateNow(`app.crumb.${crumbKey(crumb)}`) || crumb;
}

export function useBreadcrumbs(): Crumb[] {
  const { pathname } = useLocation();
  const { bots } = useBotContext();
  // Re-render this hook's consumers when the language changes: the labels below
  // are resolved at call time, and nothing else on the bar would move.
  useTranslation();

  return useMemo(() => {
    const agentId = agentIdFromPath(pathname);

    if (agentId) {
      const agent = bots.find((bot) => String(bot.id) === agentId);
      const segment = pathname.split('/')[3] ?? 'overview';
      const tab = AGENT_NAV.find((item) => item.segment === segment);
      return [
        { label: label('Chatbots'), to: '/chatbots' },
        {
          label: agent?.name ?? label('Chatbot'),
          to: agentPath(agentId, 'overview'),
          pending: !agent,
        },
        ...(tab ? [{ label: label(tab.label) }] : []),
      ];
    }

    // Check if the path belongs to a multi-section area (analytics, billing, settings)
    const navSectionKey = Object.keys(NAV_SECTIONS).find(
      (key) => pathname === key || pathname.startsWith(`${key}/`),
    );

    if (navSectionKey) {
      const top = [...WORKSPACE_NAV, ...FOOTER_NAV].find((item) => item.to === navSectionKey);
      if (top) {
        const section = pathname.split('/')[2];
        const sectionLabel = section ? NAV_SECTIONS[navSectionKey]?.[section] : undefined;
        return sectionLabel
          ? [{ label: label(top.label), to: top.to }, { label: label(sectionLabel) }]
          : [{ label: label(top.label) }];
      }
    }

    const top = [...WORKSPACE_NAV, ...FOOTER_NAV].find((item) =>
      item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
    );

    if (top) {
      return [{ label: label(top.label) }];
    }

    // Your own account, onboarding, and the 404. None of them is in the rail,
    // which is exactly why the trail has to name them.
    if (pathname === '/account' || pathname.startsWith('/account/')) {
      const section = pathname.split('/')[2];
      const sectionLabel = section ? ACCOUNT_SECTIONS[section] : undefined;
      return sectionLabel
        ? [{ label: label('Account'), to: '/account' }, { label: label(sectionLabel) }]
        : [{ label: label('Account') }];
    }

    const standalone = Object.entries(STANDALONE_CRUMBS).find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (standalone) return [{ label: label(standalone[1]) }];

    return [{ label: label('Not found') }];
  }, [pathname, bots]);
}
