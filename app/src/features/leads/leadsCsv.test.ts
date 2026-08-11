/**
 * The CSV is the only place a lead leaves the product, so it is the one view
 * where a missing field is unrecoverable — a sheet built from an export that
 * dropped the resolved company cannot get it back without re-exporting.
 *
 * Two columns, deliberately: 'Company' carries the resolved identity when the
 * paid lookup found one, and 'Company domain' always carries the raw domain.
 * Collapsing them would break any downstream sheet keyed on the domain.
 */
import { describe, expect, it } from 'vitest';

import { type Lead } from '../../types/domain';

import { buildSelectedLeadsCsv } from './leadsCsv';

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
