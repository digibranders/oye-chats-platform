import { useId, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SettingGroup, SettingRow } from './SettingRow';
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
