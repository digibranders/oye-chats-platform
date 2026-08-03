import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricCard } from './MetricCard';

/**
 * The value row carries exactly one secondary figure. These pin the precedence
 * so a future edit can't silently push captioned tiles back onto a second line
 * (which is what made the old tile ~40% taller than it needed to be).
 */
describe('MetricCard', () => {
  it('renders the label and value', () => {
    const { getByText } = render(<MetricCard label="Credits used" value="1,284" />);

    expect(getByText('Credits used')).toBeInTheDocument();
    expect(getByText('1,284')).toBeInTheDocument();
  });

  it('puts a caption on the value row when there is no delta', () => {
    const { container, getByText } = render(
      <MetricCard label="AI chat replies" value="0" caption="0 credits" />,
    );

    expect(getByText('0 credits')).toBeInTheDocument();
    // Two rows total: label row + value row. No third line.
    expect(container.firstElementChild?.children).toHaveLength(2);
  });

  it('gives the value row to the delta and drops the caption to its own line', () => {
    const { container, getByText } = render(
      <MetricCard label="Conversations" value="1,284" delta="+12%" trend="up" caption="vs. last week" />,
    );

    expect(getByText('+12%')).toBeInTheDocument();
    expect(getByText('vs. last week')).toBeInTheDocument();
    expect(container.firstElementChild?.children).toHaveLength(3);
  });

  it('ignores a delta with no trend', () => {
    const { queryByText } = render(<MetricCard label="Leads" value="12" delta="+3" />);

    expect(queryByText('+3')).not.toBeInTheDocument();
  });
});
