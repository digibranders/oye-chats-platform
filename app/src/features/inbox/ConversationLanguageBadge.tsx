import type { ReactElement } from 'react';
import { Languages } from 'lucide-react';
import { cn } from '../../design-system';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * The conversation's resolved language, shown in the session sidebar.
 *
 * Renders nothing when the session has no resolved language: that is the
 * normal state for a bot without multilingual enabled, and an "Unknown"
 * chip there would be noise on every conversation.
 *
 * Subscribes to the locale catalogue rather than reading it once, so the
 * chip resolves from "HI" to "Hindi" when `GET /locales` lands.
 */
export function ConversationLanguageBadge({
  languageCode,
  className,
}: {
  languageCode: string | null | undefined;
  className?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const { labelFor } = useLocaleCatalog();
  const label = labelFor(languageCode);
  if (!label) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-[var(--ds-bg-sunken)] px-2 py-0.5',
        'text-[11px] text-[var(--ds-text-muted)]',
        className,
      )}
      title={t('inbox.visitorWritingIn', { language: label }) || `Visitor is writing in ${label}`}
    >
      <Languages size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
