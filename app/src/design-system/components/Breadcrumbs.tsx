import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';

export interface Crumb {
  label: string;
  to: string;
}

export interface BreadcrumbsProps {
  items: Crumb[];
  className?: string;
}

/**
 * Breadcrumbs — presentational trail. The last item renders as the current
 * page (non-link). Data is supplied by the shell's `useBreadcrumbs` hook,
 * which derives the trail from the matched route handles.
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1.5 text-[13px]', className)}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <Fragment key={item.to}>
            {isLast ? (
              <span className="font-medium text-[var(--ds-text)]" aria-current="page">
                {item.label}
              </span>
            ) : (
              <Link
                to={item.to}
                className="text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)]"
              >
                {item.label}
              </Link>
            )}
            {!isLast && (
              <ChevronRight size={14} className="text-[var(--ds-text-subtle)]" aria-hidden="true" />
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
