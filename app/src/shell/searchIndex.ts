/**
 * @i18n-exempt-file: `label` and `hint` are lookup KEYs, not copy to
 * translate, exactly like `NavItem.label` in nav.ts. `settingLabel` and
 * `settingHint` (a later task, mirroring `navLabel`/`navHint` in
 * navCopy.ts) derive the dictionary key from these strings and resolve the
 * translation at render; translating them in place would change the key and
 * orphan that dictionary. `keywords` is a third, separate string on every
 * entry: it is filter-only, never rendered, and stays English-only in this
 * pass per the design spec's "Translation" section, so it needs no lookup
 * key at all. Both reasons land on this file being exempt from the
 * needs-translation inventory.
 *
 * Things a customer can name, one level deeper than a page.
 *
 * `nav.ts` indexes destinations: pages and chatbots. This indexes what lives
 * INSIDE a destination: a specific, named setting a customer would type the
 * name of rather than browse to. "Business Hours" is the case that started
 * this file: it is a real field on every chatbot's Experience tab, and until
 * now the command palette had no way to know that word meant anything.
 *
 * Same rule `nav.ts` states for itself applies here: a setting missing from
 * this file is a setting the palette cannot find. See
 * docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md
 * for how this list was built (walked every settings page and every agent tab
 * once, pulling real section headings already in the product's own copy) and
 * what is deliberately not in it (anything reached only from inside a dialog,
 * which has no stable URL to land the palette on).
 */
import {
  Brain,
  Building2,
  Globe,
  Handshake,
  KeyRound,
  type LucideIcon,
  MessagesSquare,
  Plug,
  Receipt,
  Settings2,
  Target,
  Users,
  Webhook,
} from 'lucide-react';

export interface SettingItem {
  id: string;
  /** What the customer calls it. English is the lookup KEY here, exactly
   *  like `NavItem.label` in nav.ts — see `navCopy.ts`'s `settingLabel`. */
  label: string;
  /** One line, for the palette row. Same rule: a lookup key, not copy. */
  hint: string;
  icon: LucideIcon;
  /** Extra terms the filter matches but which are never rendered. English
   *  only in this pass; see the spec's "Translation" section for why. */
  keywords: string;
}

export interface WorkspaceSettingItem extends SettingItem {
  /** Static: the same URL for every workspace. */
  to: string;
}

export interface AgentSettingItem extends SettingItem {
  /** Appended to `/chatbots/:agentId`, exactly like `AgentNavItem.segment`. */
  segment: string;
}

export const WORKSPACE_SETTINGS: readonly WorkspaceSettingItem[] = [
  {
    id: 'workspace-name',
    label: 'Workspace Name',
    hint: 'What your account is called across the product',
    icon: Building2,
    to: '/settings/workspace',
    keywords: 'company name account name rename workspace',
  },
  {
    id: 'invite-teammate',
    label: 'Invite a Teammate',
    hint: 'Add someone to your team',
    icon: Users,
    to: '/settings/team?tab=invitations',
    keywords: 'invite team member add person pending invitation',
  },
  {
    id: 'departments',
    label: 'Departments',
    hint: 'Group operators so chats route to the right team',
    icon: Users,
    to: '/settings/team?tab=departments',
    keywords: 'department group routing operators team',
  },
  {
    id: 'queue-wait-time',
    label: 'Live Chat Queue and Wait Time',
    hint: 'What a visitor sees while they wait for your team',
    icon: Users,
    to: '/settings/team?tab=routing',
    keywords: 'queue wait time timeout routing live chat availability',
  },
  {
    id: 'api-key',
    label: 'API Key',
    hint: 'Your workspace credential, and how to rotate it',
    icon: KeyRound,
    to: '/settings/developers',
    keywords: 'api key secret token credential developer rotate',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    hint: 'Endpoints we notify when something happens',
    icon: Webhook,
    to: '/settings/integrations?tab=webhooks',
    keywords: 'webhook endpoint integration deliveries http post',
  },
  {
    id: 'email-notifications',
    label: 'Email Notifications',
    hint: 'Who hears about a chatbot by email',
    icon: Plug,
    to: '/settings/integrations?tab=email',
    keywords: 'email notification recipient routing alerts',
  },
  {
    id: 'meeting-booking',
    label: 'Meeting Booking',
    hint: 'Let the chatbot offer a time on your calendar',
    icon: Plug,
    to: '/settings/integrations?tab=meetings',
    keywords: 'meeting booking calendly zcal cal.com calendar schedule',
  },
  {
    id: 'affiliate',
    label: 'Affiliate Programme',
    hint: 'Earn credit for referrals',
    icon: Handshake,
    to: '/settings/affiliate',
    keywords: 'affiliate partner referral programme commission',
  },
];

