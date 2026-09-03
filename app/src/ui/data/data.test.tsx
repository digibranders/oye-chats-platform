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

  it('shows the error state, not a crash, when the server sends a non-array', () => {
    // `/documents` answered with an object and `visibleRows.map is not a
    // function` took the WHOLE Knowledge page down through its error boundary,
    // table and all. A list this component cannot read is a failed load.
    render(
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={{} as never}
        rowKey={(row) => row.id}
      />,
    );
    expect(screen.getByText(/could not read this list/i)).toBeInTheDocument();
  });

  it('does not call an unreadable list empty', () => {
    // The empty state is a CLAIM: "there are none". Saying it about a list that
    // failed to load tells the customer their data is gone.
    render(
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={{} as never}
        rowKey={(row) => row.id}
        empty={<span>No invoices yet</span>}
      />,
    );
    expect(screen.queryByText('No invoices yet')).not.toBeInTheDocument();
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
            {/* rtl-ok: numeric figure — digits stay right-aligned regardless of direction */}
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
    // rtl-ok: numeric figure — digits stay right-aligned regardless of direction
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
        label="Volume"
        columns={3}
        items={[
          { label: 'Conversations', value: '412' },
          { label: 'Messages', value: '3,180' },
          { label: 'Visitors now', value: '7', period: 'Right now' },
        ]}
      />,
    );
    // Once, for the strip. Four repetitions was four lines of grey type carrying
    // one fact; **zero** — which is what shipped, because the tiles were told to
    // suppress theirs and the strip printed nothing in their place — left the
    // figures unanchored, which is the whole reason `period` is required.
    const caption = screen.getByText('Last 30 days');
    expect(screen.queryAllByText('Last 30 days')).toHaveLength(1);
    // And it is part of what the strip announces, not a loose line after it.
    expect(screen.getByRole('group', { name: 'Volume' })).toHaveAttribute(
      'aria-describedby',
      caption.id,
    );
    // A tile that genuinely covers a different window still states its own.
    expect(screen.getByText('Right now')).toBeInTheDocument();
  });

  it('drops the strip caption when every tile states its own window', () => {
    render(
      <StatRow
        period="Last 30 days"
        columns={2}
        items={[
          { label: 'Visitors now', value: '7', period: 'Right now' },
          { label: 'Rating', value: '4.6', period: 'All time' },
        ]}
      />,
    );
    // A caption contradicted by every tile under it is worse than none.
    expect(screen.queryByText('Last 30 days')).toBeNull();
    expect(screen.getByText('Right now')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
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

  it('sizes its controls under the field, so a hover cannot paint over the border', () => {
    // Everything is `box-sizing: border-box`, so a compact field's 28px is 26
    // of content once its own 1px border is out. `icon-sm` is 28 — the buttons
    // were a pixel taller than the room they had, and `ghost`'s opaque hover
    // fill covered the top and bottom border wherever the pointer landed. The
    // outline looked like it broke under the cursor, on all nine compact
    // fields in the app.
    const { rerender } = render(<CopyField compact label="API key" value="sk_live_123" secret />);
    // `icon-xs`: 24 inside 26, a pixel of ground each side.
    expect(screen.getByRole('button', { name: 'Copy API key' }).className).toMatch(/\bh-6\b/);

    // The default field is 34 (32 of content) and has always had room for a 28.
    rerender(<CopyField label="API key" value="sk_live_123" secret />);
    expect(screen.getByRole('button', { name: 'Copy API key' }).className).toMatch(
      /\bh-control-sm\b/,
    );
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

describe('DataTable fits a narrow column instead of scrolling out of it', () => {
  const COLUMNS = [
    { key: 'name', header: 'Chatbot', render: (row: { name: string }) => row.name },
    { key: 'documents', header: 'Documents', width: '6rem', render: () => '412' },
    { key: 'actions', header: '', width: '5rem', render: () => <button type="button">Open</button> },
  ];
  const ROWS = [{ id: 'b1', name: 'Acme Support' }];

  it('scrolls by default, because that is what makes a pinned column mean anything', () => {
    const { container } = render(
      <DataTable
        caption="Chatbots"
        rowKey={(row: { id: string }) => row.id}
        rows={ROWS}
        columns={COLUMNS}
      />,
    );
    // `min-w-max` in an `overflow-auto` wrapper: every cell on one line, and the
    // table free to be wider than its box.
    expect(container.querySelector('table')?.className).toContain('min-w-max');
  });

  it('gives instead, when the caller says the column is the constraint', () => {
    // Home's chatbot table in a two-up grid lost its action column at the card's
    // right edge, behind a 6px scroll affordance under 44px rows that nobody
    // finds. A four-column table in a 26rem column does not want to be scrolled.
    const { container } = render(
      <DataTable
        fit
        caption="Chatbots"
        rowKey={(row: { id: string }) => row.id}
        rows={ROWS}
        columns={COLUMNS}
      />,
    );
    const table = container.querySelector('table');
    expect(table?.className).not.toContain('min-w-max');
    expect(table?.className).toContain('table-fixed');

    // With nowhere for an over-long cell to go, truncation is the default rather
    // than something a `width` happens to switch on.
    const cell = screen.getByText('Acme Support');
    expect(cell.className).toContain('truncate');

    // The action column is still rendered, which was the whole complaint.
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });
});


describe('DataTable says where its own edges are', () => {
  const COLUMNS = [
    { key: 'name', header: 'Chatbot', pinned: true, render: (row: { name: string }) => row.name },
    { key: 'seen', header: 'Last seen', secondary: true, render: () => '19 Aug 2026' },
  ];
  const ROWS = [{ id: 'b1', name: 'Acme Support' }];

  it('hides a secondary column by container width, not by viewport', () => {
    // A viewport breakpoint asks the window how wide the browser is, which in a
    // console full of panes is never the question: between 768 and about 1400
    // every column showed regardless of how narrow its card was, which is what
    // clipped the action column off a table in a two-up grid.
    const { container } = render(
      <DataTable
        caption="Chatbots"
        rowKey={(row: { id: string }) => row.id}
        rows={ROWS}
        columns={COLUMNS}
      />,
    );
    expect(screen.getByText('19 Aug 2026').className).toContain('@3xl/page:table-cell');
    expect(screen.getByText('19 Aug 2026').className).not.toContain('md:table-cell');
    // Which only means anything because the table is its own container.
    expect(container.firstElementChild?.className).toContain('@container/page');
  });

  it('marks both scroll edges on the scroller, before the first scroll event', () => {
    // `data-scroll-end` has to be correct on mount, or a table that overflows on
    // load shows no edge until it is touched — which is exactly the table this
    // is for. Both attributes are written from the ref callback.
    const { container } = render(
      <DataTable
        caption="Chatbots"
        rowKey={(row: { id: string }) => row.id}
        rows={ROWS}
        columns={COLUMNS}
      />,
    );
    const scroller = container.querySelector('.overflow-auto') as HTMLElement;
    expect(scroller.dataset.scrolled).toBe('false');
    expect(scroller.dataset.scrollEnd).toBe('true');

    // The fade is drawn on the OUTER box: an `::after` on the scroller would
    // scroll away with the content it is meant to be marking the end of.
    expect(container.firstElementChild?.className).toContain('console-scroll-edge');
  });
});


describe('a non-answer is not a figure', () => {
  it('typesets StatTile.empty as a phrase', () => {
    render(<StatTile label="Rating" value={undefined} empty="Not rated yet" period="All time" />);
    // It used to take the tile's whole value treatment — `.figure`,
    // `font-semibold`, `text-xl`, full ink — so "Not rated yet" shouted louder
    // than the 1,204 beside it, and a strip's loudest tile was the one with no
    // number in it.
    const phrase = screen.getByText('Not rated yet');
    expect(phrase.className).not.toContain('figure');
    expect(phrase.className).not.toContain('font-semibold');
    expect(phrase.className).toContain('text-text-tertiary');
  });

  it('keeps a real value a figure', () => {
    render(<StatTile label="Conversations" value="1,204" period="Last 30 days" />);
    expect(screen.getByText('1,204').className).toContain('figure');
  });
});

describe('a state seated in a padded body', () => {
  it('drops its own horizontal gutter on request', () => {
    // Two gutters add up, and the state's copy sits 20px inside every label
    // around it — worked around twice with a negative margin before the prop
    // existed to fix it properly, and then a second time *after*: `StateBody`
    // composed `cn(geometry.root, flush && 'px-0')` with `px-cell` bundled
    // inside `geometry.root` — `tailwind-merge` does not know the custom
    // `px-cell` utility shares a CSS property with `px-0`, so it kept both
    // classes and standard utility ordering left `px-cell` live regardless of
    // `flush`. A test asserting only that `.px-0` exists in the DOM passed the
    // whole time, because `px-0` genuinely was there — it just never won. This
    // asserts the gutter class itself is gone, which is the fact that matters:
    // present is not the same question as winning.
    const { container: flushed } = render(
      <EmptyState flush size="inline" title="No conversations yet" />,
    );
    const { container: gutter } = render(
      <EmptyState size="inline" title="No conversations yet" />,
    );
    const flushedBody = flushed.querySelector('.py-6');
    const gutterBody = gutter.querySelector('.py-6');
    expect(flushedBody?.className).not.toMatch(/\bpx-cell\b/);
    expect(gutterBody?.className).toMatch(/\bpx-cell\b/);
  });

  it('is forced inline and flush when a table is handed one', () => {
    // `EmptyState`'s own default is `page` — a 340px centred block around a
    // 48px disc — so a table given a plain `<EmptyState>` rendered a full hero
    // inside its own body. The table owns the geometry of its own body.
    render(
      <DataTable
        caption="Gaps"
        rowKey={(row: { id: string }) => row.id}
        rows={[]}
        columns={[{ key: 'q', header: 'Question', render: () => null }]}
        empty={<EmptyState title="No gaps yet" description="Ask your chatbot something." />}
      />,
    );
    const state = screen.getByText('No gaps yet');
    // `inline` draws no disc and sets the title at row scale.
    expect(state.className).toContain('text-sm');
    expect(state.parentElement?.className).not.toMatch(/\bpx-cell\b/);
  });
});


describe('a sticky head sticks inside its own table', () => {
  it('never takes an offset, because there is nowhere for one to be measured from', () => {
    // The head sticks inside the table's own scroller, whose top edge is the
    // card's — so the only correct offset is 0. `stickyOffset` set `top` on the
    // `thead` and rendered as an empty band at the top of the card plus a
    // header overlapping row 1: on Leads, a 52px band with the head at y=454
    // over a first row at y=446.
    const { container } = render(
      <DataTable
        caption="Leads"
        stickyOffset="2.75rem"
        rowKey={(row: { id: string }) => row.id}
        rows={[{ id: 'a' }]}
        columns={[{ key: 'name', header: 'Name', render: () => 'Ana' }]}
      />,
    );
    const head = container.querySelector('thead') as HTMLElement;
    expect(head.className).toContain('sticky');
    expect(head.className).toContain('top-0');
    expect(head.getAttribute('style')).toBeNull();
  });
});


describe('DataTable countSummary', () => {
  const PROPS = {
    caption: 'Webhook reference',
    rowKey: (row: { id: string }) => row.id,
    rows: [{ id: 'a' }, { id: 'b' }],
    columns: [{ key: 'event', header: 'Event', render: () => 'invoice.paid' }],
  };

  it('states the row count by default', () => {
    const { container } = render(<DataTable {...PROPS} rowNoun="event" />);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('2 events');
  });

  it('drops it for a table whose length is a fact of the schema', () => {
    // "6 rows" under a six-row reference of what each webhook event means is a
    // number the reader has to read and then discard. Anything a query returned
    // keeps its count — that is what tells "12 sources" from "12 of 400".
    const { container } = render(<DataTable {...PROPS} rowNoun="event" countSummary={false} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });
});
