import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Field, Select, Spinner, type SelectOption } from '../../ui';
import { setMyLanguage } from '../../services/api';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';

/**
 * The language this operator reads live chat in.
 *
 * Visitor messages are translated INTO it and replies are translated back OUT
 * of it, so it is the one setting that decides what an operator actually sees
 * in the thread. "Do not translate" clears it, and every message renders in
 * the language it was written in.
 *
 * A PERSONAL preference, not workspace configuration — which is why it sits in
 * the inbox beside the availability control rather than under Settings, and
 * why the endpoint behind it is self-service (`PUT /operators/me/language`)
 * rather than the team-management route an admin uses.
 *
 * The options are the languages this operator's CHATBOT supports, not the
 * platform catalogue. Offering the catalogue let an operator pick a language
 * no visitor of theirs can write in; they would then read untranslated
 * originals with nothing on screen explaining why.
 */
export function OperatorLanguagePicker({
  value,
  availableLocales,
  onChange,
  disabled,
}: {
  /** The current preference, or null when unset. */
  value: string | null;
  /** Locales this operator's chatbot supports. Empty leaves only "Do not translate". */
  availableLocales: string[];
  /** Called with the SAVED locale, so the thread re-renders against it. */
  onChange: (locale: string | null) => void;
  disabled?: boolean;
}) {
  const { labelFor, localeNameFor } = useLocaleCatalog();
  const [error, setError] = useState<string | null>(null);

  // A preference the chatbot no longer supports stays SELECTED, and says so.
  // Dropping it would silently change what this operator reads as a side
  // effect of an admin editing the chatbot's languages; re-selecting is their
  // decision to make.
  const orphaned = value !== null && !availableLocales.includes(value);

  const options = useMemo<SelectOption[]>(() => {
    // Reading messages as written is the default, not an opt-out buried at the
    // bottom of the list, so it stays first.
    const rows: SelectOption[] = [{ value: '', label: 'Do not translate' }];
    if (orphaned && value !== null) {
      rows.push({ value, label: `${localeNameFor(value) ?? value} (no longer offered)` });
    }
    for (const locale of availableLocales) {
      rows.push({ value: locale, label: localeNameFor(locale) ?? locale });
    }
    return rows;
  }, [availableLocales, orphaned, value, localeNameFor]);

  const save = useMutation({
    mutationFn: async (next: string) => setMyLanguage(next || null),
    onSuccess: (result) => {
      setError(null);
      // The SERVER's normalised tag ("hi_in" becomes "hi-IN"), not the raw
      // option, so what is shown is what translation will key on.
      onChange(result?.preferred_locale ?? null);
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : 'Could not save your language.');
    },
  });

  return (
    <Field
      label="Read live chat in"
      error={error}
      hint={
        error
          ? undefined
          : value
            ? `Visitor messages are translated into ${labelFor(value) ?? value}.`
            : 'Messages show in the language they were written in.'
      }
    >
      <span className="flex items-center gap-2">
        <Select
          label="Read live chat in"
          value={value ?? ''}
          options={options}
          disabled={disabled || save.isPending}
          onValueChange={(next) => save.mutate(next)}
        />
        {save.isPending ? <Spinner size="sm" label="Saving your language" /> : null}
      </span>
    </Field>
  );
}
