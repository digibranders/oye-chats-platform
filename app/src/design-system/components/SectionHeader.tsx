import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (buttons, filters). */
  actions?: ReactNode;
  className?: string;
}

/**
 * SectionHeader - a titled section boundary within a page (mandate shared
 * component). For the page-level title, use `PageContainer`'s header instead.
 */
export function SectionHeader({ title, description, actions, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-[var(--ds-text)]">{title}</h2>
        {description && (
          <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
