/**
 * Client-side CSV assembly for "Export selected".
 *
 * Its own module rather than a helper inside `LeadsPage`: a component file
 * that also exports a plain function breaks React Fast Refresh, and this is
 * the one path where a dropped field leaves the product for good, it needs
 * tests of its own.
 */
import { csvField } from '../../lib/csvSafe';
import { type Lead } from '../../types/domain';

import {
  EMPTY_PLACEHOLDER,
  TIER_META,
  UNKNOWN_LOCATION,
  companyDisplay,
  formatDateTime,
  formatLocation,
  normalizeTier,
} from './leadModel';
import { t as translateNow } from '../../i18n/i18n';

/**
 * Drop the table's absence placeholder, which must not reach the file.
 *
 * A CSV says "no value" with an empty cell, not with a glyph meant for a table
 * cell, a CRM importing this would store a literal dash as the last-active
 * date. It also keeps `csvSafe` from quoting the placeholder: a bare `-` is a
 * formula trigger, so an absent timestamp would otherwise export as `'-`.
 *
 * Compares against `EMPTY_PLACEHOLDER` rather than a local `'-'` so the two
 * cannot drift apart: a hardcoded copy here would silently stop matching the
 * day `leadModel` switches to a true em-dash, and nothing would fail.
 */
function blankIfPlaceholder(formatted: string): string {
  return formatted === EMPTY_PLACEHOLDER ? '' : formatted;
}

/**
 * The same rule for the Location column's own placeholder.
 *
 * `formatLocation` answers the word "Unknown" when a session has no resolved
 * geography. Right for a table cell, wrong for a file. The server export
 * (`GET /leads/export`) writes an empty cell for exactly that case, so the two
 * downloads disagreed about the same lead: a customer merging them saw one row
 * with a blank Location and one with a country named Unknown, and a CRM import
 * created that country. An empty cell is what a spreadsheet means by "no
 * value", so the server's answer is the one both paths now give.
 *
 * A real place is never lost to this: `UNKNOWN_LOCATION` is only ever produced
 * by `formatLocation` itself, never carried through from stored geography.
 */
function blankIfUnknownLocation(formatted: string): string {
  return formatted === UNKNOWN_LOCATION ? '' : formatted;
}

/**
 * Build a CSV for a subset of leads entirely client-side. The server export
 * (`exportLeadsCsv`) only emits the full set, so "Export selected" assembles its
 * own file from the rows the user ticked - including their private tags.
 */
export function buildSelectedLeadsCsv(
  leads: Lead[],
  tagsFor: (sessionId: string) => readonly string[],
): string {
  // 'Company' is the resolved identity when the paid lookup produced one, with
  // the raw email domain kept in its own column, a CSV that silently swapped
  // one for the other would break any sheet keyed on the domain.
  const header = [
    translateNow('leads.name') || 'Name',
    translateNow('leads.email') || 'Email',
    translateNow('leads.phone') || 'Phone',
    translateNow('leads.company') || 'Company',
    translateNow('leads.companyDomain') || 'Company domain',
    translateNow('leads.quality') || 'Quality',
    translateNow('leads.score') || 'Score',
    translateNow('leads.location') || 'Location',
    translateNow('leads.tags') || 'Tags',
    translateNow('leads.lastActive') || 'Last active',
  ];
  const rows = leads.map((lead) => {
    const tier = TIER_META[normalizeTier(lead.status)];
    return [
      csvField(lead.contact?.name),
      csvField(lead.contact?.email),
      csvField(lead.contact?.phone),
      csvField(companyDisplay(lead.contact)?.value),
      csvField(lead.contact?.company),
      csvField(tier.label),
      csvField(lead.score),
      csvField(blankIfUnknownLocation(formatLocation(lead.location))),
      csvField(tagsFor(lead.session_id).join('; ')),
      csvField(blankIfPlaceholder(formatDateTime(lead.last_active_at))),
    ].join(',');
  });
  return [header.map(csvField).join(','), ...rows].join('\r\n');
}
