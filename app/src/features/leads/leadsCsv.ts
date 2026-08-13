/**
 * Client-side CSV assembly for "Export selected".
 *
 * Its own module rather than a helper inside `LeadsPage`: a component file
 * that also exports a plain function breaks React Fast Refresh, and this is
 * the one path where a dropped field leaves the product for good — it needs
 * tests of its own.
 */
import { csvSafe } from '../../lib/csvSafe';
import { type Lead } from '../../types/domain';

import { TIER_META, companyDisplay, formatDateTime, formatLocation, normalizeTier } from './leadModel';

/**
 * Escape one CSV field. Two independent defences, in order:
 *
 * 1. `csvSafe` stops a visitor-typed value from opening as a formula in the
 *    recipient's spreadsheet. Every cell goes through it — the columns are
 *    almost entirely visitor-supplied, and routing them all through one funnel
 *    means a column added later is safe without anyone remembering to be.
 * 2. RFC-4180 quoting keeps commas, quotes and newlines from breaking the
 *    record apart. It does nothing for defence 1: Excel evaluates `"=1+1"`
 *    exactly as it evaluates `=1+1`.
 */
function csvField(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  return `"${csvSafe(raw).replace(/"/g, '""')}"`;
}

/**
 * The table's placeholder for a missing value, which must not reach the file.
 *
 * A CSV says "no value" with an empty cell, not with a glyph meant for a table
 * cell — a CRM importing this would store a literal "-" as the last-active
 * date. It also keeps `csvSafe` from quoting the placeholder: a bare `-` is a
 * formula trigger, so an absent timestamp would otherwise export as `'-`.
 */
function blankIfPlaceholder(formatted: string): string {
  return formatted === '-' ? '' : formatted;
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
  // the raw email domain kept in its own column — a CSV that silently swapped
  // one for the other would break any sheet keyed on the domain.
  const header = [
    'Name',
    'Email',
    'Phone',
    'Company',
    'Company domain',
    'Quality',
    'Score',
    'Location',
    'Tags',
    'Last active',
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
      csvField(formatLocation(lead.location)),
      csvField(tagsFor(lead.session_id).join('; ')),
      csvField(blankIfPlaceholder(formatDateTime(lead.last_active_at))),
    ].join(',');
  });
  return [header.map(csvField).join(','), ...rows].join('\r\n');
}
