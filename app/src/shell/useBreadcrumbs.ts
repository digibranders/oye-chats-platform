import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
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
export function useBreadcrumbs(): Crumb[] {
  const { pathname } = useLocation();
  const { bots } = useBotContext();

  return useMemo(() => {
    const agentId = agentIdFromPath(pathname);

    if (agentId) {
      const agent = bots.find((bot) => String(bot.id) === agentId);
      const segment = pathname.split('/')[3] ?? 'overview';
      const tab = AGENT_NAV.find((item) => item.segment === segment);
      return [
        { label: 'Chatbots', to: '/chatbots' },
        {
          label: agent?.name ?? 'Chatbot',
          to: agentPath(agentId, 'overview'),
          pending: !agent,
        },
        ...(tab ? [{ label: tab.label }] : []),
      ];
    }

    // Settings is a footer destination, not a `WORKSPACE_NAV` one, and the
    // lookup used to read only the latter — which is why every `/settings/*`
    // route rendered an empty trail.
    const top = [...WORKSPACE_NAV, ...FOOTER_NAV].find((item) =>
      item.end ? pathname === item.to : pathname.startsWith(item.to),
    );

    if (top) {
      const section = pathname.split('/')[2];
      const label = section ? NAV_SECTIONS[top.to]?.[section] : undefined;
      // The first crumb links only when there is a second one to come back
      // from: a lone crumb naming the page you are already on is not a link.
      return label ? [{ label: top.label, to: top.to }, { label }] : [{ label: top.label }];
    }

    // Your own account, onboarding, and the 404. None of them is in the rail,
    // which is exactly why the trail has to name them.
    if (pathname === '/account' || pathname.startsWith('/account/')) {
      const section = pathname.split('/')[2];
      const label = section ? ACCOUNT_SECTIONS[section] : undefined;
      return label ? [{ label: 'Account', to: '/account' }, { label }] : [{ label: 'Account' }];
    }

    const standalone = Object.entries(STANDALONE_CRUMBS).find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (standalone) return [{ label: standalone[1] }];

    return [{ label: 'Not found' }];
  }, [pathname, bots]);
}
