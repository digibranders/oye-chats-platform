import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './primitives/Button';
import { Field } from './primitives/Field';
import { Input } from './primitives/Input';
import { Switch, Checkbox } from './primitives/Toggle';
import { Progress } from './primitives/Progress';
import { CodeBlock } from './data/Copyable';
import { SegmentedControl } from './primitives/SegmentedControl';
import { Tabs, TabPanel } from './layout/Tabs';
import { DataTable, type Column } from './data/DataTable';
import { RankedBars } from './charts/RankedBars';
import { ConfirmDialog } from './overlays/ConfirmDialog';
import { formatDuration, formatMoney, formatNumber, truncateId, ABSENT } from './lib/formatters';

/**
 * These cover the contracts that are invisible until they break: keyboard
 * behaviour, ARIA wiring, and the handful of defects the first draft of this
 * library actually shipped. Every one of them corresponds to a specific bug —
 * a component that rendered nothing, a tab row that selected on arrow, a
 * disabled control that re-enabled itself inside a form.
 */

describe('Button', () => {
  it('renders its children at icon sizes', async () => {
    // The first version dropped children whenever `size` was an icon size,
    // which left every close and pagination button in the system blank.
    render(
      <Button size="icon-sm" aria-label="Close">
        <span data-testid="glyph" />
      </Button>,
    );
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });

  it('blocks activation and reports busy while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    // The label survives: a button whose text vanishes mid-flight reflows the
    // row and leaves the user unsure what they pressed.
    expect(button).toHaveTextContent('Save');
  });
});

describe('Field', () => {
  it('describes the control with its hint and its error at once', () => {
    render(
      <Field label="Website" hint="Include https://" error="That is not a valid address.">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('Website');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedBy).toHaveLength(2);
    const described = describedBy.map((id) => document.getElementById(id)?.textContent).join(' ');
    // The hint is not replaced by the error — the format guidance has to survive
    // the moment the user fails to meet it.
    expect(described).toContain('Include https://');
    expect(described).toContain('not a valid address');
  });

  it('marks a required field for assistive tech, not just with an asterisk', () => {
    render(
      <Field label="Name" required>
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText(/name/i)).toHaveAttribute('aria-required', 'true');
  });
});

