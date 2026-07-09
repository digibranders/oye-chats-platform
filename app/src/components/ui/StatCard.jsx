import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Skeleton } from './SkeletonLoader';

/**
 * StatCard — premium KPI tile (Shopeers-grade composition):
 *   [ label ................... icon-tile ]
 *   [ value  ▲delta ]
 *   [ caption ]                 [ sparkline ]
 *
 * Backwards-compatible props: icon, label, value, trend, trendLabel, badge,
 * badgeColor, loading, sparkline, children, className. New: `caption`
 * (the "vs. X last period" line under the value).
 */
export default function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  trendLabel,
  caption,
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
    info: 'bg-primary-500/10 text-primary-600 dark:bg-primary-400/10 dark:text-primary-400',
    primary: 'bg-primary-500/10 text-primary-600 dark:bg-primary-400/10 dark:text-primary-400',
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-[var(--bg-card)] dark:bg-surface-900 p-5">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }

  const hasTrend = trend !== undefined && trend !== null;
  const trendUp = hasTrend && trend >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'rounded-2xl border border-surface-200 dark:border-surface-800 bg-[var(--bg-card)] dark:bg-surface-900 p-5 hover:shadow-md dark:hover:shadow-surface-950/50 transition-all duration-200 group relative overflow-hidden',
        className
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary-500/[0.02] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

      <div className="relative">
        {/* Row 1: label (left) + icon tile (right) */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-surface-500 dark:text-surface-400 truncate">{label}</span>
            {badge && (
              <span className={cn('text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0', badgeStyles[badgeColor])}>
                {badge}
              </span>
            )}
          </div>
          {Icon && (
            <div className="w-9 h-9 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center shrink-0">
              <Icon size={17} className="text-primary-600 dark:text-primary-400" />
            </div>
          )}
        </div>

        {/* Row 2: value + delta pill */}
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="text-[26px] leading-none font-bold text-surface-900 dark:text-surface-50 tracking-tight tabular-nums"
              >
                {value}
              </motion.p>
              {hasTrend && (
                <span className={cn(
                  'inline-flex items-center gap-0.5 text-[11px] font-bold px-1.5 py-0.5 rounded-full',
                  trendUp
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                )}>
                  {trendUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  {trendUp ? '+' : ''}{trend}%
                </span>
              )}
            </div>
            {(caption || trendLabel) && (
              <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-2">
                {caption || trendLabel}
              </p>
            )}
          </div>

          {sparkline && (
            <div className="flex items-end gap-0.5 h-8 opacity-60 group-hover:opacity-100 transition-opacity shrink-0">
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
