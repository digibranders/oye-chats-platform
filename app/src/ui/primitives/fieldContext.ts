import { createContext, useContext } from 'react';

export interface FieldContextValue {
  id: string;
  /**
   * The id of the element that NAMES the control — the field's own `<label>`.
   *
   * A group control — `RadioCards`, `SegmentedControl` — is a `role="radiogroup"`
   * div with no id-addressable input, so `<label for>` names nothing at all. It
   * reads this and sets `aria-labelledby`, which is what lets a `Field` label a
   * group rather than forcing every group into a `FieldSet`.
   *
   * **Optional, and its absence is a real statement**: it means the container
   * publishes the field's wiring — the id, the description, the error, invalid,
   * required — but does *not* name what is inside it, so the control must go on
   * naming itself. `SettingRow` is exactly that case: its heading is a row label
   * that a `Switch` or a `RadioCards` inside it usually does not want to be
   * renamed by, and it only claims the name when the caller wires it with
   * `htmlFor`. Publishing it unconditionally renamed a "Answering strictness"
   * radiogroup after its row and stripped a `TagInput`'s `aria-label` outright,
   * leaving the control with no accessible name at all.
   */
  labelId?: string;
  descriptionId?: string;
  errorId?: string;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Read the field a control is sitting in.
 *
 * Returns `null` outside a `Field`, which is deliberate: `Input` is usable on
 * its own inside a toolbar or a table cell, where a label and a hint would be
 * noise. Controls spread `useFieldControlProps()` and get correct wiring in
 * both cases without the caller having to choose.
 */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

/**
 * The ARIA a control needs in order to be described by its own hint and error.
 *
 * This is the part hand-rolled forms almost always get wrong. A red border and
 * a message underneath say "invalid" to someone who can see the form and
 * nothing at all to someone using a screen reader; `aria-invalid` plus an
 * `aria-describedby` that actually points at the error text is what makes the
 * message reachable. Doing it here means no caller has to remember.
 *
 * Every key is omitted rather than set to `undefined` when it does not apply.
 * A spread of `{ disabled: undefined }` overrides an explicit `disabled` prop
 * that was set earlier in the same element — which silently re-enabled every
 * disabled control that happened to sit inside a `Field`.
 */
export function useFieldControlProps(): Record<string, unknown> {
  const field = useContext(FieldContext);
  if (!field) return {};
  const describedBy = [field.descriptionId, field.errorId].filter(Boolean).join(' ');
  const props: Record<string, unknown> = { id: field.id };
  if (field.invalid) props['aria-invalid'] = true;
  if (describedBy) props['aria-describedby'] = describedBy;
  if (field.required) props['aria-required'] = true;
  if (field.disabled) props.disabled = true;
  return props;
}

/**
 * The ARIA a *group* control needs when it is sitting in a `Field`.
 *
 * A radiogroup cannot take the field's `id` — it is not what the label points at
 * and it owns no input — so it is named by the label's id instead, and described
 * by the same hint and error as everything else.
 */
export function useFieldGroupProps(): {
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  disabled: boolean;
} {
  const field = useContext(FieldContext);
  if (!field) return { disabled: false };
  const describedBy = [field.descriptionId, field.errorId].filter(Boolean).join(' ');
  return {
    // Undefined when the container does not name the control — the group then
    // keeps whatever name it gave itself, rather than losing it.
    'aria-labelledby': field.labelId,
    'aria-describedby': describedBy || undefined,
    disabled: field.disabled,
  };
}

/**
 * Whether the surrounding field NAMES this control.
 *
 * The four controls that draw their own bare `input` — `Combobox`, `ColorInput`,
 * `SearchField`, `TagInput` — carry an `aria-label` of their own and must drop
 * it when a `<label for>` is already pointing at them, or the two names compete.
 * They used to test for the presence of a field at all, which broke the moment a
 * container published the wiring without the name.
 */
export function useFieldNamesControl(): boolean {
  return Boolean(useContext(FieldContext)?.labelId);
}
