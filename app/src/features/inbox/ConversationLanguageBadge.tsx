import { Languages } from 'lucide-react';
import { Badge, Tooltip } from '../../ui';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';
import { t as translateNow } from '../../i18n/i18n';

/**
 * The language this conversation settled into.
 *
 * Renders nothing when the session has no resolved language. That is the
 * normal state for every chatbot without multilingual on, and an "Unknown"
 * chip on every conversation in the list would be noise carrying no fact.
 *
 * Subscribes to the locale catalogue rather than reading it once, so the chip
 * resolves from "HI" to "Hindi" when `GET /locales` lands rather than staying
 * on the raw tag for the rest of the session.
 */
export function ConversationLanguageBadge({
  languageCode,
  className,
}: {
  languageCode: string | null | undefined;
  className?: string;
}) {
  const { labelFor } = useLocaleCatalog();
  const label = labelFor(languageCode);
  if (!label) return null;
  return (
    <Tooltip
      content={
        translateNow('inbox.theVisitorIsWritingIn', { language: label }) ||
        `The visitor is writing in ${label}`
      }
    >
      <Badge tone="neutral" className={className}>
        <Languages aria-hidden className="h-3 w-3" />
        {label}
      </Badge>
    </Tooltip>
  );
}
