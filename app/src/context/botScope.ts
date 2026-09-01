import type { Bot } from '../types/domain';

/**
 * The chatbot a surface should read, for surfaces that CANNOT aggregate.
 *
 * Analytics and Journey are the two. Their endpoints require `bot_id`
 * (`/analytics/journey/summary` 422s without it — there is no all-chatbots
 * journey to fetch), so both gate every query on `enabled: botId != null`.
 *
 * They read the shell scope, which is written only by `BotContext.selectBot`.
 * The redesign dropped the switcher that called it, leaving zero callers in the
 * app — so `selectedBot` could only ever be null, every query stayed disabled,
 * and both pages rendered permanently empty for every account.
 *
 * The fallback is deliberately narrow: use the sole chatbot only when there IS
 * exactly one. "Default to the first" would be a lie the moment an account has
 * several, showing one chatbot's numbers while the control says All chatbots.
 * With two or more and nothing chosen this returns null and the page asks the
 * reader to pick — which is the only honest answer.
 *
 * Every plan below Enterprise allows exactly one chatbot, so the single-chatbot
 * branch is the state almost every account is in.
 *
 * Deliberately NOT the same as `selectedBot`, which stays as it is: for Leads
 * and Inbox, null genuinely means "all chatbots" and aggregating is correct.
 */
export function resolveScopedBotId(selectedBot: Bot | null, bots: readonly Bot[]): number | null {
  // A selection is only usable if it is still in the list — a chatbot that was
  // deleted, or belongs to another workspace, would 403 on every request.
  if (selectedBot && bots.some((bot) => bot.id === selectedBot.id)) return selectedBot.id;
  return bots.length === 1 ? bots[0].id : null;
}
