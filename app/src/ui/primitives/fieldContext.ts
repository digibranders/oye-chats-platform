import { createContext, useContext } from 'react';

export interface FieldContextValue {
  id: string;
  /**
   * The id of the field's own `<label>`.
   *
   * A group control — `RadioCards`, `SegmentedControl` — is a `role="radiogroup"`
   * div with no id-addressable input, so `<label for>` names nothing at all. It
   * reads this and sets `aria-labelledby`, which is what lets a `Field` label a
   * group rather than forcing every group into a `FieldSet`.
   */
  labelId: string;
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
    'aria-labelledby': field.labelId,
    'aria-describedby': describedBy || undefined,
    disabled: field.disabled,
  };
}
