import { useState, type ReactElement } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import { cn } from '../../design-system';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Per-message original/translated control shown under a bubble.
 *
 * Three states, because "no translation" and "translation failed" are
 * different things to an operator: one means the message was already in their
 * language, the other means the provider was down and there is something to
 * retry.
 */
export function TranslationToggle({
  isTranslated,
  showOriginal,
  sourceLanguage,
  onToggle,
  onRetry,
  className,
}: {
  /** True when the bubble is currently rendering a translation. */
  isTranslated: boolean;
  /** True when the operator has chosen to see the original. */
  showOriginal: boolean;
  /** Language the original was written in. */
  sourceLanguage: string | null | undefined;
  onToggle: () => void;
  /** Present only when a translation was expected but is not available. */
  onRetry?: () => Promise<void> | void;
  className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const { labelFor } = useLocaleCatalog();
  const label = labelFor(sourceLanguage);

  const handleRetry = async (): Promise<void> => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  if (onRetry) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-[11px] text-[var(--ds-text-subtle)]', className)}>
        <span>{t('inbox.translationUnavailable') || 'Translation unavailable'}</span>
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={retrying}
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-[var(--ds-text)] disabled:opacity-60"
        >
          {retrying ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : null}
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
        'inline-flex items-center gap-1 text-[11px] text-[var(--ds-text-subtle)]',
        'underline underline-offset-2 hover:text-[var(--ds-text)]',
        className,
      )}
    >
      <Languages size={11} aria-hidden="true" />
      {showOriginal ? t('inbox.viewTranslation') || 'View translation' : label
            ? t('inbox.viewOriginalIn', { language: label }) || `View original (${label})`
            : t('inbox.viewOriginal') || 'View original'}
    </button>
  );
}
