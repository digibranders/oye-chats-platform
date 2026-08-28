import { useState } from 'react';
import { Languages } from 'lucide-react';
import { Spinner, cn } from '../../ui';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Original or translation, under one bubble.
 *
 * Three states, because "nothing to translate" and "translation failed" are
 * different facts to an operator: one means the message was already in their
 * language, the other means the provider did not answer and there is something
 * to retry. Collapsing them into a single silent absence is what made a broken
 * translation pipeline invisible in the thread.
 */
export function TranslationToggle({
  isTranslated,
  showOriginal,
  sourceLanguage,
  onToggle,
  onRetry,
  className,
}: {
  /** The bubble is currently rendering a translation. */
  isTranslated: boolean;
  /** The operator has asked to see the original. */
  showOriginal: boolean;
  /** The language the original was written in. */
  sourceLanguage: string | null | undefined;
  onToggle: () => void;
  /** Set only when a translation was expected and is not there. */
  onRetry?: () => Promise<void> | void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const { labelFor } = useLocaleCatalog();
  const label = labelFor(sourceLanguage);

  async function retry() {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  if (onRetry) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-2xs text-text-tertiary', className)}>
        {t('inbox.translationUnavailable') || 'Translation unavailable'}
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          // The disabled state is a token, never an opacity: dimming this
          // 11px line by 0.6 takes it under 3:1 on its own ground, and the
          // whole point of the retry is that it can be read and reached.
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-text-primary disabled:cursor-not-allowed disabled:text-text-disabled disabled:no-underline"
        >
          {retrying ? <Spinner size="sm" label={null} /> : null}
          {retrying ? t('inbox.translating') || 'Translating' : t('inbox.retry') || 'Retry'}
        </button>
      </span>
    );
  }

  // Nothing to offer: the message was already in the operator's language.
  if (!isTranslated && !showOriginal) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1 text-2xs text-text-tertiary',
        'underline underline-offset-2 hover:text-text-primary',
        className,
      )}
    >
      <Languages aria-hidden className="h-3 w-3" />
      {showOriginal
        ? t('inbox.viewTranslation') || 'View translation'
        : label
          ? `View original (${label})`
          : t('inbox.viewOriginal') || 'View original'}
    </button>
  );
}
