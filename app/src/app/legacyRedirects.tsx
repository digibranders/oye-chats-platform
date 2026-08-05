import { type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';

/**
 * Legacy URL compatibility layer.
 *
 * Admin 2.0 rebuilt the information architecture, which moved (or removed)
 * every top-level path the old dashboard used. Those old paths did not stop
 * being reachable when the UI was replaced:
 *
 *  - transactional emails already delivered to inboxes link to `/billing`,
 *    `/knowledge`, `/affiliate` and `/support`
 *    (see `api/app/services/email_service.py`);
 *  - push notifications and the in-app bell build `click_url`s against the
 *    same paths (`api/app/worker/tasks.py`,
 *    `api/app/services/notification_service.py`);
 *  - users bookmark URLs.
 *
 * Every one of those links rendered the in-shell 404. The alias routes in
 * `routes.tsx` map them onto their Admin 2.0 homes using the components below.
 * They are deliberately *aliases*, not navigation: nothing inside the app
 * should link here, and `shell/nav.config.ts` remains the single source of
 * truth for real routes.
 */

interface LegacyRedirectProps {
  /** The Admin 2.0 path this legacy URL now lives at. */
  readonly to: string;
}

/**
 * Redirect a pre-Admin-2.0 URL to its current home, carrying the query string
 * and hash across. Deep-link context matters here: the operator push
 * notification for a waiting visitor is `/support?session=<id>` and the
 * offline-message one is `/support?tab=messages`, so a bare
 * `<Navigate to="/inbox">` would land the operator on the wrong tab with the
 * session id thrown away.
 */
export function LegacyRedirect({ to }: LegacyRedirectProps): ReactElement {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

/**
 * `/knowledge` has no direct Admin 2.0 equivalent - knowledge is now a tab on
 * a specific agent (`/agents/:agentId/knowledge`), so the legacy URL has to be
 * resolved against the workspace's bots before it can be redirected.
 *
 * Resolution order, most to least specific:
 *   1. `?bot=<bot_key>` - the crawl-finished notification carries it, so this
 *      lands the user on exactly the agent whose training just completed;
 *   2. the bot currently selected in the shell switcher;
 *   3. the only bot, when the workspace has exactly one;
 *   4. otherwise the agent list, which is the honest answer when we cannot
 *      tell which agent the user meant.
 */
export function LegacyKnowledgeRedirect(): ReactElement | null {
  const { search, hash } = useLocation();
  const { bots, selectedBot, loading } = useBotContext();

  // The bot list is still in flight. Render nothing rather than a spinner:
  // this is a redirect hop the user perceives as navigation latency, and a
  // loader that flashes for one paint is more jarring than an empty frame.
  if (loading) return null;

  const params = new URLSearchParams(search);
  const botKey = params.get('bot');
  const target =
    (botKey ? bots.find((bot) => bot.bot_key === botKey) : null) ??
    selectedBot ??
    (bots.length === 1 ? bots[0] : null);

  if (!target) {
    return <Navigate to="/agents" replace />;
  }

  // `bot` is encoded in the path now, so drop it rather than leaving a stale
  // duplicate of the agent identity in the query string.
  params.delete('bot');
  const rest = params.toString();
  return <Navigate to={`/agents/${target.id}/knowledge${rest ? `?${rest}` : ''}${hash}`} replace />;
}
