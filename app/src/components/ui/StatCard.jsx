import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Skeleton } from './SkeletonLoader';

export default function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  trendLabel,
  badge,
  badgeColor = 'success',
  loading = false,
  sparkline,
  children,
  className,
}) {
  const badgeStyles = {
    success: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400',
    warning: 'bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400',
    error: 'bg-rose-500/10 text-rose-600 dark:bg-rose-400/10 dark:text-rose-400',
    info: 'bg-sky-500/10 text-sky-600 dark:bg-sky-400/10 dark:text-sky-400',
    primary: 'bg-primary-500/10 text-primary-600 dark:bg-primary-400/10 dark:text-primary-400',
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5 hover:shadow-md dark:hover:shadow-surface-950/50 transition-all duration-200 group relative overflow-hidden',
        className
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary-500/[0.02] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <div className="w-8 h-8 rounded-lg bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                <Icon size={16} className="text-primary-600 dark:text-primary-400" />
              </div>
            )}
            <span className="text-[13px] font-medium text-surface-500 dark:text-surface-400">{label}</span>
          </div>
          {badge && (
            <span className={cn('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full', badgeStyles[badgeColor])}>
              {badge}
            </span>
          )}
        </div>

        <div className="flex items-end justify-between gap-4">
          <div>
            <motion.p
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-2xl font-bold text-surface-900 dark:text-surface-50 tracking-tight"
            >
              {value}
            </motion.p>
            {trend !== undefined && (
              <div className="flex items-center gap-1.5 mt-1.5">
                {trend >= 0 ? (
                  <TrendingUp size={13} className="text-emerald-500" />
                ) : (
                  <TrendingDown size={13} className="text-rose-500" />
                )}
                <span className={cn('text-xs font-semibold', trend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                  {trend >= 0 ? '+' : ''}{trend}%
                </span>
                {trendLabel && (
                  <span className="text-xs text-surface-400 dark:text-surface-500">{trendLabel}</span>
                )}
              </div>
            )}
          </div>
          {sparkline && (
            <div className="flex items-end gap-0.5 h-8 opacity-60 group-hover:opacity-100 transition-opacity">
              {sparkline.map((v, i) => (
                <motion.div
                  key={i}
                  initial={{ height: 0 }}
                  animate={{ height: `${Math.max((v / Math.max(...sparkline)) * 100, 8)}%` }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                  className="w-1 rounded-full bg-primary-400 dark:bg-primary-500"
                />
              ))}
            </div>
          )}
          {children}
        </div>
      </div>
    </motion.div>
  );
}
