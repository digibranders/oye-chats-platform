/**
 * The browser-built CSV, for "export the rows I selected".
 *
 * Its own module rather than a helper inside the page: a component file that
 * also exports a plain function breaks React Fast Refresh, and this is the one
 * path where a dropped field leaves the product for good, so it needs tests of
 * its own.
 *
 * **Its columns deliberately mirror `GET /leads/export`**, in the same order,
 * with the same ISO timestamps and the same "absence is an empty cell" rule.
 * The two files used to disagree — different columns, different date formats,
 * one of them carrying a column the other did not — with nothing on screen
 * saying so, so a customer who exported twice got two incompatible
 * spreadsheets. They now differ in exactly one documented way: the last column,
 * which the server cannot produce because the data has never left this browser.
 */
import { csvField } from '../../lib/csvSafe';
import { type Lead } from '../../types/domain';
import { TIER_META, UNKNOWN_LOCATION, formatLocation, hasIntelligence, normalizeTier } from './leadModel';

/**
 * The one column the server export cannot have.
 *
 * Named, not implied: tags are stored in `localStorage` on this machine only,
 * and a column headed plain "Tags" in a file that gets mailed around reads as
 * workspace data that every teammate also has.
 */
// @i18n-exempt: a CSV column header, not chrome. The comment above HEADER
// explains the contract: these columns line up with the server's own export so
// the two files can be merged, and a downstream sheet keyed on them must not
// change shape because the reader switched the dashboard language.
export const LOCAL_TAGS_COLUMN = 'Tags (this browser only)';

/**
 * The server export's columns, in its order, followed by the two it does not
 * produce.
 *
 * "Company" is the raw email domain in both files, because that is what the
 * server writes and a downstream sheet keyed on the domain must not silently
 * receive a company name instead. The *resolved* identity — the thing the paid
 * enrichment produces — is appended as its own column rather than substituted,
 * so nothing is lost and the first sixteen columns still line up when the two
 * downloads are merged.
 *
 * Attribution columns are not reproduced: they are plan-gated server-side and
 * the list payload does not carry them, so emitting the headers with empty
 * cells would assert that a lead had no campaign when we never asked.
 */
// @i18n-exempt: see LOCAL_TAGS_COLUMN above. Data contract, not copy.
const HEADER = [
  'Session ID',
  'Name',
  'Email',
  'Phone',
  'Company',
  'Score',
  'Status',
  'Need',
  'Budget',
  'Authority',
  'Timeline',
  'Location',
  'Device',
  'Messages',
  'Created',
  'Last Active',
  'Company name',
  LOCAL_TAGS_COLUMN,
] as const;

/** One dimension's captured value, tolerating frameworks that lack it. */
function dimensionValue(lead: Lead, dimension: string): string {
  return lead.bant?.[dimension]?.value ?? '';
}

/**
 * ISO, like the server export.
 *
 * The two downloads previously formatted the same instant two ways — one ISO,
 * one "Jul 21, 3:04 PM" — so merging them in a spreadsheet produced a text
 * column beside a date column.
 */
function isoOrBlank(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * `formatLocation` answers the word "Unknown" for a session with no resolved
 * geography, which is right for a table cell and wrong for a file: a CRM
 * importing it creates a country by that name. The server writes an empty cell,
 * so this does too.
 */
function locationOrBlank(lead: Lead): string {
  const formatted = formatLocation(lead.location);
  return formatted === UNKNOWN_LOCATION ? '' : formatted;
}

export function buildSelectedLeadsCsv(
  leads: readonly Lead[],
  tagsFor: (sessionId: string) => readonly string[],
): string {
  const rows = leads.map((lead) => {
    // Free workspaces receive no score, tier, location or device at all — the
    // server deletes those keys rather than nulling them. Empty cells are the
    // honest rendering; a zero would be a claim.
    const scored = hasIntelligence(lead);
    return [
      csvField(lead.session_id),
      csvField(lead.contact?.name),
      csvField(lead.contact?.email),
      csvField(lead.contact?.phone),
      csvField(lead.contact?.company),
      csvField(scored ? lead.score : ''),
      csvField(scored ? TIER_META[normalizeTier(lead.status)].label : ''),
      csvField(dimensionValue(lead, 'need')),
      csvField(dimensionValue(lead, 'budget')),
      csvField(dimensionValue(lead, 'authority')),
      csvField(dimensionValue(lead, 'timeline')),
      csvField(locationOrBlank(lead)),
      csvField(lead.device === 'Unknown' ? '' : lead.device),
      csvField(lead.chats ?? ''),
      csvField(isoOrBlank(lead.created_at)),
      csvField(isoOrBlank(lead.last_active_at)),
      csvField(lead.contact?.company_name),
      csvField(tagsFor(lead.session_id).join('; ')),
    ].join(',');
  });
  return [HEADER.map(csvField).join(','), ...rows].join('\r\n');
}
