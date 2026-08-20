import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChartFrame, ChartLegend } from './ChartFrame';
import { ChartTooltip } from './ChartTooltip';
import { ChartDataTable } from './ChartDataTable';
import { RankedBars } from './RankedBars';
import { CHART_MARGIN, CHART_TICK_PX } from './theme';

describe('ChartFrame', () => {
  it('puts the legend under the plot and above the disclosure that hides the numbers', async () => {
    // Passed as a sibling *after* the frame — which one analytics chart did —
    // the painted order became chart, rule, "View as table", legend: the key to
    // the series ends up below a divider and below an unrelated control.
    const user = userEvent.setup();
    const { container } = render(
      <ChartFrame
        summary="Messages per day, peaking at 412 on 12 August."
        legend={<ChartLegend items={[{ label: 'Messages', seriesIndex: 0 }]} />}
        dataTable={
          <ChartDataTable
            caption="Messages per day"
            columns={[
              { key: 'day', header: 'Day' },
              { key: 'messages', header: 'Messages', numeric: true },
            ]}
            rows={[{ day: '12 Aug', messages: '412' }]}
          />
        }
      >
        <svg />
      </ChartFrame>,
    );
    const legend = screen.getByText('Messages');
    const toggle = screen.getByRole('button', { name: /view as table/i });
    // `compareDocumentPosition` returns FOLLOWING when the toggle comes after.
    expect(legend.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A real disclosure — a button over a labelled region — not the browser's
    // own triangle beside the system's chevron.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(container).getByRole('region')).toBeInTheDocument();
  });

  it('always states the series in words, because the picture is hidden from assistive tech', () => {
    render(
      <ChartFrame summary="Messages per day, peaking at 412 on 12 August.">
        <svg />
      </ChartFrame>,
    );
    expect(screen.getByText(/peaking at 412/)).toBeInTheDocument();
  });

  it('centres a failure in the plot area instead of stranding it at the top', () => {
    const { container } = render(
      <ChartFrame summary="Messages per day." error="The server did not respond." height={240}>
        <svg />
      </ChartFrame>,
    );
    const box = container.querySelector('[style*="height"]') as HTMLElement;
    expect(box.className).toContain('items-center');
    expect(screen.getByText('The server did not respond.')).toBeInTheDocument();
  });
});

describe('ChartDataTable', () => {
  it('right-aligns its figures, so the digits form a column', () => {
    render(
      <ChartDataTable
        caption="Messages per day"
        columns={[
          { key: 'day', header: 'Day' },
          { key: 'messages', header: 'Messages', numeric: true },
        ]}
        rows={[{ day: '12 Aug', messages: '412' }]}
      />,
    );
    const cell = screen.getByRole('cell', { name: '412' });
    expect(cell.className).toContain('text-right');
    expect(cell.className).toContain('figure');
  });
});

describe('ChartTooltip', () => {
  it('names each series and states its figure', () => {
    render(
      <ChartTooltip
        label="12 Aug"
        rows={[
          { name: 'Messages', value: '412', seriesIndex: 0 },
          { name: 'Conversations', value: '96', seriesIndex: 1 },
        ]}
      />,
    );
    expect(screen.getByText('12 Aug')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('96')).toBeInTheDocument();
  });
});

describe('RankedBars', () => {
  const items = [
    { id: 'a', label: 'Pricing', value: 40, display: '40' },
    { id: 'b', label: 'Refunds', value: 10, display: '10' },
  ];

  it('fills from the data ramp, never from the interactive blue', () => {
    // Two panels painted their bars `bg-accent-500` and one `bg-accent-50` — a
    // background token, which measured 1.05:1 on its own track.
    const { container } = render(<RankedBars label="Top questions" items={items} />);
    const fill = container.querySelector('[aria-hidden] > div') as HTMLElement;
    expect(fill.className).toContain('bg-chart-1');
    expect(fill.className).not.toContain('accent');
  });

  it('says so when it has nothing to rank, rather than rendering an empty list', () => {
    render(<RankedBars label="Top questions" items={[]} emptyTitle="No questions yet" />);
    expect(screen.getByText('No questions yet')).toBeInTheDocument();
  });

  it('loads into its own shape rather than into a roster row', () => {
    const { container } = render(<RankedBars label="Top questions" items={items} loading />);
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    expect(screen.queryByText('Pricing')).not.toBeInTheDocument();
  });

  it('keeps a selectable row a real control with its own state', async () => {
    const user = userEvent.setup();
    let pressed = 0;
    render(
      <RankedBars
        label="Outcomes"
        items={[{ id: 'a', label: 'Booked a meeting', value: 3, selected: true, onSelect: () => (pressed += 1) }]}
      />,
    );
    const row = screen.getByRole('button', { name: /booked a meeting/i });
    expect(row).toHaveAttribute('aria-pressed', 'true');
    await user.click(row);
    expect(pressed).toBe(1);
  });
});

describe('chart theme', () => {
  it('pins the axis tick size to the 2xs rung it cannot reference', () => {
    // Recharts writes the size into an SVG presentation attribute, where a
    // `var()` does not resolve, so the number is restated in `theme.ts`. The
    // token cannot be read back here — Vite hands a `?raw` stylesheet to the
    // test environment as an empty string — so this pins the restatement
    // instead: `--text-2xs` is 0.6875rem = 11px (`tokens.css`), and a change to
    // either side has to come past this line.
    expect(CHART_TICK_PX).toBe(11);
  });

  it('ends the plot on the card’s own padding edge', () => {
    // Any right margin here is added to the card's 20px padding, so the plot
    // stops short of the edge every other child of that card reaches.
    expect(CHART_MARGIN.right).toBe(0);
  });
});
