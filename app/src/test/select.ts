import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * Opens a `Select` and picks an option by its visible label.
 *
 * `Select` stopped rendering a native `<select>` in favour of a fully styled
 * Base UI listbox, so `user.selectOptions()` — which only understands a real
 * `<select>` element and dispatches a native `change` event at it — no longer
 * has anything to act on. This is its replacement: open the trigger, then
 * click the option, exactly as a person does.
 *
 * Matched by label, not value: the option's accessible name is the text it
 * renders, and the raw value a test used to pass to `selectOptions` (an id, a
 * status key) is not queryable from the popup's DOM.
 */
export async function pickOption(
  user: UserEvent,
  trigger: HTMLElement,
  optionName: string | RegExp,
) {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: optionName }));
}
