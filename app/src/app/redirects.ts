/**
 * Every URL a previous information architecture shipped, and where it lives now.
 *
 * Old links live in delivered emails, push-notification payloads, bookmarks and
 * the odd support ticket, and they outlive any rename — the previous rename
 * dropped several of them onto the in-shell 404. As a table rather than
 * twenty-five inline route objects they are testable as data, and they stop
 * accreting in the middle of the router where the real routes are.
 *
 * The pairs whose *meaning* changed rather than just their address are called
 * out in comments, because they are the ones a reader will otherwise assume are
 * simple renames.
 */
export const LEGACY_PATHS: ReadonlyArray<readonly [from: string, to: string]> = [
  ['agents', '/chatbots'],
  ['journey', '/analytics/journey'],
  ['support', '/inbox'],
  ['build', '/setup'],
  ['launch', '/setup'],
  ['launch/:step', '/setup'],
  ['workspace', '/settings/workspace'],
  ['workspace/general', '/settings/workspace'],
  ['workspace/members', '/settings/team'],
  ['workspace/billing', '/billing'],
  ['workspace/usage', '/billing/usage'],
  ['workspace/reports', '/billing/reports'],
  ['workspace/api-keys', '/settings/developers'],
  ['workspace/integrations', '/settings/integrations'],
  ['workspace/affiliate', '/settings/affiliate'],
  ['workspace/settings', '/account'],
  ['workspace/security', '/account'],
  ['billing/affiliate', '/settings/affiliate'],
  // `/account/preferences` used to render the same component as `/account`:
  // two menu items, two URLs, one screen. The account page holds the
  // preferences, so the second address folds into the first.
  ['account/preferences', '/account'],
];

/** Chatbot-scoped legacy paths: `/agents/7/channels` → `/chatbots/7/deploy`. */
export const LEGACY_AGENT_SEGMENTS: ReadonlyArray<readonly [from: string, segment: string]> = [
  ['agents/:agentId', 'overview'],
  ['agents/:agentId/overview', 'overview'],
  ['agents/:agentId/knowledge', 'knowledge'],
  ['agents/:agentId/experience', 'experience'],
  ['agents/:agentId/channels', 'deploy'],
  ['agents/:agentId/advanced', 'behaviour'],
  // Not a rename: the per-chatbot analytics tab was folded into Overview, so
  // this one changes what the link *means*, not only where it points.
  ['agents/:agentId/analytics', 'overview'],
];
