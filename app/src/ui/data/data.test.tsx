import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type Column } from './DataTable';
import { EmptyState, ErrorState, FullPageState, LockedState } from './States';
import { DefinitionList, StatRow, StatTile } from './Figures';
import { CopyField } from './Copyable';

/**
 * Contracts that are invisible until they break, rendered the way a feature
 * renders them rather than the way their author imagined. Every case below is a
 * defect that shipped: a download button a row overlay made unclickable, a table
 * that reported its size only when it had more than one page, a locked panel
 * that drew a second card inside the first, a copy control that sat outside the
 * field it belonged to.
 */

interface Invoice {
  id: string;
  number: string;
  amount: number;
}

const INVOICES: Invoice[] = [
  { id: 'in_1', number: 'INV-001', amount: 4200 },
  { id: 'in_2', number: 'INV-002', amount: 1900 },
];

describe('DataTable row activation', () => {
  /** The invoice table: a clickable row whose last cell holds a download. */
  function invoiceColumns(onDownload: () => void): Column<Invoice>[] {
    return [
      { key: 'number', header: 'Invoice', render: (row) => row.number },
      { key: 'amount', header: 'Amount', type: 'number', render: (row) => row.amount },
      {
        key: 'pdf',
        header: 'Document',
        render: () => (
          <button type="button" onClick={onDownload}>
            PDF
          </button>
        ),
      },
    ];
  }

  it('lets a control in a later cell be pressed without opening the row', async () => {
    // The stretched pseudo-element this replaces painted over every later cell:
    // the PDF download in the invoice table was genuinely unclickable, and
    // pressing it opened the drawer instead.
    const onRowClick = vi.fn();
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTable
        caption="Invoices"
        columns={invoiceColumns(onDownload)}
        rows={INVOICES}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );
    await user.click(screen.getAllByRole('button', { name: 'PDF' })[0]);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('opens the row from anywhere else in it, and from the keyboard', async () => {
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTable
        caption="Invoices"
        columns={invoiceColumns(() => {})}
        rows={INVOICES}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );
    await user.click(screen.getByRole('cell', { name: '4200' }));
    expect(onRowClick).toHaveBeenCalledWith(INVOICES[0]);

    // The keyboard path is a real control inside the first cell — never a role
    // on the `tr`, which would strip the row out of the table entirely.
    const activator = screen.getByRole('button', { name: 'INV-002' });
    activator.focus();
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith(INVOICES[1]);
    // Once, not twice: the activator handles itself and the row's own handler
    // has to stand back for it.
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });
});

