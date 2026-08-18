/**
 * Upgrade-intent registry - the per-feature copy shown by the rich upgrade
 * modal (`design-system/components/UpgradeModal.tsx`).
 *
 * Ported VERBATIM from the legacy `context/UpgradeModalContext.jsx`
 * `UPGRADE_INTENTS` map (see `git show 75c2197~1:app/src/context/UpgradeModalContext.jsx`)
 * so every gate keeps its exact wording after the redesign - only the
 * presentation changed, not the substance. All 17 legacy intents are here,
 * plus one new entry (`live_chat`) that did not exist in the legacy registry:
 * the legacy app only had `live_chat_appearance` (the handoff/appearance
 * config screen), so a bare "live chat" gate (e.g. the Inbox live-chat tab)
 * fell through to generic fallback copy. `live_chat` reuses the
 * `live_chat_appearance` copy so that gate gets specific copy too.
 *
 * Each key resolves to a *builder* - a function returning a fresh
 * `UpgradeIntent` - exactly like the legacy registry (which stored every
 * entry as a function, even the parameter-less ones). Only `add_bot` reads
 * its params; every other builder ignores the argument, which is what makes
 * a single `Record<UpgradeIntentKey, UpgradeIntentBuilder>` type-check
 * without `any`.
 */

/** Every gate-able upgrade intent in the dashboard. */
export type UpgradeIntentKey =
  | 'add_bot'
  | 'add_operator'
  | 'add_department'
  | 'add_canned_response'
  | 'view_support'
  | 'view_leads'
  | 'view_journeys'
  | 'view_visitor_intelligence'
  | 'leads_form'
  | 'view_team'
  | 'view_qualification'
  | 'view_integrations'
  | 'webhooks_integration'
  | 'meetings_integration'
  | 'advanced_settings'
  | 'widget_behavior'
  | 'branding_removable'
  | 'auto_recrawl'
  | 'topup_credits'
  | 'live_chat_appearance'
  | 'live_chat';

/** Resolved copy for the upgrade modal. */
export interface UpgradeIntent {
  /** Small uppercase kicker above the title. */
  eyebrow: string;
  /** The modal headline. */
  title: string;
  /** Supporting sentence under the title. */
  description: string;
  /** 2-4 short benefit bullets. */
  highlights: string[];
  /** The plan name the CTA nudges toward (e.g. "Starter", "Standard"). */
  recommendedPlan: string;
}

/** Params accepted by the `add_bot` builder - the only intent that needs live values. */
export interface AddBotIntentParams {
  /** How many bots/agents the workspace already has. */
  current: number;
  /** The workspace's current plan display name (e.g. "Free", "Starter"). */
  planName: string;
}

/**
 * Every builder has this shape so `UPGRADE_INTENTS` can be a single,
 * uniformly-typed `Record` - builders that don't need params simply ignore
 * the argument (a function of fewer parameters is assignable to a function
 * type requiring more, so this type-checks without a union or overloads).
 */
export type UpgradeIntentBuilder = (params?: AddBotIntentParams) => UpgradeIntent;

