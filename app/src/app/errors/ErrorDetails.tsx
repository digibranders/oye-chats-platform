import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../design-system';
import { useTranslation } from '../../i18n/useTranslation';

interface ErrorDetailsProps {
  detail?: string;
  className?: string;
}

/**
 * Collapsible technical detail (message + stack) for an error surface. Renders
 * nothing in production builds - end users never see a stack trace, but during
 * development this replaces React Router's raw crash screen with an inspectable,
 * on-brand panel.
 */
export function ErrorDetails({ detail, className }: ErrorDetailsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!import.meta.env.DEV || !detail) return null;

  return (
    <div className={cn('mt-6 text-left', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text-muted)]"
      >
        <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
        {open
          ? t('app.hideTechnicalDetails') || 'Hide technical details'
          : t('app.showTechnicalDetails') || 'Show technical details'}
      </button>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-3 text-[11px] leading-relaxed text-[var(--ds-text-muted)]">
          {detail}
        </pre>
      )}
    </div>
  );
}
