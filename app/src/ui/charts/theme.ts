/**
 * The console's one chart palette.
 *
 * The app it replaces had six independent palettes across three theme modules,
 * so the same "conversations" series was a different colour on the dashboard,
 * the agent overview and the journey view. One series, one colour, everywhere.
 *
 * The order is chosen for maximum separation between the first pairs, because
 * most charts here show two or three series and almost none show eight.
 */
export const CHART_SERIES = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-7)',
  'var(--color-chart-8)',
] as const;

/**
 * Dash patterns, applied from the fifth series onward.
 *
 * The palette's greyscale spread is narrow, so past four lines hue alone stops
 * separating them — for anyone with a colour vision deficiency, and for anyone
 * printing the page. Stroke pattern is the redundant channel that fixes it.
 */
export const CHART_DASH = [undefined, undefined, undefined, undefined, '6 3', '2 3', '8 3 2 3', '4 2'] as const;

export function seriesColor(index: number): string {
  return CHART_SERIES[index % CHART_SERIES.length];
}

export function seriesDash(index: number): string | undefined {
  return CHART_DASH[index % CHART_DASH.length];
}

/** Shared Recharts geometry, so every chart in the app has the same rhythm. */
export const CHART_AXIS = {
  stroke: 'var(--color-border)',
  tick: {
    fill: 'var(--color-text-tertiary)',
    fontSize: 11,
  },
  tickLine: false,
  axisLine: false,
} as const;

export const CHART_GRID = {
  stroke: 'var(--color-chart-grid)',
  strokeDasharray: '0',
  // Horizontal only. Vertical gridlines on a time series add ink without adding
  // a reading the axis ticks do not already give.
  vertical: false,
} as const;

export const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const;
