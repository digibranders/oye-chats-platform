import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Optional call-to-action row (buttons). */
  action?: ReactNode;
  className?: string;
}

/** EmptyState — the standard "nothing here yet" surface. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--ds-border)] px-6 py-14 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Icon size={22} />
        </div>
      )}
      <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
          {description}
        </p>
      )}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}
