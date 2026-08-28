/**
 * Contrast, computed rather than eyeballed.
 *
 * The console's own design language holds itself to measured ratios — every
 * token in `ui/tokens.css` carries the number it was verified at. The colours a
 * customer picks here end up as inline styles on their own website, in front of
 * their own visitors, and they deserve the same treatment: a brand colour that
 * puts white text at 2.1:1 is not a style choice, it is a message a portion of
 * that customer's visitors cannot read.
 *
 * So the picker states the ratio, names the pair it measured, and refuses to
 * present a failing pair as acceptable. It does not block the save: it is the
 * customer's brand, and a console that will not let a company use its own
 * colour is a console they stop using. It does offer the nearest shade of that
 * same hue that passes, which is the actual fix in one click.
 *
 * Everything here is pure and unit-tested. WCAG 2.2 SC 1.4.3 (4.5:1 for body
 * text) and SC 1.4.11 (3:1 for a non-text control boundary or glyph) are the
 * two bars used.
 */

/** Body text on a background. WCAG 2.2 SC 1.4.3. */
export const TEXT_CONTRAST_MIN = 4.5;

/** A glyph, icon or control boundary. WCAG 2.2 SC 1.4.11. */
export const NON_TEXT_CONTRAST_MIN = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1. The widget writes these straight into inline styles, and the backend
   *  accepts `#rrggbbaa`, so a translucent colour is a real possibility. */
  a: number;
}

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * True when the string is a hex colour the backend will accept.
 *
 * Deliberately the same shapes as `schemas/validators.py::HEX_COLOR_RE` plus
 * the four-digit short form the browser understands — a client check stricter
 * than the server's rejects values that would have worked.
 */
export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

/** Parse a hex colour, or `null` when it is not one. */
export function parseHex(value: string): Rgb | null {
  const raw = value.trim();
  if (!HEX_PATTERN.test(raw)) return null;
  let hex = raw.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }
  const int = Number.parseInt(hex.slice(0, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: alpha };
}

/** `#rrggbb`, lower case. Alpha is dropped: every consumer here is opaque. */
export function toHex({ r, g, b }: Pick<Rgb, 'r' | 'g' | 'b'>): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Flatten a translucent colour onto its background before measuring.
 *
 * Contrast is a property of what the eye receives, not of what was declared. A
 * 50%-alpha brand colour over a white panel is a pale tint, and measuring the
 * declared value would report a ratio no visitor ever sees.
 */
function composite(top: Rgb, bottom: Rgb): Rgb {
  if (top.a >= 1) return top;
  const mix = (a: number, b: number): number => a * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function linearize(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(color: Rgb): number {
  return (
    0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
  );
}

/**
 * The WCAG contrast ratio between two colours, 1–21.
 *
 * Returns `null` when either value is not a colour, so a half-typed `#ab` reads
 * as "not measurable yet" rather than as a failure the user has to dismiss.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const back = parseHex(background);
  const front = parseHex(foreground);
  if (!back || !front) return null;
  // The background is itself flattened onto white: every ground in the widget
  // that a customer can colour sits on the widget's own opaque panel.
  const opaqueBack = composite(back, { r: 255, g: 255, b: 255, a: 1 });
  const opaqueFront = composite(front, opaqueBack);
  const a = luminance(opaqueFront);
  const b = luminance(opaqueBack);
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

export type ContrastVerdict = 'pass' | 'fail' | 'unknown';

export interface ContrastCheck {
  ratio: number | null;
  verdict: ContrastVerdict;
  /** The bar this pair was judged against. */
  min: number;
  /** e.g. "White text on your brand colour". Always names both sides. */
  label: string;
}

/** Round to one decimal for display, the way the token table states its ratios. */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 10) / 10}:1`;
}

export function checkContrast(
  foreground: string,
  background: string,
  label: string,
  min: number = TEXT_CONTRAST_MIN,
): ContrastCheck {
  const ratio = contrastRatio(foreground, background);
  return {
    ratio,
    min,
    label,
    verdict: ratio === null ? 'unknown' : ratio >= min ? 'pass' : 'fail',
  };
}

// ── Suggesting a fix ─────────────────────────────────────────────────────────

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
  else if (max === green) hue = ((blue - red) / delta + 2) / 6;
  else hue = ((red - green) / delta + 4) / 6;
  return { h: hue, s: saturation, l: lightness };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const value = l * 255;
    return { r: value, g: value, b: value, a: 1 };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let shifted = t;
    if (shifted < 0) shifted += 1;
    if (shifted > 1) shifted -= 1;
    if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
    if (shifted < 1 / 2) return q;
    if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255, a: 1 };
}

/** One "this colour must be readable against that one" requirement. */
export interface ContrastConstraint {
  against: string;
  min: number;
}

/**
 * The nearest shade of the same hue that satisfies every constraint at once.
 *
 * Lightness only — hue and saturation are the brand, and a "fix" that shifts
 * them hands the customer a different colour and calls it theirs. Walks
 * outwards from the current lightness in both directions and returns the first
 * candidate that clears *all* the pairs the colour takes part in, so a fix for
 * one readout cannot quietly break another on the same card.
 *
 * Returns `null` when the input is not a colour, and falls back to black or
 * white for the rare case where no shade of the hue can satisfy the set.
 */
export function nearestAccessible(
  color: string,
  constraints: readonly ContrastConstraint[],
): string | null {
  const parsed = parseHex(color);
  if (!parsed || constraints.length === 0) return null;
  const satisfies = (candidate: string): boolean =>
    constraints.every(({ against, min }) => (contrastRatio(candidate, against) ?? 0) >= min);

  if (satisfies(color)) return toHex(parsed);

  const base = toHsl(parsed);
  for (let step = 1; step <= 100; step += 1) {
    for (const direction of [-1, 1]) {
      const lightness = base.l + (direction * step) / 100;
      if (lightness < 0 || lightness > 1) continue;
      const candidate = toHex(fromHsl({ ...base, l: lightness }));
      if (satisfies(candidate)) return candidate;
    }
  }
  // Degenerate case: constraints no shade of this hue can meet. Black and white
  // are the two extremes, and one of them is always the least bad answer.
  const score = (candidate: string): number =>
    Math.min(...constraints.map(({ against }) => contrastRatio(candidate, against) ?? 0));
  return score('#000000') >= score('#ffffff') ? '#000000' : '#ffffff';
}
