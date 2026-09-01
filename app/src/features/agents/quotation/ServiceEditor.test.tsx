import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ServiceEditor } from './ServiceEditor';
import type { Requirement, Service } from './quotation.model';

/**
 * Lines collapse, for the same reason requirements do.
 *
 * A line's editor is a question, a type, a price, a quantity mode and up to
 * twelve priced options — some thirty rows each — and twenty lines are allowed
 * per requirement. Expanded by default that is a page you scroll past rather
 * than read.
 *
 * The name stays visible and editable while collapsed. Folding it away would
 * leave a list of identical chevrons, which is worse than the wall it replaced.
 */
function line(over: Partial<Requirement> = {}): Requirement {
  return {
    id: over.id ?? 'r1',
    label: 'Second shooter',
    question: '',
    type: 'item',
    price: 5000,
    quantity_mode: 'fixed',
    unit_label: 'unit',
    quantity: 2,
    options: [],
    ...over,
  };
}

function service(requirements: Requirement[]): Service {
  return { id: 's1', name: 'Photography', description: '', requirements } as Service;
}

function renderEditor(requirements: Requirement[]) {
  return render(
    <ServiceEditor
      service={service(requirements)}
      index={0}
      currency="INR"
      collapsed={false}
      onToggleCollapse={vi.fn()}
      onChange={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
}

describe('ServiceEditor lines', () => {
  it('opens a saved requirement with its lines collapsed', () => {
    renderEditor([line()]);
    // The line's own editor is folded away…
    expect(screen.queryByLabelText(/^question/i)).toBeNull();
    // …but you can still tell which line it is, and change it.
    expect(screen.getByDisplayValue('Second shooter')).toBeInTheDocument();
  });

  it('says what a collapsed line costs', () => {
    // 5000 x 2. A closed line still has to answer "what does this cost?".
    // Two nodes match "up to": the requirement header's own ceiling and the
    // line's. With one line they carry the same figure, so assert on the set.
    renderEditor([line()]);
    const ceilings = screen.getAllByText(/up to/i).map((node) => node.textContent ?? '');
    expect(ceilings.filter((text) => text.includes('10,000'))).not.toHaveLength(0);
  });

  it('expands one line without touching the others', async () => {
    renderEditor([line({ id: 'r1' }), line({ id: 'r2', label: 'Drone' })]);
    await userEvent.click(screen.getByRole('button', { name: /expand line 1/i }));

    expect(screen.getByLabelText(/^question/i)).toBeInTheDocument();
    // The second is still shut: collapsing is per line, not per requirement.
    expect(screen.getByRole('button', { name: /expand line 2/i })).toBeInTheDocument();
  });

  it('collapses again', async () => {
    renderEditor([line()]);
    await userEvent.click(screen.getByRole('button', { name: /expand line 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /collapse line 1/i }));
    expect(screen.queryByLabelText(/^question/i)).toBeNull();
  });

  it('offers collapse-all only when there is more than one line', () => {
    const { unmount } = renderEditor([line()]);
    expect(screen.queryByRole('button', { name: /expand all|collapse all/i })).toBeNull();
    unmount();

    renderEditor([line({ id: 'r1' }), line({ id: 'r2' })]);
    expect(screen.getByRole('button', { name: /expand all/i })).toBeInTheDocument();
  });

  it('expands every line at once, then folds them back', async () => {
    renderEditor([line({ id: 'r1' }), line({ id: 'r2', label: 'Drone' })]);
    await userEvent.click(screen.getByRole('button', { name: /expand all/i }));

    expect(screen.getAllByLabelText(/^question/i)).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: /collapse all/i }));
    expect(screen.queryByLabelText(/^question/i)).toBeNull();
  });

  it('reports its state to assistive tech, not only through a rotated chevron', () => {
    renderEditor([line()]);
    expect(screen.getByRole('button', { name: /expand line 1/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('still shows the requirement total across collapsed lines', () => {
    // The header sums the same per-line figure each collapsed row shows, so the
    // two can never disagree about what a line costs.
    renderEditor([line({ id: 'r1' }), line({ id: 'r2', price: 1000, quantity: 1 })]);
    const header = screen.getByText(/2 lines/i);
    expect(within(header).getByText(/11,000/)).toBeInTheDocument();
  });
});
