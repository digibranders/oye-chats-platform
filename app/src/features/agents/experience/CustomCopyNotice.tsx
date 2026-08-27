import { type ReactElement } from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * Tells a customer that the copy they are about to write will NOT be
 * translated, on the surfaces where they write it.
 *
 * The widget ships a translated dictionary for every string it owns, but any
 * field a customer fills in wins over that dictionary. That is the right
 * precedence: a greeting somebody wrote deliberately should not be replaced by
 * a generic translated default. The consequence is easy to miss though. A bot
 * with multilingual on and an English greeting shows that English greeting to a
 * Hindi visitor, and nothing on the page said so.
 *
 * Deliberately worded as a fact, not a warning. Writing custom copy is a
 * legitimate thing to do; the customer just needs to know it travels unchanged.
 * Shown only when multilingual is actually on, because on a single-language bot
 * it is noise.
 */
export function CustomCopyNotice({ multilingual }: { multilingual: boolean }): ReactElement | null {
  const { t } = useTranslation();
  if (!multilingual) return null;
  return (
    <div
      role="note"
      className="flex gap-2.5 rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3.5 py-3"
    >
      <Languages size={14} className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
      <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
        <span className="font-medium text-[var(--ds-text)]">
          {t('agents.customTextIsShownUnchanged') || 'Custom text is shown unchanged in all languages.'}
        </span>{' '}
        {t('agents.customCopyExplanation') ||
          'Anything you write here replaces the built-in wording, which your chatbot would otherwise translate for each visitor. Leave a field empty to keep the translated default.'}
      </p>
    </div>
  );
}