describe('Switch and Checkbox', () => {
  it('keeps an explicit disabled prop inside an enabled Field', () => {
    // `useFieldControlProps` used to emit `{ disabled: undefined }`, and a later
    // spread of an explicit `undefined` overrode the prop set beside it — which
    // silently re-enabled every disabled control inside a Field.
    render(
      <Field label="Live chat" disabled={false}>
        <Switch checked={false} onCheckedChange={() => {}} label="Live chat" hideLabel disabled />
      </Field>,
    );
    // `aria-disabled`, not the `disabled` attribute: the control stays in the
    // tab order so a screen-reader user can find it and learn it is off, rather
    // than it silently vanishing from the page.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
  });

  it('describes a switch by its description without folding it into the name', () => {
    render(
      <Switch
        checked
        onCheckedChange={() => {}}
        label="Live chat"
        description="Route conversations to a human when your team is online."
      />,
    );
    const control = screen.getByRole('switch');
    // The name is the label alone; the description is reachable separately.
    expect(control).toHaveAccessibleName('Live chat');
    expect(control).toHaveAccessibleDescription(/route conversations/i);
  });

  it('reports a mixed checkbox as mixed', () => {
    render(<Checkbox checked="indeterminate" aria-label="Select all" />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed');
  });
});

describe('SegmentedControl', () => {
  function Harness() {
    const [value, setValue] = useState('all');
    return (
      <SegmentedControl
        label="Status"
        value={value}
        onChange={setValue}
        items={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
        ]}
      />
    );
  }

  it('is one tab stop with arrow-key movement inside it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const options = screen.getAllByRole('radio');
    // Roving tabindex: only the selected option is reachable by Tab.
    expect(options[0]).toHaveAttribute('tabindex', '0');
    expect(options[1]).toHaveAttribute('tabindex', '-1');

    await user.tab();
    expect(options[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Open' })).toHaveAttribute('aria-checked', 'true');
  });

  it('wraps around at the end', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Closed' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Tabs', () => {
  it('does not select a tab merely because an arrow key landed on it', async () => {
    // Radix defaults to automatic activation. That is how the previous tab row
    // fired its upgrade modal at a keyboard user who was only passing through.
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('a');
      return (
        <Tabs
          label="Views"
          value={value}
          onValueChange={setValue}
          items={[
            { value: 'a', label: 'Overview' },
            { value: 'b', label: 'Locked' },
          ]}
        >
          <TabPanel value="a">A</TabPanel>
          <TabPanel value="b">B</TabPanel>
        </Tabs>
      );
    }
    render(<Harness />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Locked' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Locked' })).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'Locked' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('DataTable', () => {
  interface Row {
    id: string;
    name: string;
    score: number;
  }
  const rows: Row[] = [
    { id: '1', name: 'Ana', score: 10 },
    { id: '2', name: 'Bo', score: 30 },
    { id: '3', name: 'Cy', score: 20 },
  ];
  const columns: Column<Row>[] = [
    { key: 'name', header: 'Name', render: (row) => row.name },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      render: (row) => row.score,
      sortable: (a, b) => a.score - b.score,
    },
  ];

  function names(): string[] {
    return within(screen.getAllByRole('rowgroup')[1])
      .getAllByRole('row')
      .map((row) => within(row).getAllByRole('cell')[0].textContent ?? '');
  }

  it('cycles a sortable column ascending, descending, then back to unsorted', async () => {
    const user = userEvent.setup();
    render(<DataTable caption="Leads" columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const header = screen.getByRole('button', { name: /score/i });

    await user.click(header);
    expect(names()).toEqual(['Ana', 'Cy', 'Bo']);
    expect(screen.getByRole('columnheader', { name: /score/i })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    await user.click(header);
    expect(names()).toEqual(['Bo', 'Cy', 'Ana']);

    // The third press has to return to the server's own ordering.
    await user.click(header);
    expect(names()).toEqual(['Ana', 'Bo', 'Cy']);
    expect(screen.getByRole('columnheader', { name: /score/i })).not.toHaveAttribute('aria-sort');
  });

  it('keeps rows as rows when they are clickable', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        caption="Leads"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );
    // Giving a `tr` role="button" strips its implicit role="row", which drops
    // the whole table out of the accessibility tree.
    const body = screen.getAllByRole('rowgroup')[1];
    expect(within(body).getAllByRole('row')).toHaveLength(3);
  });

  it('scopes select-all to the visible page', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [selected, setSelected] = useState<Set<string>>(new Set());
      return (
        <DataTable
          caption="Leads"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.name}
          pageSize={2}
          selectedKeys={selected}
          onSelectionChange={setSelected}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: /select all rows on this page/i }));
    // Two of three: a "select all" that silently reaches rows the user cannot
    // see is how a bulk delete goes wrong.
    expect(screen.getByText(/selected/)).toHaveTextContent('2 selected');
  });

  it('names a selection checkbox by the row, not by its id', () => {
    render(
      <DataTable
        caption="Leads"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowLabel={(row) => row.name}
        selectedKeys={new Set()}
        onSelectionChange={() => {}}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Select Ana' })).toBeInTheDocument();
  });

  it('reports an error with a way back instead of an empty table', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTable
        caption="Leads"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        error="The server did not respond."
        onRetry={onRetry}
      />,
    );
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('does not strand the reader on a page that no longer exists', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [filtered, setFiltered] = useState(false);
      const data = filtered ? rows.slice(0, 1) : rows;
      return (
        <>
          <button type="button" onClick={() => setFiltered(true)}>
            Filter
          </button>
          <DataTable
            caption="Leads"
            columns={columns}
            rows={data}
            rowKey={(row) => row.id}
            pageSize={2}
          />
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(names()).toEqual(['Ana']);
  });
});

