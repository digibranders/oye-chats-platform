import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge';
import { Button } from './Button';
import { Checkbox, Switch } from './Toggle';
import { ColorInput } from './ColorInput';
import { Combobox } from './Combobox';
import { CONTROL_SIZE, type ControlSize } from './controlStyles';
import { Field } from './Field';
import { FileDrop } from './FileDrop';
import { Input } from './Input';
import { Meter } from './Progress';
import { RadioCards } from './RadioCards';
import { SearchField } from './SearchField';
import { SegmentedControl } from './SegmentedControl';
import { Select } from './Select';
import { TagInput } from './TagInput';

/**
 * The contracts a control cannot be reviewed for by reading its own diff.
 *
 * Every case here corresponds to something that shipped: a size matrix in which
 * only one of the three sizes was coherent, four controls under the 24px target
 * floor, two controls with no focus indicator at all, and three that replaced
 * their `Field`'s visible label with an `aria-label` nobody could see.
 */

const SIZES: ControlSize[] = ['sm', 'md', 'lg'];

function classesOf(element: Element | null): string {
  return element?.getAttribute('class') ?? '';
}

describe('the control size matrix', () => {
  /**
   * DESIGN.md §4's promise is that a button, an input and a select on one row
   * line up. It held at `md` and nowhere else: `sm` buttons were 6px round
   * between 8px inputs, `lg` buttons were padded 16 against the input's 14, and
   * a `sm` segmented control computed to 30px — a height no other control has.
   */
  it.each(SIZES)('gives every %s control one height, one radius and one text rung', (size) => {
    const geometry = CONTROL_SIZE[size];
    const { container } = render(
      <div>
        <Button size={size}>Save</Button>
        <Input size={size} aria-label="Query" />
        <Select size={size} aria-label="Status" options={[{ value: 'a', label: 'A' }]} />
      </div>,
    );

    for (const control of Array.from(container.querySelectorAll('button, input, select'))) {
      const classes = classesOf(control);
      expect(classes, `${control.tagName} height`).toContain(geometry.height);
      expect(classes, `${control.tagName} radius`).toContain(geometry.radius);
      expect(classes, `${control.tagName} text`).toContain(geometry.text);
    }
  });

  it.each(['sm', 'md'] as const)(
    'keeps a %s combobox, search field and segmented control on the same height',
    (size) => {
      render(
        <div>
          <Combobox
            size={size}
            label="Owner"
            options={[{ value: 'a', label: 'Ana' }]}
            value={null}
            onValueChange={() => {}}
          />
          <SearchField size={size} label="Search leads" value="" onValueChange={() => {}} />
          <SegmentedControl
            size={size}
            label="Status"
            value="all"
            onChange={() => {}}
            items={[{ value: 'all', label: 'All' }]}
          />
        </div>,
      );
      const height = CONTROL_SIZE[size].height;
      expect(classesOf(screen.getByRole('combobox', { name: 'Owner' }))).toContain(height);
      expect(classesOf(screen.getByRole('searchbox', { name: 'Search leads' }))).toContain(height);
      // The container owns the height and the segments fill it, so the control
      // is 28 or 34 by construction rather than by adding up padding.
      expect(classesOf(screen.getByRole('radiogroup', { name: 'Status' }))).toContain(height);
    },
  );
});

