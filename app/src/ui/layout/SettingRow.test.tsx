import { useId, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SettingBand, SettingGroup, SettingRow } from './SettingRow';
import { Input } from '../primitives/Input';
import { Switch } from '../primitives/Toggle';

/**
 * The row's whole job is to bind a name to a control, so the tests are about
 * that binding — and they render it the way the settings pages will: an input
 * that needs a `label`, and a switch that names itself and must not be given a
 * second name.
 */
describe('SettingRow', () => {
  function QueueLength() {
    const id = useId();
    return (
      <SettingRow label="Queue length" htmlFor={id} description="Past this, visitors go to the offline form.">
        <Input id={id} defaultValue="10" />
      </SettingRow>
    );
  }

  it('labels a control that owns an id, and focuses it when the label is clicked', async () => {
    const user = userEvent.setup();
    render(<QueueLength />);

    const input = screen.getByLabelText('Queue length');
    await user.click(screen.getByText('Queue length'));
    expect(input).toHaveFocus();
  });

  it('does not give a switch a second name', async () => {
    // `Switch` carries its own label. A `<label htmlFor>` pointing at it too
    // would leave the control with two accessible names, and which one wins is
    // a browser detail — so a row without `htmlFor` renders a `span`.
    const user = userEvent.setup();
    function Row() {
      const [on, setOn] = useState(false);
      return (
        <SettingRow label="Quiet hours">
          <Switch checked={on} onCheckedChange={setOn} label="Quiet hours" hideLabel />
        </SettingRow>
      );
    }
    render(<Row />);

    const control = screen.getByRole('switch', { name: 'Quiet hours' });
    // The row's own label is a `span`, not a `<label htmlFor>` — the row names
    // the setting for the reader, and the switch names itself for the API.
    expect(screen.getByText('Quiet hours').tagName).toBe('SPAN');
    await user.click(control);
    expect(control).toBeChecked();
  });

  it('announces an error beside the control that produced it', () => {
    render(
      <SettingRow label="Accept timeout" error="Must be between 10 and 120 seconds.">
        <Input defaultValue="500" />
      </SettingRow>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Must be between 10 and 120 seconds.');
  });
});

describe('SettingGroup', () => {
  it('is a named region with a real heading, not a card', () => {
    render(
      <SettingGroup title="Queue" titleAs="h3">
        <SettingRow label="Queue length">
          <Input defaultValue="10" />
        </SettingRow>
      </SettingGroup>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Queue' })).toBeInTheDocument();
  });
});

/**
 * The row publishes a `FieldContext`, so the control inside it is wired the way
 * one inside a `Field` is — without the caller doing it by hand at ten call
 * sites, which is what one surface had resorted to.
 */
describe('SettingRow publishes a field', () => {
  it('describes its control by the row’s own description and error', () => {
    render(
      <SettingRow
        label="Accept timeout"
        description="Then it returns to the queue."
        error="Must be between 10 and 120 seconds."
        required
      >
        <Input aria-label="Accept timeout" defaultValue="500" />
      </SettingRow>,
    );

    const input = screen.getByRole('textbox', { name: 'Accept timeout' });
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ').filter(Boolean);
    expect(ids).toHaveLength(2);

    const described = ids.map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain('Then it returns to the queue.');
    expect(described).toContain('Must be between 10 and 120 seconds.');

    // Set by the row, not by the call site. The error used to be reachable only
    // because it happened to be a `role="status"` live region — announced once
    // when it appeared, and unreachable to anyone arriving afterwards.
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    // And the live region stays: the two answer different questions.
    expect(screen.getByRole('status')).toHaveTextContent('Must be between 10 and 120 seconds.');
  });

  it('does not rename a control that names itself', () => {
    // A row heading is the row talking about the setting, not the widget's own
    // name: publishing it as `labelId` renamed an "Answering strictness"
    // radiogroup after its row and stripped a `TagInput`'s `aria-label`
    // outright, leaving the control with no accessible name at all.
    render(
      <SettingRow label="Reply-to" description="Empty uses the owner's address.">
        <Input aria-label="Reply-to address" defaultValue="support@acme.com" />
      </SettingRow>,
    );
    expect(screen.getByRole('textbox', { name: 'Reply-to address' })).toBeInTheDocument();
  });

  it('does not disable what is inside a locked row', () => {
    // A locked row very often holds the control that unlocks it.
    render(
      <SettingRow label="Custom domain" disabled>
        <button type="button">Upgrade</button>
      </SettingRow>,
    );
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeEnabled();
  });
});

describe('SettingBand', () => {
  it('stands on the group’s own gutter, hairline-separated like a row', () => {
    render(
      <SettingGroup title="Addresses">
        <SettingRow label="Reply-to">
          <Input aria-label="Reply-to" />
        </SettingRow>
        <SettingBand>
          <p>Sent from notifications@oyechats.com.</p>
        </SettingBand>
      </SettingGroup>,
    );
    // Eight surfaces hand-wrote `px-cell py-4` inside a group for want of this,
    // and one of them wrote `p-5`.
    const band = screen.getByText('Sent from notifications@oyechats.com.').parentElement;
    expect(band?.className).toContain('px-cell');
    expect(band?.className).toContain('border-t');
  });
});


describe('SettingGroup has a measure', () => {
  it('caps its own card at the form width', () => {
    const { container } = render(
      <SettingGroup title="General">
        <SettingRow label="Name">
          <Input aria-label="Name" />
        </SettingRow>
      </SettingGroup>,
    );
    // `SettingRow` caps the label→control PAIR; nothing capped the box around
    // it, so on a 1945px page the hairline ran 1,300px past the control it was
    // underlining and a switch sat at x=1537 with nothing to its right.
    expect(container.firstElementChild?.className).toContain('max-w-form');
  });

  it('lets a group whose rows are a wide table opt out', () => {
    const { container } = render(
      <SettingGroup width="full" title="Departments">
        <SettingRow label="Name">
          <Input aria-label="Name" />
        </SettingRow>
      </SettingGroup>,
    );
    expect(container.firstElementChild?.className).not.toContain('max-w-form');
  });
});
