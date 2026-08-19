import { describe, expect, it } from 'vitest';
import { gstrFilename, gstrRowCount, isValidMonth, monthLabel, recentMonths, toMonthKey } from './gstr';

describe('the filing period', () => {
  it('accepts only what the server accepts', () => {
    // The handler's pattern is ^\d{4}-\d{2}$ and it answers 422 otherwise.
    expect(isValidMonth('2026-07')).toBe(true);
    expect(isValidMonth('2026-12')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('2026-7')).toBe(false);
    expect(isValidMonth('July 2026')).toBe(false);
  });

  it('spells the month out, because 07 and 2026-07 are both misreadable', () => {
    expect(monthLabel('2026-07')).toBe('July 2026');
    expect(monthLabel('2026-01')).toBe('January 2026');
    expect(monthLabel('2026-12')).toBe('December 2026');
  });

  it('leaves an unrecognisable value alone rather than inventing a month', () => {
    expect(monthLabel('nonsense')).toBe('nonsense');
  });

  it('keys a date to its calendar month', () => {
    expect(toMonthKey(new Date(2026, 7, 19))).toBe('2026-08');
    expect(toMonthKey(new Date(2026, 0, 1))).toBe('2026-01');
  });

  it('offers recent months newest first, starting with the current one', () => {
    const months = recentMonths(new Date(2026, 7, 19), 4);
    expect(months).toEqual(['2026-08', '2026-07', '2026-06', '2026-05']);
    for (const month of months) expect(isValidMonth(month)).toBe(true);
  });

  it('rolls back over a year boundary correctly', () => {
    expect(recentMonths(new Date(2026, 1, 10), 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });

  it('names the file after the month it covers', () => {
    expect(gstrFilename('2026-07')).toBe('gstr-2026-07.csv');
  });
});

/**
 * A header-only file for a month with nothing invoiced and a header-only file
 * from a misfired query look identical in a downloads folder, so the console
 * counts the rows and says which one the operator just got.
 */
describe('counting what came back', () => {
  const HEADER = 'section,invoice_number,invoice_date';

  it('counts document rows, not the summary block', () => {
    const csv = [HEADER, 'B2B,DB/1,2026-07-01', 'B2B,DB/2,2026-07-02', '', 'SUMMARY,section,count', 'SUMMARY,B2B,2'].join(
      '\n',
    );
    expect(gstrRowCount(csv)).toBe(2);
  });

  it('reports zero for a month with no documents', () => {
    expect(gstrRowCount([HEADER, '', 'SUMMARY,section,count', 'SUMMARY,TOTAL,0'].join('\n'))).toBe(0);
  });

  it('strips the byte-order mark the server prefixes for Excel', () => {
    const csv = `\uFEFF${[HEADER, 'B2B,DB/1,2026-07-01', ''].join('\n')}`;
    expect(gstrRowCount(csv)).toBe(1);
  });

  it('handles CRLF line endings', () => {
    expect(gstrRowCount([HEADER, 'B2B,DB/1,2026-07-01', '', 'SUMMARY,x,1'].join('\r\n'))).toBe(1);
  });

  it('reports zero for an empty response rather than throwing', () => {
    expect(gstrRowCount('')).toBe(0);
  });
});
