import { useId, useMemo, useState, type ReactElement } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import { Select, type SelectOption } from '../../design-system';
import { setMyLanguage } from '../../services/api';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';

/**
 * Sets the operator's own live-chat working language.
 *
 * Incoming visitor messages are translated INTO this language and the
 * operator's replies are translated FROM it. "Don't translate" clears the
 * preference, which means every message renders in the language it was
 * written in.
 *
 * This is a PERSONAL preference, not workspace configuration, which is why it
 * lives beside the availability toggle (the other per-operator control) rather
 * than under Workspace settings, and why the API behind it is self-service
 * (`PUT /operators/me/language`) rather than the team-management route.
 *
 * The options are the locales the operator's BOT supports, sent by
 * `GET /operators/me/language` (Phase 5A). Offering the whole platform
 * catalogue, as this control originally did, let an operator pick a language
 * no visitor of theirs can write in: they would then see untranslated
 * originals with nothing on screen explaining why.
 */
export function OperatorLanguagePicker({
  value,
  availableLocales,
  onChange,
  disabled,
}: {
  /** Current preferred locale, or null when unset. */
  value: string | null;
  /** Locales this operator's bot supports. Empty means "Don't translate" only. */
  availableLocales: string[];
  /** Called with the saved locale (null when cleared) so the thread re-renders. */
  onChange: (locale: string | null) => void;
  disabled?: boolean;
}): ReactElement {
  const selectId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { labelFor, localeNameFor } = useLocaleCatalog();

  // A preference the bot no longer supports stays SELECTED and is flagged.
  // Dropping it would silently change what this operator reads - re-selecting
  // is a decision for them to make, not a side effect of an admin editing the
  // bot's supported languages.
  const orphaned = value !== null && !availableLocales.includes(value);

  const options = useMemo<SelectOption[]>(() => {
    // "Don't translate" is the null value and stays first: reading messages as
    // written is the default, not an opt-out hidden at the bottom of a list.
    const rows: SelectOption[] = [{ value: '', label: 'Don\u2019t translate' }];
    if (orphaned && value !== null) {
      rows.push({ value, label: `${localeNameFor(value)} \u2014 no longer offered` });
    }
    for (const locale of availableLocales) {
      rows.push({ value: locale, label: localeNameFor(locale) ?? locale });
    }
    return rows;
  }, [availableLocales, orphaned, value, localeNameFor]);

  const handleChange = async (next: string): Promise<void> => {
    const locale = next || null;
    setSaving(true);
    setError(null);
    try {
      const res = await setMyLanguage(locale);
      // Trust the SERVER's normalised value ("hi_in" -> "hi-IN"), not the raw
      // option, so what the UI shows is what translation will actually key on.
      onChange(res?.preferred_locale ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your language.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Languages size={14} className="text-[var(--ds-text-muted)]" aria-hidden="true" />
        <label htmlFor={selectId} className="sr-only">
          Read live chat in
        </label>
        <div className="w-52">
          <Select
            id={selectId}
            value={value ?? ''}
            onChange={(next) => void handleChange(next)}
            options={options}
            disabled={disabled || saving}
            aria-label="Read live chat in"
          />
        </div>
        {saving && <Loader2 size={13} className="animate-spin text-[var(--ds-text-muted)]" aria-hidden="true" />}
      </div>
      {error ? (
        <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>
      ) : (
        <p className="text-[11px] text-[var(--ds-text-subtle)]">
          {value ? `Visitor messages are translated into ${labelFor(value)}.` : 'Messages show in their original language.'}
        </p>
      )}
    </div>
  );
}
