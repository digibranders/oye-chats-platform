import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './primitives/Button';
import { Badge } from './primitives/Badge';
import { Eyebrow } from './primitives/Misc';
import { Field, FieldSet } from './primitives/Field';
import { Input } from './primitives/Input';
import { Switch, Checkbox } from './primitives/Toggle';
import { Progress } from './primitives/Progress';
import { CodeBlock } from './data/Copyable';
import { Tooltip, TooltipProvider } from './overlays/Tooltip';
import { NavTabs } from './layout/NavTabs';
import { SaveBar } from './layout/SaveBar';
import { Disclosure } from './layout/Disclosure';
import { RadioCards } from './primitives/RadioCards';
import { Select } from './primitives/Select';
import { Meter } from './primitives/Progress';
import { MemoryRouter } from 'react-router-dom';
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

  it('marks the exception, not the rule', () => {
    // DESIGN.md §6 rule 4. `required` is announced and never drawn: almost every
    // form in this console is required end to end, and the sign-in card showed
    // six red asterisks that told the reader nothing they could act on. The
    // visible marker is "Optional", on the fields that have one.
    const { rerender } = render(
      <Field label="Name" required>
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: /name/i });
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input).toHaveAccessibleName(/^Name\s*\(required\)$/);
    expect(screen.queryByText('*')).toBeNull();

    rerender(
      <Field label="Reply signature" optional>
        <Input />
      </Field>,
    );
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-required');
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
  it('marks the selected tab, and marks it off the ARIA state', () => {
    // This is asserted against the tab's *own* attribute rather than against a
    // class string, because the defect it guards was a class that matched
    // nothing: `TAB_SELECTED` keyed off `data-[selected]` and Base UI emits
    // `data-active`, so every `Tabs` row in the console rendered three or four
    // identical grey labels with `box-shadow: none`. A selector that never fires
    // is invisible in its own diff and survived a full round of review.
    render(
      <Tabs
        label="Views"
        value="b"
        onValueChange={() => {}}
        items={[
          { value: 'a', label: 'Overview' },
          { value: 'b', label: 'Members' },
        ]}
      >
        <TabPanel value="a">A</TabPanel>
        <TabPanel value="b">B</TabPanel>
      </Tabs>,
    );

    const selected = screen.getByRole('tab', { name: 'Members' });
    const idle = screen.getByRole('tab', { name: 'Overview' });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(idle).toHaveAttribute('aria-selected', 'false');

    // The marker is keyed off that attribute, so the one thing that cannot
    // silently stop matching is the thing the screen reader is already reading.
    expect(selected.className).toContain('aria-[selected=true]:shadow-');
    expect(selected.className).not.toContain('data-[selected]');
  });

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
    // And it names what a row is: "1–2 of 900 rows", never a bare figure.
    expect(pager).toHaveTextContent('rows');
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
    // It does not even offer the affordance: the arrow used to flip and nothing
    // moved. Sorting fifty of nine thousand rows and calling it "sorted by
    // name" is a lie the table will not tell, so it does not invite it either.
    expect(screen.queryByRole('button', { name: /name/i })).not.toBeInTheDocument();
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    // Still the server's order.
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

  it('shows the label it was given, unless it is told not to', () => {
    // `hideLabel` defaulted to TRUE: a required `label` prop that rendered
    // nothing unless a second prop was found and unset. `Meter` — the sibling
    // with the same prop — has always defaulted to showing it, and two
    // primitives disagreeing about one prop name is the drift `src/ui` exists
    // to stop.
    const { rerender } = render(<Progress value={40} label="Crawling acme.com" />);
    expect(screen.getByText('Crawling acme.com')).toBeInTheDocument();

    rerender(<Progress value={40} hideLabel label="Crawling acme.com" />);
    expect(screen.queryByText('Crawling acme.com')).toBeNull();
    // Still named, because a bare bar with no accessible name says nothing.
    expect(screen.getByRole('progressbar', { name: 'Crawling acme.com' })).toBeInTheDocument();
  });
});

describe('Field trailing', () => {
  it('puts a control on the label row instead of inside the input', () => {
    // `Input trailing` is inside the control: a conditional affix there changes
    // the input's element tree, React remounts it and the caret is lost
    // mid-typing — two surfaces shipped an always-present `invisible` badge to
    // avoid it, which reserves a hole for something usually not there.
    render(
      <Field label="Greeting" trailing={<Button size="sm">Reset</Button>}>
        <Input placeholder="Hi — ask me anything." />
      </Field>,
    );
    const reset = screen.getByRole('button', { name: 'Reset' });
    const label = screen.getByText('Greeting');
    // Same row as the label, not inside the field.
    expect(reset.closest('label')).toBeNull();
    expect(label.parentElement).toContainElement(reset);
    // Capped like every other pair in the system.
    expect(label.parentElement?.className).toContain('max-w-pair');
  });
});

