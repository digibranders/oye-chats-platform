import type { Bot } from '../../../types/domain';

/**
 * The email-routing fields that live on a chatbot row.
 *
 * The shared `Bot` type deliberately declares only the core columns; these sit
 * on the same record and are read through this narrow view rather than through
 * `any`. Every added key is optional, so `Bot` stays structurally assignable.
 */

export interface NotificationEmails {
  default?: string[];
  qualified_lead?: string[];
  handoff_request?: string[];
  offline_message?: string[];
}

export interface BotEmailSettings {
  reply_to_email?: string | null;
  notification_emails?: NotificationEmails | null;
  email_on_qualified?: boolean;
  email_on_handoff?: boolean;
  email_on_offline?: boolean;
  email_visitor_confirmation?: boolean;
  feature_flags?: { email_transcript?: boolean } | null;
}

export interface BotMeetingSettings {
  meeting_booking_enabled?: boolean;
  meeting_provider?: string | null;
  calendly_url?: string | null;
  zcal_url?: string | null;
  calcom_url?: string | null;
}

export type BotWithIntegrations = Bot & BotEmailSettings & BotMeetingSettings;

export function readIntegrations(bot: Bot): BotWithIntegrations {
  return bot as BotWithIntegrations;
}

/** The routing state this panel edits, flattened so it can be compared field-by-field. */
export interface EmailRouting {
  replyTo: string;
  recipients: string[];
  qualifiedLead: string[];
  handoff: string[];
  offline: string[];
  onQualified: boolean;
  onHandoff: boolean;
  onOffline: boolean;
  visitorConfirmation: boolean;
  transcript: boolean;
}

export function readEmailRouting(bot: Bot): EmailRouting {
  const settings = readIntegrations(bot);
  const notify = settings.notification_emails ?? null;
  return {
    replyTo: settings.reply_to_email ?? '',
    recipients: notify?.default ?? [],
    qualifiedLead: notify?.qualified_lead ?? [],
    handoff: notify?.handoff_request ?? [],
    offline: notify?.offline_message ?? [],
    // Absent means on. The backend's own defaults are `true`, and rendering a
    // never-configured chatbot's switches as off would tell the customer they
    // are not being emailed when they are.
    onQualified: settings.email_on_qualified ?? true,
    onHandoff: settings.email_on_handoff ?? true,
    onOffline: settings.email_on_offline ?? true,
    visitorConfirmation: settings.email_visitor_confirmation ?? true,
    transcript: settings.feature_flags?.email_transcript ?? false,
  };
}

/**
 * The request body, with per-event overrides omitted when empty.
 *
 * An empty override list is not "send to nobody" — it means "fall back to the
 * default recipients", and persisting `[]` would have turned clearing an
 * override into silently switching that event's notifications off.
 */
export function toBotPatch(routing: EmailRouting): Record<string, unknown> {
  const notificationEmails: NotificationEmails = { default: routing.recipients };
  if (routing.qualifiedLead.length > 0) notificationEmails.qualified_lead = routing.qualifiedLead;
  if (routing.handoff.length > 0) notificationEmails.handoff_request = routing.handoff;
  if (routing.offline.length > 0) notificationEmails.offline_message = routing.offline;

  return {
    reply_to_email: routing.replyTo.trim() || null,
    notification_emails: notificationEmails,
    email_on_qualified: routing.onQualified,
    email_on_handoff: routing.onHandoff,
    email_on_offline: routing.onOffline,
    email_visitor_confirmation: routing.visitorConfirmation,
    feature_flags: { email_transcript: routing.transcript },
  };
}

/** True when the draft differs from what the server last confirmed. */
export function routingChanged(baseline: EmailRouting, draft: EmailRouting): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(draft);
}

export interface MeetingProvider {
  id: string;
  name: string;
  field: 'calendly_url' | 'zcal_url' | 'calcom_url';
  placeholder: string;
  host: string;
}

export const MEETING_PROVIDERS: readonly MeetingProvider[] = [
  {
    id: 'calendly',
    name: 'Calendly',
    field: 'calendly_url',
    placeholder: 'https://calendly.com/you/30min',
    host: 'calendly.com',
  },
  {
    id: 'zcal',
    name: 'Zcal',
    field: 'zcal_url',
    placeholder: 'https://zcal.co/you/30min',
    host: 'zcal.co',
  },
  {
    id: 'calcom',
    name: 'Cal.com',
    field: 'calcom_url',
    placeholder: 'https://cal.com/you/30min',
    host: 'cal.com',
  },
];

/**
 * A booking link has to be the provider's own domain.
 *
 * Pasting a Calendly link into the Zcal field saved cleanly and then rendered a
 * button that took the visitor nowhere, which is the worst possible failure on
 * the one control whose entire job is to close a deal.
 */
export function validateMeetingUrl(provider: MeetingProvider, raw: string): string | null {
  const value = raw.trim();
  if (!value) return `Paste your ${provider.name} link, or turn booking off.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `That is not a valid URL. It should start with https://${provider.host}/`;
  }
  if (url.protocol !== 'https:') return 'Use the https:// version of the link.';
  if (!url.hostname.endsWith(provider.host)) {
    return `That is not a ${provider.name} link — it should be on ${provider.host}.`;
  }
  return null;
}
