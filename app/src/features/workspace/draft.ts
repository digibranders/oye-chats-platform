import { useCallback, useMemo, useState } from 'react';

/**
 * The edit contract every settings form in this console follows.
 *
 * Settings pages are the one place a user types something and then walks away
 * expecting it to have been kept. The console this replaces answered that in
 * three different ways on three adjacent pages: an "Edit details" button that
 * swapped the whole card into a form, a set of always-live inputs that saved on
 * blur, and a form that saved on submit but never said whether anything had
 * changed. Two of those can lose work silently.
 *
 * So there is one model, and it is this: fields are always editable, the draft
 * is compared field-by-field against what the server last confirmed, and while
 * they differ the page says so and offers both ways out — save, or discard.
 * Nothing is hidden behind an edit mode, and nothing saves without being asked.
 *
 * `dirtyFields` is the whole point of comparing per field rather than
 * stringifying: it is what lets a form name what changed instead of announcing
 * an anonymous "unsaved changes", and what lets a save send only the fields
 * that actually moved.
 */

export type DraftValues = Record<string, string>;

/** Which keys of `draft` differ from `baseline`, in declaration order. */
export function dirtyKeys<T extends DraftValues>(baseline: T, draft: T): (keyof T & string)[] {
  return (Object.keys(baseline) as (keyof T & string)[]).filter(
    (key) => normalize(baseline[key]) !== normalize(draft[key]),
  );
}

/**
 * Trailing and leading whitespace is not a change.
 *
 * Without this, tabbing through a form on a touch keyboard that appends a space
 * leaves the page claiming unsaved changes forever, and the user cannot find
 * what they supposedly edited.
 */
function normalize(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Only the changed fields, trimmed — what a PATCH should actually carry. */
export function changedValues<T extends DraftValues>(baseline: T, draft: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of dirtyKeys(baseline, draft)) {
    patch[key] = normalize(draft[key]) as T[keyof T & string];
  }
  return patch;
}

export interface Draft<T extends DraftValues> {
  values: T;
  /** Set one field. Clears that field's error, never the others'. */
  set: (key: keyof T & string, value: string) => void;
  /** The names of the fields that differ from the server's copy. */
  dirty: (keyof T & string)[];
  isDirty: boolean;
  /** Throw the edits away and go back to the server's copy. */
  reset: () => void;
  /** Adopt a new server copy — after a successful save, or a refetch. */
  commit: (next: T) => void;
  errors: Partial<Record<keyof T & string, string>>;
  setErrors: (errors: Partial<Record<keyof T & string, string>>) => void;
  /** The trimmed subset that changed, for the request body. */
  patch: Partial<T>;
}

/**
 * Hold a form's draft against the last value the server confirmed.
 *
 * `initial` is read once. A settings form must not be yanked out from under
 * someone mid-sentence because a background refetch landed — the page adopts
 * the new server copy explicitly, through `commit`.
 */
export function useDraft<T extends DraftValues>(initial: T): Draft<T> {
  const [baseline, setBaseline] = useState<T>(initial);
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof T & string, string>>>({});

  const set = useCallback((key: keyof T & string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  // Depends on `baseline` rather than reading it through a ref: a ref read
  // during render is not safe under the compiler, and the identity only changes
  // when the server's copy does — which is exactly when a stale `reset` would
  // have restored the wrong values.
  const reset = useCallback(() => {
    setValues(baseline);
    setErrors({});
  }, [baseline]);

  const commit = useCallback((next: T) => {
    setBaseline(next);
    setValues(next);
    setErrors({});
  }, []);

  const dirty = useMemo(() => dirtyKeys(baseline, values), [baseline, values]);
  const patch = useMemo(() => changedValues(baseline, values), [baseline, values]);

  return {
    values,
    set,
    dirty,
    isDirty: dirty.length > 0,
    reset,
    commit,
    errors,
    setErrors,
    patch,
  };
}

/**
 * "Name, Website" — the changed fields, read back to the user.
 *
 * A bar that says only "You have unsaved changes" on a form with nine fields
 * makes the user hunt for what they touched. Naming them costs one line.
 */
export function describeDirty(
  dirty: readonly string[],
  labels: Record<string, string>,
): string {
  const named = dirty.map((key) => labels[key] ?? key);
  if (named.length === 0) return '';
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}