describe('a Field hint can be more than a sentence', () => {
  it('takes a list without dropping it outside the described element', () => {
    // The slot was a `<p>`, which may not contain a `<ul>`: the browser closes
    // the paragraph early and the list lands outside the element
    // `aria-describedby` points at, so both call sites that needed one
    // abandoned the slot and hand-rolled unwired text under the field.
    render(
      <Field
        label="New password"
        hint={
          <ul>
            <li>At least 12 characters</li>
            <li>One number, or one symbol</li>
          </ul>
        }
      >
        <Input type="password" />
      </Field>,
    );

    const input = screen.getByLabelText('New password');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy as string);
    expect(hint).not.toBeNull();
    // The list is INSIDE the described element, which is the whole point.
    expect(within(hint as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('FieldSet disabled', () => {
  it('disables every control in the group through the native attribute', () => {
    // `fieldset[disabled]` is inherited by every form control inside it by the
    // HTML spec, including ones added later, and it survives a child that
    // forgot to read a flag.
    render(
      <FieldSet legend="Weekly digest" disabled hint="Not on your plan.">
        <Input aria-label="Digest recipient" defaultValue="ops@acme.com" />
        <Button>Send a test</Button>
      </FieldSet>,
    );
    expect(screen.getByRole('textbox', { name: 'Digest recipient' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeDisabled();
    // In tokens, never in an opacity wash: a wash compounds with each control's
    // own disabled treatment.
    expect(screen.getByText('Weekly digest').className).toContain('text-text-disabled');
  });
});

describe('Eyebrow', () => {
  it('renders as a dt, so an eyebrow can name a fact inside a definition list', () => {
    // `dl > div` may hold `dt` and `dd` and nothing else, so three surfaces
    // reached past the component for `EYEBROW_CLASS` instead.
    render(
      <dl>
        <div>
          <Eyebrow as="dt">Bot key</Eyebrow>
          <dd>bot-6a42</dd>
        </div>
      </dl>,
    );
    expect(screen.getByText('Bot key').tagName).toBe('DT');
  });
});

describe('Badge is a usable trigger', () => {
  it('forwards its ref and spreads its props, so a tooltip on it can open', async () => {
    // Base UI renders a trigger by cloning its child with a ref and a full set
    // of handlers. `Badge` accepted neither, so every clone succeeded silently
    // and no tooltip on a badge has ever opened — and several review items were
    // closed as "not possible" because of it.
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip content="Scored 82 on BANT in the last 24 hours.">
          <Badge tone="success" tabIndex={0}>
            qualified
          </Badge>
        </Tooltip>
      </TooltipProvider>,
    );

    const badge = screen.getByText('qualified').closest('[data-tone]') as HTMLElement;
    await user.hover(badge);
    expect(await screen.findByText('Scored 82 on BANT in the last 24 hours.')).toBeInTheDocument();
    // The badge itself is the trigger — Base UI stamps its open state onto the
    // element it cloned — and it kept the props the call site gave it.
    expect(badge.getAttribute('data-popup-open')).not.toBeNull();
    expect(badge).toHaveAttribute('tabindex', '0');
    expect(badge).toHaveAttribute('data-tone', 'success');
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

describe('Tooltip', () => {
  it('opens on the control it describes', async () => {
    // It never did. The trigger was rendered as `render={<>{children}</>}`, and
    // Base UI clones the trigger to attach its handlers and its ref — a
    // fragment takes neither, so React logged an invalid-prop warning and every
    // handler was silently dropped. No tooltip in the app had ever opened.
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip content="Passages are what the chatbot searches">
          <button type="button">Passages</button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole('button', { name: 'Passages' }));
    expect(
      await screen.findByText('Passages are what the chatbot searches'),
    ).toBeInTheDocument();
  });

  it('renders the control untouched when disabled', () => {
    render(
      <TooltipProvider>
        <Tooltip content="not shown" disabled>
          <button type="button">Passages</button>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Passages' })).toBeInTheDocument();
    expect(screen.queryByText('not shown')).not.toBeInTheDocument();
  });
});

describe('NavTabs', () => {
  it('is navigation, not a tablist, and marks the current page', () => {
    // A routed tab row only ever has one panel in the document, so a `tablist`
    // would promise `aria-controls` targets that do not exist. Three surfaces
    // were faking it with `Tabs` plus a single panel and `useNavigate`.
    render(
      <MemoryRouter initialEntries={['/platform/revenue/invoices']}>
        <NavTabs
          label="Revenue views"
          items={[
            { to: '/platform/revenue', label: 'Overview', end: true },
            { to: '/platform/revenue/invoices', label: 'Invoices' },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('navigation', { name: /revenue views/i })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});

describe('Meter and money, without customer-facing copy baked in', () => {
  it('lets the caller say what "no limit" means here', () => {
    // It used to read "Unlimited on your plan" — customer copy in a shared
    // primitive, and simply false in the platform console, where the account
    // being looked at is somebody else's.
    render(<Meter label="Documents" used={412} limit={-1} unlimitedNote="Unlimited on this account" />);
    expect(screen.getByText('Unlimited on this account')).toBeInTheDocument();
  });

  it('formats a malformed currency code instead of throwing the table away', () => {
    // `Intl.NumberFormat` raises a RangeError on a bad code, and a throw inside
    // a cell takes out every row around it. Legacy invoice rows predate the
    // currency column.
    expect(() => formatMoney(149900, 'not-a-code')).not.toThrow();
    expect(formatMoney(149900, 'not-a-code')).toContain('1,499');
    expect(formatMoney(149900, 'INR')).toContain('1,499');
  });
});

describe('SaveBar', () => {
  function bar(props: Partial<React.ComponentProps<typeof SaveBar>> = {}) {
    return render(
      <MemoryRouter>
        <SaveBar dirty={false} onSave={() => {}} onDiscard={() => {}} {...props} />
      </MemoryRouter>,
    );
  }

  it('names what changed rather than only that something did', () => {
    bar({ dirty: true, summary: 'Branding and Messages' });
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes to Branding and Messages.');
  });

  it('keeps a card footer on screen while clean, and floats only when dirty', () => {
    // A footer that appears on the first keystroke pushes the card down at the
    // moment the user is typing in it; a floating bar reflows nothing, so it
    // has no reason to be there when there is nothing to save.
    const { unmount } = bar({ variant: 'footer' });
    expect(screen.getByText('Everything here is saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    unmount();

    bar({ variant: 'sticky' });
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('puts a failed save beside the button that produced it', () => {
    bar({ dirty: true, saveError: 'That did not save: the name is already taken.' });
    expect(screen.getByRole('status')).toHaveTextContent(/already taken/);
  });

  it('blocks the save and says why, rather than failing on submit', () => {
    bar({ dirty: true, blockedReason: 'Weights must add up to more than zero.' });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/add up to more than zero/);
  });

  it('needs no data router when the caller did not ask to be guarded', () => {
    // `useBlocker` throws outside a data router. Calling it unconditionally
    // would impose `createMemoryRouter` on every form that opted out.
    expect(() => bar({ dirty: true })).not.toThrow();
  });
});

describe('RadioCards', () => {
  const ITEMS = [
    { value: 'strict', label: 'Strict', description: 'Only answers from your documents.' },
    { value: 'balanced', label: 'Balanced', description: 'Fills small gaps from general knowledge.' },
    { value: 'open', label: 'Open', description: 'Answers freely.', disabled: true },
  ] as const;

  it('is one tab stop with arrow keys inside it, and skips disabled options', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <RadioCards items={ITEMS} value="strict" onChange={onChange} label="How strictly should it answer?" />,
    );

    const group = screen.getByRole('radiogroup', { name: /how strictly/i });
    const options = within(group).getAllByRole('radio');
    expect(options.filter((option) => option.getAttribute('tabindex') === '0')).toHaveLength(1);

    options[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('balanced');
    expect(options[2]).toBeDisabled();
  });

  it('describes each option without folding the description into its name', () => {
    render(<RadioCards items={ITEMS} value="strict" onChange={() => {}} label="Scope" />);
    const strict = screen.getByRole('radio', { name: 'Strict' });
    expect(strict).toHaveAccessibleDescription('Only answers from your documents.');
  });

  it('stays reachable when the stored value matches no option', () => {
    // A plan downgrade can leave a value the picker no longer offers. Without
    // a fallback every card would be tabindex -1 and the group unreachable.
    render(<RadioCards items={ITEMS} value={'gone' as 'strict'} onChange={() => {}} label="Scope" />);
    const focusable = screen.getAllByRole('radio').filter((o) => o.getAttribute('tabindex') === '0');
    expect(focusable).toHaveLength(1);
  });
});

describe('Select', () => {
  it('can express a selectable "none", not only an unselectable placeholder', async () => {
    // A disabled placeholder cannot be chosen, so a field with only one can be
    // set but never cleared — which is how the department picker shipped.
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select
        aria-label="Department"
        emptyOption="No department"
        value="1"
        onChange={onChange}
        options={[{ value: '1', label: 'Support' }]}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Department' }), '');
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'No department' })).not.toBeDisabled();
  });
});

describe('Disclosure', () => {
  it('announces itself as expandable and names what it reveals', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure summary="Technical details" regionLabel="Technical details">
        <p>Stack goes here</p>
      </Disclosure>,
    );

    const toggle = screen.getByRole('button', { name: /technical details/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Stack goes here')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: /technical details/i })).toBeInTheDocument();
  });

  it('unmounts the panel rather than hiding it', async () => {
    // A hidden subtree keeps its focusable children in the tab order unless
    // every one of them is disabled, and these panels are often long.
    const user = userEvent.setup();
    render(
      <Disclosure summary="More" defaultOpen>
        <button type="button">Inside</button>
      </Disclosure>,
    );
    expect(screen.getByRole('button', { name: 'Inside' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('button', { name: 'Inside' })).not.toBeInTheDocument();
  });

  it('can be a heading, so a log of them is navigable by heading', () => {
    render(
      <Disclosure summary="One rated answer" headingLevel={3}>
        <p>Detail</p>
      </Disclosure>,
    );
    expect(screen.getByRole('heading', { level: 3, name: /one rated answer/i })).toBeInTheDocument();
  });
});