describe('the 24px target floor', () => {
  /**
   * `app/CLAUDE.md` #4 and WCAG 2.2 SC 2.5.8. The pseudo-element that carries
   * the extra 8px is invisible in review, which is exactly why it needs a test.
   */
  it('extends the checkbox to 24px without growing its 16px mark', () => {
    render(<Checkbox aria-label="Select row" />);
    const box = screen.getByRole('checkbox');
    expect(classesOf(box)).toContain('h-4');
    expect(classesOf(box)).toContain('before:-inset-1');
  });

  it('extends the switch to 24px', () => {
    render(<Switch checked={false} onCheckedChange={() => {}} hideLabel label="Live chat" />);
    expect(classesOf(screen.getByRole('switch'))).toContain('before:-inset-1');
  });

  it('gives the search field a 24px clear button that is never in the tab order while empty', () => {
    const { rerender } = render(
      <SearchField label="Search leads" value="" onValueChange={() => {}} />,
    );
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(classesOf(clear)).toContain('h-6');
    // Rendered, not conditional: toggling the slot toggled the field's trailing
    // padding with it, and the first keystroke moved the caret 36px.
    expect(clear).toHaveAttribute('tabindex', '-1');
    rerender(<SearchField label="Search leads" value="ana" onValueChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Clear search' })).toHaveAttribute('tabindex', '0');
  });

  it('extends the tag chip remove button to 24px', () => {
    render(
      <TagInput label="Recipients" values={['ana@example.com']} onValuesChange={() => {}} />,
    );
    expect(classesOf(screen.getByRole('button', { name: 'Remove ana@example.com' }))).toContain(
      'before:-inset-1',
    );
  });
});

describe('focus indicators that were missing entirely', () => {
  it('draws the tag input ring on the box, since the inner input kills its own', () => {
    render(<TagInput label="Recipients" values={[]} onValuesChange={() => {}} />);
    const shell = screen.getByRole('textbox', { name: 'Recipients' }).parentElement;
    // No bare `outline` beside `outline-2`: Tailwind v4's width utility sets
    // the style too, and tailwind-merge drops one of the pair.
    expect(classesOf(shell)).toContain('has-[input:focus-visible]:outline-2');
    expect(classesOf(shell)).toContain('has-[input:focus-visible]:outline-accent-500');
  });

  it('draws the file drop ring on the label, since the input is clipped to 1px', () => {
    const { container } = render(<FileDrop label="Add files" onFiles={() => {}} />);
    const input = container.querySelector('input[type="file"]');
    // `peer` on the input is what lets the label see its focus state at all.
    expect(classesOf(input)).toContain('peer');
    expect(classesOf(container.querySelector('label'))).toContain(
      'peer-focus-visible:outline-2',
    );
  });
});

describe('disabled is stated in tokens, never in opacity', () => {
  it('never emits an opacity utility on a disabled control', () => {
    const { container } = render(
      <div>
        <Button disabled>Save</Button>
        <Checkbox disabled label="Include archived" />
        <Switch disabled checked onCheckedChange={() => {}} label="Live chat" />
        <SegmentedControl
          label="Status"
          value="all"
          onChange={() => {}}
          items={[{ value: 'all', label: 'All', disabled: true }]}
        />
        <RadioCards
          label="Strictness"
          value="strict"
          onChange={() => {}}
          items={[{ value: 'loose', label: 'Loose', disabled: true }]}
        />
      </div>,
    );
    const offenders = Array.from(container.querySelectorAll('*'))
      .map((node) => classesOf(node))
      .filter((classes) => /(^|\s)(disabled:)?opacity-\d/.test(classes));
    expect(offenders).toEqual([]);
  });
});

describe('a primitive inside a Field is named once', () => {
  /**
   * SC 2.5.3 Label in Name. `aria-label` wins the accessible-name computation
   * over the visible `<label>` wired by `htmlFor`, so a field labelled "Search"
   * announced as "Search leads" — and the gallery shipped that as a model.
   */
  it('lets the visible label name a search field', () => {
    render(
      <Field label="Search">
        <SearchField label="Search leads" value="" onValueChange={() => {}} />
      </Field>,
    );
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
  });

  it('lets the visible label name a combobox', () => {
    render(
      <Field label="Assigned operator">
        <Combobox
          label="Operator"
          options={[{ value: 'a', label: 'Ana' }]}
          value={null}
          onValueChange={() => {}}
        />
      </Field>,
    );
    expect(screen.getByRole('combobox', { name: 'Assigned operator' })).toBeInTheDocument();
  });

  it('names a radiogroup by the field label, which `htmlFor` alone cannot do', () => {
    render(
      <Field label="How strictly should it answer?" hint="You can change this later.">
        <RadioCards
          label="Strictness"
          value="strict"
          onChange={() => {}}
          items={[{ value: 'strict', label: 'Strict', description: 'Documents only.' }]}
        />
      </Field>,
    );
    const group = screen.getByRole('radiogroup', { name: 'How strictly should it answer?' });
    expect(group).toHaveAccessibleDescription('You can change this later.');
  });

  it('names a segmented control by the field label', () => {
    render(
      <Field label="Density">
        <SegmentedControl
          label="Row density"
          value="comfortable"
          onChange={() => {}}
          items={[{ value: 'comfortable', label: 'Comfortable' }]}
        />
      </Field>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
  });
});

describe('Field', () => {
  it('reserves the message row for a field that can produce an error', () => {
    const { container, rerender } = render(
      <Field label="Website" error={null}>
        <Input />
      </Field>,
    );
    const reserved = container.querySelector('.min-h-4\\.5');
    expect(reserved).not.toBeNull();
    // And costs nothing on a field validation was never wired to.
    rerender(
      <Field label="Website">
        <Input />
      </Field>,
    );
    expect(container.querySelector('.min-h-4\\.5')).toBeNull();
  });

  it('marks a field optional beside its label, not inside its hint', () => {
    render(
      <Field label="Company" optional>
        <Input />
      </Field>,
    );
    expect(screen.getByText('Optional')).toBeInTheDocument();
    // The word is part of the label element, so it is announced with the name.
    expect(screen.getByLabelText(/Company/)).toBeInTheDocument();
  });
});

describe('RadioCards signals selection with more than colour', () => {
  it('draws a radio mark on the chosen card', () => {
    const { container } = render(
      <RadioCards
        label="Strictness"
        value="strict"
        onChange={() => {}}
        items={[
          { value: 'strict', label: 'Strict' },
          { value: 'loose', label: 'Loose' },
        ]}
      />,
    );
    const chosen = screen.getByRole('radio', { name: 'Strict' });
    const other = screen.getByRole('radio', { name: 'Loose' });
    // The mark's inner dot exists only on the selected card; the border colour
    // is reinforcement, never the only signal.
    expect(chosen.querySelector('.bg-text-inverse')).not.toBeNull();
    expect(other.querySelector('.bg-text-inverse')).toBeNull();
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(2);
  });
});

describe('Input reveal', () => {
  it('reports its own state rather than only changing its label', async () => {
    const user = userEvent.setup();
    render(
      <Field label="New password">
        <Input type="password" revealable />
      </Field>,
    );
    const field = screen.getByLabelText('New password');
    expect(field).toHaveAttribute('type', 'password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('ColorInput', () => {
  it('names the swatch and the hex separately, and keeps the picker on the last valid colour', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('#2b54c8');
      return (
        <Field label="Brand colour">
          <ColorInput aria-label="Brand colour" value={value} onChange={setValue} />
        </Field>
      );
    }
    render(<Harness />);
    const swatch = screen.getByLabelText('Brand colour — swatch');
    const hex = screen.getByLabelText('Brand colour');
    expect(swatch).toHaveValue('#2b54c8');

    await user.clear(hex);
    await user.type(hex, '#2b54c');
    // Half-typed: the field says so, and the native picker holds the last
    // complete colour rather than resetting itself to black.
    expect(hex).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Brand colour — swatch')).toHaveValue('#2b54c8');
  });
});

describe('TagInput', () => {
  it('reports every rejected value in one list, wired to the input', async () => {
    const user = userEvent.setup();
    const onValuesChange = vi.fn();
    render(
      <TagInput
        label="Recipients"
        values={[]}
        onValuesChange={onValuesChange}
        validate={(value) => (value.includes('@') ? null : `${value} is not an email address.`)}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Recipients' });
    await user.type(input, 'nope alsonope{Enter}');
    expect(onValuesChange).not.toHaveBeenCalled();
    // One list, with both problems on it — a paste of ten addresses has to
    // report every bad one, not the first and then hide it.
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    // `role="status"` on the `<ul>` replaced the list semantics the markup had
    // just built, so the whole thing announced as one run-on sentence.
    expect(list).toHaveAttribute('aria-live', 'polite');
    expect(input.getAttribute('aria-describedby')).toContain(list.id);
  });
});

describe('Badge and Meter', () => {
  it('has an ink tone that is emphasis rather than a status', () => {
    render(<Badge tone="ink">12</Badge>);
    expect(screen.getByText('12').closest('[data-tone]')).toHaveAttribute('data-tone', 'ink');
  });

  it('keeps a meter the same height whether or not its label is shown', () => {
    const { container: labelled } = render(<Meter label="Credits" used={40} limit={100} />);
    const { container: bare } = render(<Meter hideLabel label="Credits" used={40} limit={100} />);
    // The row is hidden, not removed — one tile 8px shorter than its peers is
    // what made the billing grid's card bottoms disagree.
    expect(bare.querySelectorAll('div').length).toBe(labelled.querySelectorAll('div').length);
    expect(classesOf(bare.querySelector('[aria-hidden="true"]'))).toContain('invisible');
  });

  it('renders an unlimited meter with the same track as a bounded one', () => {
    const { container } = render(<Meter label="Credits" used={40} limit={-1} />);
    expect(container.querySelector('.rounded-full')).not.toBeNull();
  });
});