describe('ConfirmDialog', () => {
  it('announces as an alert dialog and starts focus on the safe choice', async () => {
    // Focus is moved after the popup mounts, so this waits rather than asserting
    // on the first frame.
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete chatbot"
        description="Its knowledge base and every conversation go with it."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('holds the confirm button until the phrase matches exactly', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete chatbot"
        description="This cannot be undone."
        confirmLabel="Delete"
        confirmPhrase="Acme Support"
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'Acme Support');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe('formatters', () => {
  it('renders an absent value as an em dash, never as zero', () => {
    expect(formatNumber(null)).toBe(ABSENT);
    expect(formatMoney(undefined, 'INR')).toBe(ABSENT);
    expect(formatNumber(0)).toBe('0');
  });

  it('keeps sub-minute precision, which is the point of measuring response time', () => {
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(3600)).toBe('1h');
  });

  it('drops decimals on whole amounts and keeps them otherwise', () => {
    expect(formatMoney(120000, 'INR')).toBe('₹1,200');
    expect(formatMoney(120050, 'INR')).toBe('₹1,200.50');
  });

  it('keeps both ends of an identifier so two keys cannot collapse into one', () => {
    expect(truncateId('bot-6a427d4529b9')).toBe('bot-6a42…29b9');
    expect(truncateId('bot-1')).toBe('bot-1');
  });
});

describe('DataTable server paging', () => {
  interface Row {
    id: string;
    name: string;
  }
  const COLUMNS: Column<Row>[] = [{ key: 'name', header: 'Name', render: (row) => row.name }];
  const PAGE: Row[] = [
    { id: '1', name: 'Ana' },
    { id: '2', name: 'Ben' },
  ];

  it('reports the server total, not the size of the page it was handed', () => {
    // The bug this replaces: every server-paged surface hand-rolled a pager,
    // and a client-side one over one request reads "1–2 of 2" for 900 rows.
    render(
      <DataTable
        caption="Leads"
        columns={COLUMNS}
        rows={PAGE}
        rowKey={(row) => row.id}
        pageSize={2}
        page={1}
        rowCount={900}
        onPageChange={() => {}}
      />,
    );
    const pager = screen.getByRole('navigation', { name: /leads pages/i });
    expect(pager).toHaveTextContent('1–2');
    expect(pager).toHaveTextContent('900');
    expect(pager).toHaveTextContent('450');
  });

  it('asks the caller for the next page instead of slicing what it has', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DataTable
        caption="Leads"
        columns={COLUMNS}
        rows={PAGE}
        rowKey={(row) => row.id}
        pageSize={2}
        page={3}
        rowCount={900}
        onPageChange={onPageChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(4);
    await user.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    // The rows it was given are the rows it shows — never a slice of them.
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Ben')).toBeInTheDocument();
  });

  it('refuses to sort one page of a server-paged set behind the user’s back', async () => {
    const user = userEvent.setup();
    const sortable: Column<Row>[] = [
      { key: 'name', header: 'Name', render: (row) => row.name, sortable: (a, b) => a.name.localeCompare(b.name) },
    ];
    const rows: Row[] = [
      { id: '2', name: 'Ben' },
      { id: '1', name: 'Ana' },
    ];
    render(
      <DataTable
        caption="Leads"
        columns={sortable}
        rows={rows}
        rowKey={(row) => row.id}
        pageSize={2}
        page={1}
        rowCount={900}
        onPageChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /name/i }));
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    // Still the server's order. Sorting fifty of nine thousand rows and calling
    // it "sorted by name" is a lie the table will not tell.
    expect(cells[0]).toBe('Ben');
  });
});

describe('RankedBars', () => {
  it('states every value in text, so the chart survives without the bars', () => {
    render(
      <RankedBars
        label="Top questions"
        items={[
          { id: 'a', label: 'Pricing', value: 40, display: '40' },
          { id: 'b', label: 'Refunds', value: 10, display: '10' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: /top questions/i });
    expect(within(list).getByText('Pricing')).toBeInTheDocument();
    expect(within(list).getByText('40')).toBeInTheDocument();
    expect(within(list).getByText('10')).toBeInTheDocument();
  });

  it('draws nothing rather than dividing by a zero ceiling', () => {
    // Every value zero used to paint every bar full in the hand-rolled copies.
    const { container } = render(
      <RankedBars label="Top questions" items={[{ id: 'a', label: 'Pricing', value: 0 }]} />,
    );
    const fill = container.querySelector('[aria-hidden] > div') as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.style.width).toBe('0%');
  });

  it('is a real control when a row is selectable, and reports its own state', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <RankedBars
        label="Outcomes"
        items={[{ id: 'a', label: 'Booked a meeting', value: 3, onSelect, selected: true }]}
      />,
    );
    const row = screen.getByRole('button', { name: /booked a meeting/i });
    expect(row).toHaveAttribute('aria-pressed', 'true');
    await user.click(row);
    expect(onSelect).toHaveBeenCalled();
  });
});

