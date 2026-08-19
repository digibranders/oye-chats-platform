import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
import { AGENT_NAV, WORKSPACE_NAV, agentIdFromPath, agentPath } from './nav';

export interface Crumb {
  label: string;
  to?: string;
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
 * never leave anonymous.
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
        { label: agent?.name ?? `Chatbot ${agentId}`, to: agentPath(agentId, 'overview') },
        ...(tab ? [{ label: tab.label }] : []),
      ];
    }

    const top = WORKSPACE_NAV.find((item) =>
      item.end ? pathname === item.to : pathname.startsWith(item.to),
    );
    if (!top) return [];

    // A second segment under a workspace destination is a section of it —
    // `/settings/team`, `/billing/invoices`. The page owns its own title, so the
    // trail stops at the destination and does not repeat it.
    return [{ label: top.label, to: top.end ? undefined : top.to }];
  }, [pathname, bots]);
}