export const UPGRADE_INTENTS: Record<UpgradeIntentKey, UpgradeIntentBuilder> = {
  add_bot: (params) => {
    const current = params?.current ?? 1;
    const plan = params?.planName || 'Free';
    // Per-bot billing: every chatbot needs its own subscription, so the
    // modal narrative is uniform regardless of current plan - "subscribe
    // again to add another bot".
    return {
      eyebrow: `You already have ${current} AI Chatbot${current === 1 ? '' : 's'} on ${plan}`,
      title: 'Subscribe again to add another AI Chatbot',
      description:
        'Each AI Chatbot is its own subscription with its own credits, knowledge base, and branding. ' +
        'Pick a plan for this new AI Chatbot to spin it up.',
      highlights: [
        'Isolated credits per AI Chatbot - a busy chatbot never drains a quieter one',
        'Per-chatbot knowledge base, branding, and embed key',
        'Separate analytics and billing for every AI Chatbot',
      ],
      recommendedPlan: 'Starter',
    };
  },
  add_operator: () => ({
    eyebrow: 'Live chat is a paid feature',
    title: 'Invite your team to live chat',
    description:
      'Free plans focus on the bot. Upgrade to invite operators, hand off conversations in real time, and never miss a hot lead.',
    highlights: [
      'Real-time human handoff from any chat',
      'Up to 5 operators on Starter',
      'Per-operator concurrent chat limits',
    ],
    recommendedPlan: 'Starter',
  }),
  add_department: () => ({
    eyebrow: 'Departments power smart routing',
    title: 'Organize teams with departments',
    description:
      'Group operators by team - Sales, Support, Billing - and route visitors to the right people. Available on plans with live chat.',
    highlights: [
      'Route visitors to the right team',
      'Per-department business hours',
      'Cleaner reports broken down by team',
    ],
    recommendedPlan: 'Starter',
  }),
  add_canned_response: () => ({
    eyebrow: 'Quick replies are a Starter feature',
    title: 'Reply faster with canned responses',
    description:
      'Save common answers as one-click snippets your team can drop into any conversation. Frees up time for the questions that matter.',
    highlights: [
      'Unlimited reusable responses',
      '/shortcut keyboard triggers',
      'Shared across the whole team',
    ],
    recommendedPlan: 'Starter',
  }),
  view_support: () => ({
    eyebrow: 'Live chat & inbox are paid features',
    title: 'Unlock the support workspace',
    description:
      'Take over conversations from your bot, answer offline messages, and keep a full audit trail of every interaction. Upgrade to flip it on.',
    highlights: [
      'Live operator handoff in real time',
      'Offline message inbox with notifications',
      'Per-conversation audit log',
    ],
    recommendedPlan: 'Starter',
  }),
  view_leads: () => ({
    eyebrow: 'Leads dashboard is a paid feature',
    title: 'Capture every visitor as a lead',
    description: 'Upgrade to unlock the leads dashboard, CSV export, BANT scoring, and webhook delivery.',
    highlights: [
      'Searchable, filterable leads inbox',
      'CSV export & webhook push to your CRM',
      'BANT scoring & conversation qualification',
    ],
    recommendedPlan: 'Starter',
  }),
  view_journeys: () => ({
    eyebrow: 'Journey analytics is a Standard feature',
    title: 'See the path visitors take to convert',
    description:
      'Upgrade to trace every visitor’s page journey (before the chat, during, and after) and rank the routes that produce demos, handoffs, and offline messages.',
    highlights: [
      'Top pages, split by pre-chat, in-chat, and post-chat',
      'Which content journeys lead to each conversion type',
      'Where visitors go after they close the chat',
    ],
    recommendedPlan: 'Standard',
  }),
  view_visitor_intelligence: () => ({
    eyebrow: 'Visitor Intelligence is a Professional feature',
    title: 'Know who you’re talking to before they tell you',
    description:
      'Upgrade to Professional to see each visitor’s company signal, a validated deliverability score for every captured email, and to send a manual follow-up the moment a lead goes quiet.',
    highlights: [
      'Company & threat signal resolved from the visitor’s IP',
      'Reoon-validated email score. Know a real inbox from a typo before you reach out',
      'One-click manual follow-up email, with built-in unsubscribe & cooldown safeguards',
    ],
    recommendedPlan: 'Professional',
  }),
  leads_form: () => ({
    eyebrow: 'Lead capture form is a paid feature',
    title: 'Capture leads inside the chat',
    description:
      'Turn the chat widget into a lead-capture funnel - collect name, email, phone, and custom fields right inside the conversation.',
    highlights: [
      'Required & optional custom fields',
      'Auto-route to your CRM via webhooks',
      'Pairs with live chat handoff',
    ],
    recommendedPlan: 'Starter',
  }),
  view_team: () => ({
    eyebrow: 'Team management is a paid feature',
    title: 'Bring your team into the chat',
    description:
      'Invite operators, organize them into departments, and stock canned responses for one-click replies. The whole live-chat workspace becomes a team sport.',
    highlights: [
      'Up to 5 operators on Starter, more on Standard',
      'Departments for smart routing & business hours',
      'Quick replies with /shortcut keyboard triggers',
    ],
    recommendedPlan: 'Starter',
  }),
  view_qualification: () => ({
    eyebrow: 'Lead qualification is a paid feature',
    title: 'Score every conversation automatically',
    description:
      'BANT (Budget, Authority, Need, Timeline) scoring runs on every chat so your team sees hot leads first. Configure thresholds, custom tiers, and routing.',
    highlights: [
      'Automatic BANT scoring on every conversation',
      'MQL → SAL → SQL pipeline view',
      'Webhook hand-off when a lead crosses a threshold',
    ],
    recommendedPlan: 'Standard',
  }),
  view_integrations: () => ({
    eyebrow: 'Integrations are a paid feature',
    title: 'Connect your stack',
    description:
      'Push leads to your CRM, book meetings inside the chat, and fire webhooks on every event. Free plans handle email delivery from Settings → Visitor Messages.',
    highlights: [
      'Webhooks to any HTTPS endpoint (HMAC-signed, auto-retry)',
      'Calendly, Cal.com & Zcal meeting booking in the widget',
      'Per-event recipient routing & visitor confirmation emails',
    ],
    recommendedPlan: 'Starter',
  }),
  webhooks_integration: () => ({
    eyebrow: 'Webhooks are a paid feature',
    title: 'Push leads & events to your stack',
    description:
      'Forward qualified leads, live-chat handoffs, and offline messages to your CRM, Slack, or any HTTPS endpoint in real time. HMAC-signed and retried up to 5 times.',
    highlights: [
      'Real-time delivery to any HTTPS endpoint',
      'HMAC signing + per-attempt audit log',
      'Auto-retry with backoff (30s → 4h)',
    ],
    recommendedPlan: 'Standard',
  }),
  meetings_integration: () => ({
    eyebrow: 'Meeting booking is a paid feature',
    title: 'Book meetings inside the chat',
    description:
      'Drop a Calendly or Zcal link into qualifying conversations so visitors book a call without leaving the widget. Booking confirmations sync back to the leads inbox.',
    highlights: [
      'Calendly & Zcal supported out of the box',
      'Auto-trigger on BANT qualification',
      'Bookings logged against the lead',
    ],
    recommendedPlan: 'Starter',
  }),
  advanced_settings: () => ({
    eyebrow: 'Advanced widget tuning is a paid feature',
    title: 'Fine-tune your widget',
    description:
      'Greeting delays, frustration thresholds, reconnect behavior, typing timeouts - the knobs that take a good AI Chatbot from "works" to "feels right" on your site.',
    highlights: [
      'Custom greeting + handoff timing',
      'Reconnect & heartbeat strategy',
      'Frustration detection thresholds',
    ],
    recommendedPlan: 'Starter',
  }),
  widget_behavior: () => ({
    eyebrow: 'Widget behavior toggles are a paid feature',
    title: 'Control how your widget behaves',
    description:
      'Free bots run on our default behavior. Upgrade to turn file sharing, post-chat ratings, the live-chat queue indicator, typing preview, and email transcripts on or off per bot.',
    highlights: [
      'File sharing & email transcripts',
      'Post-chat rating survey',
      'Live-chat queue indicator & typing preview',
    ],
    recommendedPlan: 'Starter',
  }),
  branding_removable: () => ({
    eyebrow: 'Removing branding is a Standard feature',
    title: 'Remove the "Powered by" footer',
    description:
      'Free and Starter AI Chatbots always show the OyeChats branding footer in the widget. Upgrade to Standard to hide it and give the widget your own look.',
    highlights: [
      'Fully white-labeled chat widget',
      'No "Powered by OyeChats" link on your site',
      'Everything in Starter, plus BANT scoring & API access',
    ],
    recommendedPlan: 'Standard',
  }),
  auto_recrawl: () => ({
    eyebrow: 'Auto-retrain is a Standard feature',
    title: 'Keep your knowledge base fresh, automatically',
    description:
      'Free and Starter AI Chatbots train once and stop. Upgrade to Standard and OyeChats refreshes every trained URL for you on a weekly cycle, re-training only the pages whose content actually changed.',
    highlights: [
      'Weekly auto-refresh of every trained URL',
      'Content-diff so unchanged pages skip re-training',
      'Per-bot toggle with a clean run history',
    ],
    recommendedPlan: 'Standard',
  }),
  // Whether top-up credits expire is set per-deployment by
  // `pricing_config.topup_expiry_months`, which no endpoint exposes to the
  // client - and this registry is static copy with no access to a workspace's
  // credit ledger either, so it has no evidence for an expiry claim of any
  // kind. It therefore makes none. The surfaces that CAN read the ledger
  // (TopupModal, CancelSubscriptionModal, UsageHero) state the real position
  // there. See TopupModal's `describeTopupExpiry`.
  topup_credits: () => ({
    eyebrow: 'Top-up credits are a paid feature',
    title: 'Upgrade to buy top-up credits',
    description:
      'Free workspaces run on their monthly credit allowance. Upgrade to a paid plan to buy top-up credit packs on demand - a one-time purchase that tops up your balance the moment it clears.',
    highlights: [
      'Buy credit packs on demand - never pause your AI Chatbot mid-month',
      'A one-time purchase, on top of your plan - no second subscription',
      'Larger packs include bonus credits',
    ],
    recommendedPlan: 'Starter',
  }),
  live_chat_appearance: () => ({
    eyebrow: 'Live chat is a paid feature',
    title: 'Configure live chat handoff',
    description:
      'Customize when and how the AI Chatbot offers a real human, route to the right team, and set wait-time copy - the full visitor request flow.',
    highlights: [
      'Inline "Talk to a human" CTA',
      'Per-bot handoff timing',
      'Department-aware routing',
    ],
    recommendedPlan: 'Starter',
  }),
  // NEW - not in the legacy registry. The legacy app only shipped
  // `live_chat_appearance` (the handoff-config screen); a bare "this whole
  // surface needs live chat" gate (e.g. Inbox's Live chat tab) had no
  // matching intent and silently fell through to the generic fallback copy.
  // Reuses the `live_chat_appearance` wording so it now gets the real copy.
  live_chat: () => UPGRADE_INTENTS.live_chat_appearance(),
};
