import { describe, expect, it } from 'vitest';
import {
  checkContrast,
  contrastRatio,
  formatRatio,
  isHexColor,
  nearestAccessible,
  parseHex,
  toHex,
} from './contrast';

/**
 * The contrast maths is the one thing on this page that must be right rather
 * than merely plausible: it is what the picker uses to tell a customer their
 * brand colour is unreadable, and a readout that is wrong in the generous
 * direction is worse than no readout at all.
 *
 * The expected ratios are the published WCAG values for these pairs.
 */

describe('parsing', () => {
  it('accepts every hex form the backend does', () => {
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('#FFFFFF')).toBe(true);
    expect(isHexColor('#ffffff80')).toBe(true);
    expect(isHexColor('  #2b66bc  ')).toBe(true);
    expect(isHexColor('white')).toBe(false);
    expect(isHexColor('#ab')).toBe(false);
    expect(isHexColor('#gggggg')).toBe(false);
  });

  it('expands the short form rather than reading it as a long one', () => {
    expect(parseHex('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('reads the alpha channel', () => {
    expect(parseHex('#00000000')?.a).toBe(0);
    expect(parseHex('#000000ff')?.a).toBe(1);
  });

  it('round-trips through hex', () => {
    expect(toHex({ r: 43, g: 102, b: 188 })).toBe('#2b66bc');
  });
});

describe('contrastRatio', () => {
  it('measures the two extremes at 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('measures a colour against itself at 1:1', () => {
    expect(contrastRatio('#2b66bc', '#2b66bc')).toBeCloseTo(1, 5);
  });

  it('is symmetric — which side is the text does not change the ratio', () => {
    const a = contrastRatio('#ffffff', '#2b66bc');
    const b = contrastRatio('#2b66bc', '#ffffff');
    expect(a).toBeCloseTo(b as number, 10);
  });

  it('agrees with the published ratio for a known pair', () => {
    // #767676 on white is the canonical 4.54:1 boundary case in the WCAG docs.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('flattens a translucent colour onto its ground before measuring', () => {
    // Black at 50% over white is a mid grey, not black: reporting 21:1 here
    // would tell a customer a bubble was readable when it is barely there.
    const translucent = contrastRatio('#00000080', '#ffffff') as number;
    expect(translucent).toBeLessThan(21);
    expect(translucent).toBeGreaterThan(1);
  });

  it('answers null rather than a number for a half-typed value', () => {
    expect(contrastRatio('#ab', '#ffffff')).toBeNull();
    expect(formatRatio(null)).toBe('—');
  });
});

describe('checkContrast', () => {
  it('grades against the bar it was given, not a fixed one', () => {
    // #949494 on white is ~3.0: a legal icon boundary and an illegal body text.
    expect(checkContrast('#949494', '#ffffff', 'icon', 3).verdict).toBe('pass');
    expect(checkContrast('#949494', '#ffffff', 'text', 4.5).verdict).toBe('fail');
  });

  it('reports an unparseable colour as unknown rather than as a failure', () => {
    expect(checkContrast('#ab', '#ffffff', 'text').verdict).toBe('unknown');
  });
});

describe('nearestAccessible', () => {
  it('returns the colour unchanged when it already passes', () => {
    expect(nearestAccessible('#000000', [{ against: '#ffffff', min: 4.5 }])).toBe('#000000');
  });

  it('darkens a pale colour until it clears the bar', () => {
    const fixed = nearestAccessible('#ffe08a', [{ against: '#ffffff', min: 4.5 }]);
    expect(fixed).not.toBeNull();
    expect(contrastRatio(fixed as string, '#ffffff') as number).toBeGreaterThanOrEqual(4.5);
  });

  it('satisfies every constraint at once, not just the first', () => {
    const constraints = [
      { against: '#ffffff', min: 3 },
      { against: '#000000', min: 3 },
    ];
    const fixed = nearestAccessible('#f0f0f0', constraints) as string;
    for (const { against, min } of constraints) {
      expect(contrastRatio(fixed, against) as number).toBeGreaterThanOrEqual(min);
    }
  });

  it('keeps the hue — a fix must still be the customer’s colour', () => {
    const fixed = parseHex(nearestAccessible('#ffd6d6', [{ against: '#ffffff', min: 4.5 }]) as string);
    expect(fixed).not.toBeNull();
    // Red stays the dominant channel.
    expect((fixed as { r: number }).r).toBeGreaterThan((fixed as { g: number }).g);
  });

  it('answers null for a value that is not a colour', () => {
    expect(nearestAccessible('nope', [{ against: '#ffffff', min: 4.5 }])).toBeNull();
  });
});
