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
describe('PropertyGrid stacks in a column too narrow for a row', () => {
  it('asks its own container, not the viewport', () => {
    render(<PropertyGrid items={[{ label: 'First seen', value: '2 Jun 2026, 10:00' }]} />);
    const row = screen.getByText('First seen').closest('div');

    // Stacked is the BASE and the two-column row is the enhancement, so the
    // narrow case is correct with no query at all. The label column used to be
    // `minmax(7rem,10rem)` at every width, so in an 18rem aside a 112px label
    // left about 120px for the value: a timestamp wrapped onto three lines and
    // a URL broke mid-word.
    expect(row?.className).toContain('grid-cols-[minmax(0,1fr)]');
    expect(row?.className).toContain('@sm/page:grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)]');

    // A container query, so an 18rem aside on a 1920px screen gets the narrow
    // shape — which the `sm:` viewport query its predecessor used never did.
    expect(row?.className).not.toContain('sm:grid-cols-[minmax(7rem');
  });

  it('gives an inspector a narrower label track than a page does', () => {
    // `compact` is the inspector density and an inspector is narrow by
    // definition: a 10rem label track in a 288px pane left 71px for the value,
    // which broke `amara@example.com` as `amara@ex / ample.com`. The names in
    // an inspector are short, so the track can be.
    render(
      <PropertyGrid density="compact" items={[{ label: 'Email', value: 'amara@example.com' }]} />,
    );
    const row = screen.getByText('Email').closest('div');
    expect(row?.className).toContain('@sm/page:grid-cols-[minmax(4.5rem,8rem)_minmax(0,1fr)]');
    expect(row?.className).not.toContain('minmax(7rem,10rem)');
  });

  it('keeps forcing the stack when the caller asks for it', () => {
    render(
      <PropertyGrid
        layout="stacked"
        items={[{ label: 'First seen', value: '2 Jun 2026, 10:00' }]}
      />,
    );
    const row = screen.getByText('First seen').closest('div');
    expect(row?.className).not.toContain('@sm/page:grid-cols-');
  });
});

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
    // DESIGN.md rule 11. A blank cell cannot be told apart from a render that
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