export const AGENT_SETTINGS: readonly AgentSettingItem[] = [
  // ── Knowledge ─────────────────────────────────────────────────────────
  {
    id: 'auto-retrain',
    label: 'Auto-retrain',
    hint: 'Keep this knowledge up to date',
    icon: Brain,
    segment: 'knowledge',
    keywords: 'auto retrain recrawl refresh schedule knowledge',
  },
  {
    id: 'sources',
    label: 'Sources',
    hint: 'The documents and pages this chatbot knows',
    icon: Brain,
    segment: 'knowledge',
    keywords: 'sources documents pages uploads crawl',
  },
  {
    id: 'knowledge-gaps',
    label: 'Knowledge Gaps',
    hint: 'Questions it could not answer',
    icon: Brain,
    segment: 'knowledge',
    keywords: 'knowledge gaps unanswered questions missing',
  },
  // ── Experience ────────────────────────────────────────────────────────
  {
    id: 'business-hours',
    label: 'Business Hours',
    hint: "When the chatbot's people are around",
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'availability online offline opening times staffed when someone is there',
  },
  {
    id: 'widget-colours',
    label: 'Widget Colours',
    hint: 'Your two brand colours on the chat window',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'colour color brand primary accent theme',
  },
  {
    id: 'chatbot-avatar',
    label: 'Chatbot Avatar',
    hint: 'The face of your chatbot',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'avatar face icon logo picture image',
  },
  {
    id: 'credit-line',
    label: 'Credit Line',
    hint: 'Show or hide the OyeChats mark in the chat window',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'branding remove credit line powered by whitelabel',
  },
  {
    id: 'language',
    label: 'Language',
    hint: 'What languages this chatbot speaks to visitors',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'language locale translate multilingual',
  },
  {
    id: 'talking-to-a-person',
    label: 'Talking to a Person',
    hint: 'What happens when the chatbot is not enough',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'handoff live chat escalate human operator talk to a person',
  },
  {
    id: 'pre-chat-form',
    label: 'Pre-chat Form',
    hint: 'What to ask before the chat starts',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'pre-chat form name email capture qualify before chat',
  },
  {
    id: 'chatbot-name',
    label: 'Chatbot Name',
    hint: 'What your chatbot is called',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'name title rename chatbot',
  },
  {
    id: 'greeting-message',
    label: 'Greeting Message',
    hint: 'The first thing a visitor reads',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'greeting welcome message first message',
  },
  {
    id: 'suggested-questions',
    label: 'Suggested Questions',
    hint: 'Questions a visitor can tap',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'suggested questions quick replies chips prompts',
  },
  {
    id: 'widget-copy',
    label: 'Widget Copy',
    hint: "The rest of the widget's copy",
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'copy text wording labels widget messages',
  },
  // ── Deploy ────────────────────────────────────────────────────────────
  {
    id: 'allowed-domains',
    label: 'Allowed Domains',
    hint: 'Which websites this chatbot may run on',
    icon: Globe,
    segment: 'deploy',
    keywords: 'allowed domains origin cors website embed restrict',
  },
  {
    id: 'demo-link',
    label: 'Demo Link',
    hint: 'Share a link instead of embedding',
    icon: Globe,
    segment: 'deploy',
    keywords: 'demo link share preview url',
  },
  {
    id: 'install-embed-code',
    label: 'Install / Embed Code',
    hint: 'The script tag to paste on your site',
    icon: Globe,
    segment: 'deploy',
    keywords: 'install embed code script tag snippet deploy',
  },
  // ── Qualification ─────────────────────────────────────────────────────
  {
    id: 'scoring-dimensions',
    label: 'Scoring Dimensions',
    hint: 'What this scoring has produced',
    icon: Target,
    segment: 'qualification',
    keywords: 'scoring dimensions bant meddic budget authority need timeline',
  },
  {
    id: 'tier-thresholds',
    label: 'Tier Thresholds',
    hint: 'The score to reach',
    icon: Target,
    segment: 'qualification',
    keywords: 'tier threshold score hot warm cold',
  },
  {
    id: 'tier-outcomes',
    label: 'Tier Outcomes',
    hint: 'What happens at each tier',
    icon: Target,
    segment: 'qualification',
    keywords: 'tier outcome action webhook notify',
  },
  {
    id: 'score-decay',
    label: 'Score Decay',
    hint: 'How a score fades over time',
    icon: Target,
    segment: 'qualification',
    keywords: 'score decay timing expiry stale',
  },
  {
    id: 'behavioural-points',
    label: 'Behavioural Points',
    hint: 'Points earned from what a visitor does',
    icon: Target,
    segment: 'qualification',
    keywords: 'behavioural points signals return visit page view',
  },
  // ── Quotation ─────────────────────────────────────────────────────────
  {
    id: 'currency',
    label: 'Currency',
    hint: 'What currency the chatbot quotes in',
    icon: Receipt,
    segment: 'quotation',
    keywords: 'currency inr usd price',
  },
  {
    id: 'quotation-timing',
    label: 'When to Send the Quotation',
    hint: 'How long after asking a visitor gets a quote',
    icon: Receipt,
    segment: 'quotation',
    keywords: 'quotation send delay timing document email',
  },
  {
    id: 'quotation-trigger',
    label: 'When to Offer a Quote',
    hint: 'What makes the chatbot offer to price something',
    icon: Receipt,
    segment: 'quotation',
    keywords: 'quotation trigger offer price when',
  },
  // ── Behaviour ─────────────────────────────────────────────────────────
  {
    id: 'persona',
    label: 'Persona',
    hint: 'Who the chatbot says you are',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'persona identity who am i character',
  },
  {
    id: 'voice',
    label: 'Voice',
    hint: 'How it should sound',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'voice tone sound formal casual',
  },
  {
    id: 'scope',
    label: 'Scope',
    hint: 'What it is allowed to talk about',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'scope topics allowed restrict boundaries',
  },
  {
    id: 'smart-links',
    label: 'Smart Links',
    hint: 'Words the chatbot turns into links',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'smart links auto link hyperlink keywords',
  },
  {
    id: 'lead-enrichment',
    label: 'Lead Enrichment',
    hint: 'Extra signal collected about a visitor',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'lead enrichment ip company email verification',
  },
];