describe('Checkbox and Progress accessible names', () => {
  it('names a checkbox from its visible label outside a Field', () => {
    // The label was wired with `htmlFor={fieldProps.id}`, and outside a `Field`
    // there is no id — so a checkbox with a perfectly visible label announced
    // as an unnamed checkbox everywhere it was used without one.
    render(<Checkbox label="Restrict to these domains" />);
    expect(screen.getByRole('checkbox', { name: /restrict to these domains/i })).toBeInTheDocument();
  });

  it('still takes its name from the surrounding Field when there is one', () => {
    render(
      <Field label="Send me a weekly summary">
        <Checkbox />
      </Field>,
    );
    expect(screen.getByRole('checkbox', { name: /weekly summary/i })).toBeInTheDocument();
  });

  it('names the element that actually carries the progressbar role', () => {
    // Base UI puts `role="progressbar"` on the Root. The label used to sit on
    // the Track, a plain div with no role, so an indeterminate bar announced as
    // an unnamed progressbar — and an indeterminate bar's label is the only
    // thing it communicates.
    render(<Progress value={null} label="Reading your website" />);
    expect(screen.getByRole('progressbar', { name: /reading your website/i })).toBeInTheDocument();
  });
});

describe('CodeBlock copy reporting', () => {
  it('tells the caller whether the copy actually happened', async () => {
    // The snippet's copy button is the single most important activation event
    // in the product, and it could not be observed at all: the primitive
    // swallowed the outcome, so the event had to be inferred from a
    // neighbouring button that most people never press.
    const onCopy = vi.fn();
    const user = userEvent.setup();
    // Spied rather than assigned: `setup()` installs its own clipboard as a
    // getter-only property, so assigning over it throws.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<CodeBlock code="<script src=x></script>" label="embed snippet" onCopy={onCopy} />);
    await user.click(screen.getByRole('button', { name: /copy embed snippet/i }));

    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(true));
    expect(writeText).toHaveBeenCalledWith('<script src=x></script>');
    writeText.mockRestore();
  });

  it('reports a refused clipboard as a failure rather than as a copy', async () => {
    // `navigator.clipboard` rejects on an insecure origin, without permission,
    // and when the document is not focused. Reporting that as a successful copy
    // is how a user ends up pasting nothing into their website.
    const onCopy = vi.fn();
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('not allowed'));

    render(<CodeBlock code="x" label="embed snippet" onCopy={onCopy} />);
    await user.click(screen.getByRole('button', { name: /copy embed snippet/i }));

    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(false));
    writeText.mockRestore();
  });
});
