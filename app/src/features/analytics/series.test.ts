import { describe, expect, it } from 'vitest';
import { buildDailySeries, comparisonPoints, splitWindows, summarize } from './series';

/**
 * `/analytics/activity` returns every day the workspace has ever had and takes
 * no window parameter, so the entire period-over-period comparison is this
 * arithmetic. If it is wrong, every delta on the surface is wrong and nothing
 * on screen says so.
 */

const NOW = new Date(2026, 7, 19); // 19 August 2026, local.

function day(offset: number): string {
  const date = new Date(2026, 7, 19 - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('buildDailySeries', () => {
  it('fills the gaps between recorded days with explicit zeros', () => {
    const series = buildDailySeries([{ date: day(3), messages: 5 }, { date: day(0), messages: 2 }], NOW);
    // Seven days minimum, so a two-day-old account still draws a line rather
    // than two dots; the untouched days are explicit zeros, not holes.
    expect(series).toHaveLength(7);
    expect(series.map((point) => point.messages)).toEqual([0, 0, 0, 5, 0, 0, 2]);
  });

  it('runs through today even when the last recorded day is older', () => {
    const series = buildDailySeries([{ date: day(2), messages: 1 }], NOW);
    expect(series[series.length - 1].date).toBe(day(0));
  });

  it('sums two rows landing on the same day', () => {
    const series = buildDailySeries(
      [
        { date: `${day(1)}T04:00:00Z`, messages: 3 },
        { date: `${day(1)}T19:00:00Z`, messages: 4 },
      ],
      NOW,
    );
    expect(series.find((point) => point.date === day(1))?.messages).toBe(7);
  });

  it('survives an empty or malformed feed', () => {
    expect(buildDailySeries([], NOW)).toHaveLength(7);
    expect(buildDailySeries(null, NOW)).toHaveLength(7);
  });
});

describe('splitWindows', () => {
  const series = buildDailySeries(
    Array.from({ length: 20 }, (_, index) => ({ date: day(index), messages: index + 1 })),
    NOW,
  );

  it('cuts the selected window and the one immediately before it', () => {
    const windows = splitWindows(series, 7);
    expect(windows.selected).toHaveLength(7);
    expect(windows.preceding).toHaveLength(7);
    expect(windows.preceding[windows.preceding.length - 1].date).toBe(
      series[series.length - 8].date,
    );
  });

  it('gives all time the whole series and no comparison window', () => {
    const windows = splitWindows(series, null);
    expect(windows.selected).toHaveLength(series.length);
    expect(windows.preceding).toEqual([]);
  });

  it('truncates the comparison window on an account younger than two of them', () => {
    const windows = splitWindows(series, 15);
    expect(windows.selected).toHaveLength(15);
    expect(windows.preceding).toHaveLength(5);
  });
});

describe('summarize', () => {
  it('reports total, daily average and the busiest day', () => {
    const series = buildDailySeries(
      [
        { date: day(2), messages: 10 },
        { date: day(1), messages: 30 },
        { date: day(0), messages: 20 },
      ],
      NOW,
    );
    const summary = summarize(series);
    expect(summary.total).toBe(60);
    // Averaged over the days in the window, including the silent ones the
    // seven-day floor adds: 60 across 7 days.
    expect(summary.dailyAverage).toBe(9);
    expect(summary.peak).toBe(30);
    expect(summary.peakLabel).not.toBeNull();
  });

  it('has no busiest day when nothing was sent', () => {
    // `null`, not the first day of the window: a peak of zero did not happen on
    // any particular day, and naming one would be a fact the data does not hold.
    expect(summarize([]).peakLabel).toBeNull();
    expect(summarize(buildDailySeries([], NOW)).peakLabel).toBeNull();
  });
});

describe('comparisonPoints', () => {
  const series = buildDailySeries(
    Array.from({ length: 12 }, (_, index) => ({ date: day(index), messages: index + 1 })),
    NOW,
  );

  it('pairs each day with the same day of the previous window', () => {
    const points = comparisonPoints(splitWindows(series, 4));
    expect(points).toHaveLength(4);
    expect(points.every((point) => point.previous !== null)).toBe(true);
  });

  it('leaves unmatched days null rather than claiming a quiet day', () => {
    const points = comparisonPoints(splitWindows(series, 10));
    // Only two days of history precede a ten-day window here, so the first
    // eight plotted days have no counterpart. A zero would read as a day with
    // no traffic, which is a different claim from "we were not collecting yet".
    expect(points.slice(0, 8).every((point) => point.previous === null)).toBe(true);
    expect(points[8].previous).not.toBeNull();
  });

  it('has no comparison at all on an all-time window', () => {
    const points = comparisonPoints(splitWindows(series, null));
    expect(points.every((point) => point.previous === null)).toBe(true);
  });
});
