import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { Select, Spinner, Tooltip, type SelectOption } from '../../ui';
import { setMyLanguage } from '../../services/api';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';
import { useTranslation } from '../../i18n/useTranslation';

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
  const { t } = useTranslation();
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
    const rows: SelectOption[] = [{ value: '', label: t('inbox.doNotTranslate') || 'Do not translate' }];
    if (orphaned && value !== null) {
      rows.push({ value, label: `${localeNameFor(value) ?? value} (no longer offered)` });
    }
    for (const locale of availableLocales) {
      rows.push({ value: locale, label: localeNameFor(locale) ?? locale });
    }
    return rows;
  }, [availableLocales, orphaned, value, localeNameFor, t]);

  const save = useMutation({
    mutationFn: async (next: string) => setMyLanguage(next || null),
    onSuccess: (result) => {
      setError(null);
      // The SERVER's normalised tag ("hi_in" becomes "hi-IN"), not the raw
      // option, so what is shown is what translation will key on.
      onChange(result?.preferred_locale ?? null);
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : t('inbox.couldNotSaveYourLanguage') || 'Could not save your language.');
    },
  });

  const hint = value
    ? t('inbox.visitorMessagesAreTranslatedInto', { language: labelFor(value) ?? value }) ||
      `Visitor messages are translated into ${labelFor(value) ?? value}.`
    : t('inbox.messagesShowInTheLanguage') || 'Messages show in the language they were written in.';

  return (
    <div className="flex items-center gap-2">
      {/* `Field` stacks label, control and hint on three lines — right for a
          settings form, wrong for a row in the inbox's own status strip. Same
          shape as the "Month" label beside Journey's own picker: a small
          label the control's own `aria-label` already carries for
          assistive tech, so this span is decoration, not a second name for
          screen readers to hear. */}
      <span aria-hidden className="text-xs text-text-tertiary">
        {t('inbox.readLiveChatIn') || 'Read live chat in'}
      </span>
      <Select
        size="sm"
        label={t('inbox.readLiveChatIn') || 'Read live chat in'}
        value={value ?? ''}
        options={options}
        disabled={disabled || save.isPending}
        onValueChange={(next) => save.mutate(next)}
      />
      {save.isPending ? <Spinner size="sm" label={t('inbox.savingYourLanguage') || 'Saving your language'} /> : null}
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : (
        <Tooltip content={hint}>
          <button
            type="button"
            aria-label={hint}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-text-tertiary hover:text-text-primary"
          >
            <Info aria-hidden className="h-icon-sm w-icon-sm" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
