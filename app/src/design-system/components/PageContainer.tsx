import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface PageContainerProps {
  /** Page-level title (h1). Omit for pages that render their own header. */
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned page actions. */
  actions?: ReactNode;
  children: ReactNode;
  /** Constrain content width. Defaults to the standard 7xl reading measure. */
  width?: 'default' | 'wide' | 'full';
  className?: string;
}

const widthMap: Record<NonNullable<PageContainerProps['width']>, string> = {
  default: 'max-w-7xl',
  wide: 'max-w-[96rem]',
  full: 'max-w-none',
};

/**
 * PageContainer — the standard page shell: centered measure, page header
 * (title / description / actions), and vertically-spaced content. Every
 * routed surface renders inside one so pages stay visually consistent.
 */
export function PageContainer({
  title,
  description,
  actions,
  children,
  width = 'default',
  className,
}: PageContainerProps) {
  return (
    <div className={cn('mx-auto w-full', widthMap[width], className)}>
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h1 className="text-xl font-bold tracking-tight text-[var(--ds-text)]">{title}</h1>
            )}
            {description && (
              <p className="mt-1.5 text-sm text-[var(--ds-text-muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="space-y-6">{children}</div>
    </div>
  );
}
