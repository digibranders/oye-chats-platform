import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PropertyGrid } from './PropertyGrid';
import { TooltipProvider } from '../overlays/Tooltip';
import { Button } from '../primitives/Button';

/**
 * Rendered the way a feature renders it — a record's facts, one of them missing,
 * one of them carrying a control — rather than the way the component's author
 * imagined it. Four accessibility defects shipped invisible in their own diffs
 * before that was the rule here.
 */
describe('PropertyGrid', () => {
  it('pairs every label with its value as a definition list', () => {
    render(
      <PropertyGrid
        label="Visitor"
        items={[
          { label: 'Country', value: 'India' },
          { label: 'Pages', value: 12 },
        ]}
      />,
    );

    const list = screen.getByRole('group', { name: 'Visitor' });
    // `dt`/`dd` is what makes "Country: India" one fact to a screen reader
    // rather than two unrelated strings.
    expect(within(list).getByText('Country').closest('dt')).not.toBeNull();
    expect(within(list).getByText('India').closest('dd')).not.toBeNull();
  });

  it('prints an em dash for an absent value rather than a blank cell', () => {
    // DESIGN.md rule 10. A blank cell cannot be told apart from a render that
    // failed, and `0` is a measurement somebody took.
    render(
      <PropertyGrid
        items={[
          { label: 'Company', value: undefined },
          { label: 'Referrer', value: '' },
          { label: 'Visits', value: 0 },
        ]}
      />,
    );

    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('keeps a row action reachable by keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <PropertyGrid
        items={[
          { label: 'Session', value: 'sess_9f2', action: <Button size="sm" onClick={onClick}>Copy</Button> },
        ]}
      />,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('gives a note a named control instead of hanging it off unfocusable text', async () => {
    // A tooltip on a bare `<dt>` is unreachable by keyboard and invisible on
    // touch — the exact failure the native `title` attribute has, which is why
    // `Tooltip` exists at all.
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <PropertyGrid items={[{ label: 'Tier', value: 'Warm', note: 'Set by BANT scoring.' }]} />
      </TooltipProvider>,
    );

    const info = screen.getByRole('button', { name: 'About Tier' });
    await user.hover(info);
    expect(await screen.findByText('Set by BANT scoring.')).toBeInTheDocument();
  });
});
