import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';

export default function Progress({ value = 0, max = 100, size = 'md', color = 'primary', className, animated = true }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);

  const heights = { xs: 'h-1', sm: 'h-1.5', md: 'h-2', lg: 'h-3' };
  const colors = {
    primary: 'bg-primary-500',
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    error: 'bg-rose-500',
    info: 'bg-sky-500',
    dynamic: pct >= 75 ? 'bg-emerald-500 dark:bg-emerald-400' : pct >= 50 ? 'bg-sky-500 dark:bg-sky-400' : pct >= 25 ? 'bg-amber-500 dark:bg-amber-400' : 'bg-surface-400 dark:bg-surface-500',
  };

  return (
    <div className={cn('w-full bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden', heights[size], className)}>
      <motion.div
        initial={animated ? { width: 0 } : false}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className={cn('h-full rounded-full', colors[color])}
      />
    </div>
  );
}

export function CircularProgress({ value = 0, max = 100, size = 48, strokeWidth = 4, color = 'primary', children }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  const colors = {
    primary: 'text-primary-500',
    success: 'text-emerald-500',
    warning: 'text-amber-500',
    error: 'text-rose-500',
    dynamic: pct >= 75 ? 'text-emerald-500' : pct >= 50 ? 'text-sky-500' : pct >= 25 ? 'text-amber-500' : 'text-surface-400',
  };

  return (
    <div className="relative inline-flex items-center justify-center" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" strokeWidth={strokeWidth}
          className="stroke-surface-100 dark:stroke-surface-800"
        />
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" strokeWidth={strokeWidth} strokeLinecap="round"
          className={cn('stroke-current', colors[color])}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          style={{ strokeDasharray: circumference }}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      )}
    </div>
  );
}
