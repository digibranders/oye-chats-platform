import { asRecord, hasNetworkSignal } from '../leads/visitorNetwork';
import type { SessionDetails } from './liveChatProtocol';

/** Everything the visitor pane can show, whatever record it came from. */
export interface VisitorProfile {
  /**
   * Which record this was built from.
   *
   * An offline message has no session behind it, so `Department`, `Assigned
   * to`, `Last active`, `Messages` and `Rated this chat` are not *absent* for
   * it — they do not exist. The pane rendered all five as `—`, which says "we
   * looked and found nothing" about five facts nobody could ever have, and put
   * seven dashes in a ten-row list. It states only the rows the record can
   * carry instead.
   */
  kind: 'session' | 'offline';
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  location: string | null;
  device: string | null;
  pageUrl: string | null;
  referrer: string | null;
  botName: string | null;
  departmentName: string | null;
  operatorName: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
  messageCount: number | null;
  rating: number | null;
  handoffReason: string | null;
  bant: {
    need: string | null;
    timeline: string | null;
    authority: string | null;
    budget: string | null;
  } | null;
  /**
   * The language this conversation settled into, as a base code ("hi").
   *
   * Null for every single-language chatbot and for a session recorded before
   * multilingual shipped, which is why the badge that renders it disappears
   * rather than saying "Unknown".
   */
  languageCode: string | null;
  /** The itemised quote the visitor built before asking for a person, if any. */
  quotation: SessionDetails['quotation'];
  /**
   * The IP-derived company and network signal, or `null` when there is none.
   *
   * Distinct from `company`, which is what the visitor typed into a lead form.
   * This is what the system worked out, and `null` is a legitimate answer: the
   * backend deliberately returns no company for a home-broadband visitor rather
   * than naming their ISP, and the pane must then show nothing at all rather
   * than an empty slot.
   */
  network: Record<string, unknown> | null;
}

/** The IP signal on a session, or `null` when it carries nothing to render. */
function networkOf(details: SessionDetails): Record<string, unknown> | null {
  // Namespaced: `visitor_metadata` is a shared blob the operator console also
  // writes user-agent fields into.
  const intel = asRecord(asRecord(details.visitor_metadata).ip_intel);
  return hasNetworkSignal(intel) ? intel : null;
}

/**
 * A chat session, as a profile.
 *
 * `lead_info` wins over the row's own name because it is what the visitor
 * actually told us, while the row's name may still be the "Visitor" the widget
 * assigned before they introduced themselves.
 */
export function profileFromSession(details: SessionDetails, fallbackName: string): VisitorProfile {
  const lead = details.lead_info;
  return {
    kind: 'session',
    name: lead?.name?.trim() || fallbackName,
    email: lead?.email ?? null,
    phone: lead?.phone ?? null,
    company: lead?.company ?? null,
    location: details.location,
    device: details.device,
    pageUrl: details.page_url,
    referrer: details.referrer,
    botName: details.bot_name,
    departmentName: details.department_name,
    operatorName: details.operator_name,
    startedAt: details.created_at,
    lastActiveAt: details.last_active_at,
    messageCount: details.message_count,
    rating: details.visitor_rating,
    handoffReason: details.handoff_reason,
    bant: details.bant,
    languageCode: details.language_code,
    quotation: details.quotation,
    network: networkOf(details),
  };
}