describe('DataTable count, states and structure', () => {
  const columns: Column<Invoice>[] = [
    { key: 'number', header: 'Invoice', render: (row) => row.number },
    { key: 'amount', header: 'Amount', type: 'number', render: (row) => row.amount },
  ];

  it('states how many rows there are even with no pager, in the caller’s noun', () => {
    // The count used to live inside the pager, which renders only past one page,
    // so six tables in the app reported their size nowhere at all.
    render(
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={INVOICES}
        rowKey={(row) => row.id}
        rowNoun="invoice"
      />,
    );
    expect(screen.getByText(/invoices$/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('renders the fourth state itself instead of leaving it to a feature wrapper', async () => {
    const onUpgrade = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        forbidden={{
          title: 'Billing is not yours to see',
          description: 'An owner can open it for you.',
          action: (
            <button type="button" onClick={onUpgrade}>
              Ask an owner
            </button>
          ),
        }}
      />,
    );
    expect(screen.getByText('Billing is not yours to see')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask an owner' }));
    expect(onUpgrade).toHaveBeenCalled();
  });

  it('names a row with a row header and totals it in a real tfoot', () => {
    // The two reasons two surfaces under /billing hand-built their own tables.
    render(
      <DataTable
        caption="Credit costs"
        columns={[
          { key: 'number', header: 'Invoice', rowHeader: true, render: (row) => row.number },
          { key: 'amount', header: 'Amount', type: 'number', render: (row) => row.amount },
        ]}
        rows={INVOICES}
        rowKey={(row) => row.id}
        footer={
          <tr>
            <th scope="row">Total</th>
            <td className="figure text-right">6100</td>
          </tr>
        }
      />,
    );
    const rowHeader = screen.getByRole('rowheader', { name: 'INV-001' });
    expect(rowHeader).toHaveAttribute('scope', 'row');
    const total = screen.getByRole('rowheader', { name: 'Total' });
    expect(total.closest('tfoot')).not.toBeNull();
    expect(within(total.closest('tr') as HTMLElement).getByRole('cell')).toHaveTextContent('6100');
  });

  it('sets a numeric column as a figure and right-aligns it without the caller asking twice', () => {
    render(
      <DataTable caption="Invoices" columns={columns} rows={INVOICES} rowKey={(row) => row.id} />,
    );
    const cell = screen.getByRole('cell', { name: '4200' });
    expect(cell.className).toContain('figure');
    expect(cell.className).toContain('text-right');
  });

  it('drops its own card when seated inside one, and keeps it when standing alone', () => {
    const { container, rerender } = render(
      <DataTable caption="Invoices" columns={columns} rows={INVOICES} rowKey={(row) => row.id} seated />,
    );
    // `<Card><DataTable/></Card>` painted a bordered rounded surface flush
    // inside another one: a doubled hairline and two 10px radii a pixel apart.
    expect((container.firstChild as HTMLElement).className).not.toContain('border-border');
    rerender(
      <DataTable caption="Invoices" columns={columns} rows={INVOICES} rowKey={(row) => row.id} />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('border-border');
  });

  it('sticks the column heads by default, without being asked for a maxHeight', () => {
    // `maxHeight` was passed at zero of the app's forty call sites, so the
    // sticky path was dead code and every table lost its heads after eight rows.
    render(
      <DataTable caption="Invoices" columns={columns} rows={INVOICES} rowKey={(row) => row.id} />,
    );
    const head = screen.getAllByRole('rowgroup')[0];
    expect(head.className).toContain('sticky');
  });
});

describe('DataTable selection', () => {
  const columns: Column<Invoice>[] = [
    { key: 'number', header: 'Invoice', render: (row) => row.number },
  ];

  it('keeps select-all reachable while the bulk bar is up, and moves nothing', async () => {
    // The bar used to mount above the `thead`, pushing the whole body down by
    // its height at the exact moment the pointer was on a checkbox — so the next
    // click landed on the wrong row. It is painted over the header now, beside
    // the selection column rather than across it.
    const user = userEvent.setup();
    function Harness() {
      const [selected, setSelected] = useState<Set<string>>(new Set());
      return (
        <DataTable
          caption="Invoices"
          columns={columns}
          rows={INVOICES}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.number}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          bulkActions={<button type="button">Download</button>}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'Select INV-001' }));
    expect(screen.getByText(/selected/)).toHaveTextContent('1 selected');
    // Still exactly one select-all control, and it still works.
    const selectAll = screen.getByRole('checkbox', { name: /select all rows on this page/i });
    await user.click(selectAll);
    expect(screen.getByText(/selected/)).toHaveTextContent('2 selected');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });
});

describe('States', () => {
  it('does not draw a card around a state seated in one, and does around a page', () => {
    const { container, rerender } = render(
      <LockedState
        size="panel"
        title="Lead qualification is on Standard"
        description="Standard scores every conversation."
      />,
    );
    expect((container.firstChild as HTMLElement).className).not.toContain('border-border');
    rerender(
      <LockedState
        size="page"
        title="Lead qualification is on Standard"
        description="Standard scores every conversation."
      />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('border-border');
  });

  it('never draws a card around an empty or failed state, at any size', () => {
    // 154 of these are already inside a `CardBody`. A frame by default would
    // have manufactured the card-in-card the framing rule exists to remove.
    const { container, rerender } = render(<EmptyState size="page" title="No leads yet" />);
    expect((container.firstChild as HTMLElement).className).not.toContain('border-border');
    rerender(<ErrorState size="page" description="The server did not respond." />);
    expect((container.firstChild as HTMLElement).className).not.toContain('border-border');
  });

  it('reads an inline state from the left, like the rows it replaced', () => {
    const { container } = render(
      <EmptyState size="inline" title="No leads yet" description="Nothing matched this filter." />,
    );
    expect(container.querySelector('.text-center')).toBeNull();
  });

  it('lets a panel that is one of six stop interrupting the reader', () => {
    // `role="alert"` fires on mount and is right for a failure that arrives
    // while the user is reading something else. Six chart panels failing at once
    // on load is the case it is wrong for, and `polite` is how they say so.
    const { rerender } = render(<ErrorState size="panel" description="The server did not respond." />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(<ErrorState size="panel" polite description="The server did not respond." />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('gives a crashed window one heading and a way out', () => {
    render(
      <FullPageState
        tone="danger"
        title="The console did not start"
        description="Your chatbots keep answering visitors while this screen is up."
        actions={<button type="button">Reload</button>}
        footnote="developer@oyechats.com"
      />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('The console did not start');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});

describe('Figures', () => {
  it('states the window once for a strip, and only where a tile differs', () => {
    render(
      <StatRow
        period="Last 30 days"
        columns={3}
        items={[
          { label: 'Conversations', value: '412' },
          { label: 'Messages', value: '3,180' },
          { label: 'Visitors now', value: '7', period: 'Right now' },
        ]}
      />,
    );
    // Four repetitions of one caption was four lines of grey type carrying one
    // fact; the exception is the case the required prop existed for.
    expect(screen.queryAllByText('Last 30 days')).toHaveLength(0);
    expect(screen.getByText('Right now')).toBeInTheDocument();
  });

  it('says which way a delta went in words, not only in colour and an arrow', () => {
    render(
      <StatTile
        label="Conversations"
        value="412"
        period="Last 30 days"
        delta={{ value: '12%', direction: 'up', label: 'vs previous 30 days' }}
      />,
    );
    expect(screen.getByText(/up vs previous 30 days/)).toBeInTheDocument();
  });

  it('pairs every value with its own label in both layouts', () => {
    const items = [
      { label: 'Email', value: 'ana@acme.com' },
      { label: 'First seen', value: '19 Aug 2026' },
    ];
    const { container, rerender } = render(<DefinitionList items={items} layout="inline" />);
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(container.querySelectorAll('dd')).toHaveLength(2);
    rerender(<DefinitionList items={items} />);
    expect(container.querySelectorAll('dl')).toHaveLength(1);
  });
});

describe('CopyField', () => {
  it('keeps its controls inside the field, so the field ends where its card does', () => {
    // Rendered, the eye and copy buttons sat *outside* the chip: the field ended
    // 60px short of the code block below it in the same card.
    const { container } = render(<CopyField compact label="API key" value="sk_live_123" secret />);
    const field = container.firstChild as HTMLElement;
    expect(field).toContainElement(screen.getByRole('button', { name: 'Copy API key' }));
    expect(field).toContainElement(screen.getByRole('button', { name: 'Reveal API key' }));
  });

  it('masks a secret until it is revealed', async () => {
    const user = userEvent.setup();
    render(<CopyField label="API key" value="sk_live_123" secret />);
    expect(screen.queryByText('sk_live_123')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reveal API key' }));
    expect(screen.getByText('sk_live_123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide API key' })).toBeInTheDocument();
  });
});
