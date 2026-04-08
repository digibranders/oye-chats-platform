import { cn } from '../../lib/utils';

function Skeleton({ className }) {
  return (
    <div className={cn(
      'rounded-lg bg-gradient-to-r from-surface-200 via-surface-100 to-surface-200 dark:from-surface-800 dark:via-surface-700 dark:to-surface-800 bg-[length:200%_100%] animate-shimmer',
      className
    )} />
  );
}

export function SkeletonText({ lines = 3, width = 'w-32', height = 'h-4', className }) {
  if (lines > 1) {
    return (
      <div className={cn('space-y-2.5', className)}>
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-3/4' : 'w-full')} />
        ))}
      </div>
    );
  }
  return <Skeleton className={cn(height, width, className)} />;
}

export function SkeletonCard({ className }) {
  return (
    <div className={cn('rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6', className)}>
      <div className="space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-3 w-full" />
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }) {
  return (
    <div className="w-full">
      <div className="flex gap-4 px-5 py-3 border-b border-surface-100 dark:border-surface-800">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-5 py-4 border-b border-surface-50 dark:border-surface-800/50 last:border-0">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className={cn('h-4 flex-1', j === 0 && 'max-w-[200px]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart({ className }) {
  return (
    <div className={cn('rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6', className)}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

export { Skeleton };
