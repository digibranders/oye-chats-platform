/**
 * Query keys, in one place.
 *
 * Invalidation only works if the key that writes and the key that reads agree,
 * and keys assembled inline at each call site do not stay agreed. Every key here
 * is a function returning a tuple, so a mutation can invalidate a whole subtree
 * (`keys.agents.all`) or one record (`keys.agents.detail(7)`) without either
 * side guessing at the other's shape.
 *
 * Workspace-scoped keys carry the workspace id. Without it, switching workspaces
 * serves the previous account's data out of cache — which is the failure mode
 * the old currency provider actually shipped, because it was the one context
 * that never listened for the switch.
 */
export const keys = {
  session: {
    me: () => ['session', 'me'] as const,
    entitlements: (workspaceId: string | null) => ['session', 'entitlements', workspaceId] as const,
    workspaces: () => ['session', 'workspaces'] as const,
  },

  agents: {
    all: (workspaceId: string | null) => ['agents', workspaceId] as const,
    detail: (agentId: number) => ['agents', 'detail', agentId] as const,
    health: (agentId: number) => ['agents', 'health', agentId] as const,
    knowledge: (agentId: number) => ['agents', 'knowledge', agentId] as const,
    knowledgeState: (agentId: number) => ['agents', 'knowledge', agentId, 'state'] as const,
    crawlProgress: (agentId: number) => ['agents', 'crawl', agentId] as const,
    recrawl: (agentId: number) => ['agents', 'recrawl', agentId] as const,
  },

  inbox: {
    queue: () => ['inbox', 'queue'] as const,
    offline: (params: Record<string, unknown>) => ['inbox', 'offline', params] as const,
    cannedResponses: () => ['inbox', 'canned-responses'] as const,
    session: (sessionId: string) => ['inbox', 'session', sessionId] as const,
    history: (sessionId: string) => ['inbox', 'history', sessionId] as const,
  },

  leads: {
    list: (params: Record<string, unknown>) => ['leads', params] as const,
    stats: (agentId: number | null) => ['leads', 'stats', agentId] as const,
    detail: (sessionId: string) => ['leads', 'detail', sessionId] as const,
    suppressions: (params: Record<string, unknown>) => ['leads', 'suppressions', params] as const,
  },

  analytics: {
    dashboard: (agentId: number | null, days: number | null) =>
      ['analytics', 'dashboard', agentId, days] as const,
    activity: (agentId: number | null, days: number | null) =>
      ['analytics', 'activity', agentId, days] as const,
    topQuestions: (agentId: number | null) => ['analytics', 'top-questions', agentId] as const,
    unanswered: (agentId: number | null, days: number | null) =>
      ['analytics', 'unanswered', agentId, days] as const,
    feedback: (agentId: number | null) => ['analytics', 'feedback', agentId] as const,
    ratings: (agentId: number | null) => ['analytics', 'ratings', agentId] as const,
    resolution: (agentId: number | null) => ['analytics', 'resolution', agentId] as const,
    visitors: (agentId: number | null) => ['analytics', 'visitors', agentId] as const,
    byBot: (days: number) => ['analytics', 'by-bot', days] as const,
    journey: (agentId: number | null, period: string) =>
      ['analytics', 'journey', agentId, period] as const,
    funnel: (agentId: number | null, period: string) =>
      ['analytics', 'funnel', agentId, period] as const,
  },

  billing: {
    subscription: () => ['billing', 'subscription'] as const,
    plans: () => ['billing', 'plans'] as const,
    invoices: () => ['billing', 'invoices'] as const,
    details: () => ['billing', 'details'] as const,
    paymentMethods: () => ['billing', 'payment-methods'] as const,
    credits: (agentId: number | null) => ['billing', 'credits', agentId] as const,
    creditHistory: (agentId: number | null) => ['billing', 'credits', 'history', agentId] as const,
    creditDaily: (agentId: number | null) => ['billing', 'credits', 'daily', agentId] as const,
    promo: () => ['billing', 'promo'] as const,
    geo: () => ['billing', 'geo'] as const,
  },

  team: {
    operators: () => ['team', 'operators'] as const,
    departments: () => ['team', 'departments'] as const,
    invites: () => ['team', 'invites'] as const,
  },

  workspace: {
    webhooks: (agentId: number | null) => ['workspace', 'webhooks', agentId] as const,
    deliveries: (webhookId: number, page: number) =>
      ['workspace', 'webhooks', webhookId, 'deliveries', page] as const,
    apiKey: () => ['workspace', 'api-key'] as const,
    notificationPreferences: () => ['workspace', 'notification-preferences'] as const,
  },

  affiliate: {
    me: () => ['affiliate', 'me'] as const,
    codes: () => ['affiliate', 'codes'] as const,
    stats: () => ['affiliate', 'stats'] as const,
    referrals: (codeId: number) => ['affiliate', 'codes', codeId, 'referrals'] as const,
  },

  notifications: {
    list: () => ['notifications'] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },

  setup: {
    checklist: () => ['setup', 'checklist'] as const,
  },
} as const;
