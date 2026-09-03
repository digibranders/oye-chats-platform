import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FeedbackTrendChart } from './FeedbackTrendChart';
import type { FeedbackTrendPoint } from './feedback-helpers';

/**
 * What the chart's own words claim, against what it draws.
 *
 * `buildTrend` keeps only days that carry a rating and caps the result at the
 * most recent fourteen, while `overallRate` is the helpful share across every
 * rating in the range. So the caption's old "by day, over last 90 days" named a
 * window the axis does not cover, and calling the dashed line "the window's
 * average" described it as the average of points it is not computed from: on a
 * workspace whose last fortnight went badly it sits above every one of them,
 * and the reader is left to conclude the chart is broken.
 */

const fortnight: FeedbackTrendPoint[] = Array.from({ length: 14 }, (_, index) => ({
  date: `${index + 1} Jul`,
  rate: 40,
  total: 3,
}));

function renderChart(points: readonly FeedbackTrendPoint[] = fortnight) {
  return render(
    <FeedbackTrendChart points={points} rangeLabel="Last 90 days" overallRate={85} />,
  );
}

describe('FeedbackTrendChart. The caption describes what is plotted', () => {
  it('names the plotted days rather than the whole range', () => {
    renderChart();

    expect(
      screen.getByText(/on the 14 most recent days in it that carry a rating, fourteen at most/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/by day, over last 90 days/)).toBeNull();
  });

  it('does not call the dashed line the average of the days on the chart', () => {
    renderChart();

    expect(screen.queryByText(/window's average/)).toBeNull();
    expect(
      screen.getByText(
        /dashed line is the 85% helpful share over the whole window, counted across every rating in it rather than across the days plotted, so it can sit outside them/,
      ),
    ).toBeInTheDocument();
  });

  it('says so in the legend too, where the figure is actually read', () => {
    renderChart();

    expect(screen.getByText(/Dashed: helpful share over last 90 days/)).toBeInTheDocument();
  });

  it('counts only the days it has, when the window holds fewer than the cap', () => {
    renderChart(fortnight.slice(0, 3));

    expect(
      screen.getByText(/on the 3 most recent days in it that carry a rating/),
    ).toBeInTheDocument();
  });
});
