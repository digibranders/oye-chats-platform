import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 font-semibold transition-colors',
  {
    variants: {
      variant: {
        solid: '',
        soft: '',
        outline: 'bg-transparent border',
      },
      color: {
        default: '',
        primary: '',
        success: '',
        warning: '',
        error: '',
        info: '',
      },
      size: {
        xs: 'text-[9px] px-1.5 py-0.5 rounded',
        sm: 'text-[10px] px-2 py-0.5 rounded-md',
        md: 'text-xs px-2.5 py-1 rounded-lg',
      },
    },
    compoundVariants: [
      { variant: 'solid', color: 'default', className: 'bg-surface-600 text-white dark:bg-surface-500' },
      { variant: 'solid', color: 'primary', className: 'bg-primary-600 text-white' },
      { variant: 'solid', color: 'success', className: 'bg-emerald-600 text-white' },
      { variant: 'solid', color: 'warning', className: 'bg-amber-500 text-white' },
      { variant: 'solid', color: 'error', className: 'bg-rose-600 text-white' },
      { variant: 'solid', color: 'info', className: 'bg-sky-600 text-white' },
      { variant: 'soft', color: 'default', className: 'bg-surface-100 text-surface-700 dark:bg-surface-800 dark:text-surface-300' },
      { variant: 'soft', color: 'primary', className: 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300' },
      { variant: 'soft', color: 'success', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
      { variant: 'soft', color: 'warning', className: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
      { variant: 'soft', color: 'error', className: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' },
      { variant: 'soft', color: 'info', className: 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
      { variant: 'outline', color: 'default', className: 'border-surface-300 text-surface-600 dark:border-surface-600 dark:text-surface-400' },
      { variant: 'outline', color: 'primary', className: 'border-primary-300 text-primary-600 dark:border-primary-600 dark:text-primary-400' },
      { variant: 'outline', color: 'success', className: 'border-emerald-300 text-emerald-600 dark:border-emerald-600 dark:text-emerald-400' },
      { variant: 'outline', color: 'warning', className: 'border-amber-300 text-amber-600 dark:border-amber-600 dark:text-amber-400' },
      { variant: 'outline', color: 'error', className: 'border-rose-300 text-rose-600 dark:border-rose-600 dark:text-rose-400' },
      { variant: 'outline', color: 'info', className: 'border-sky-300 text-sky-600 dark:border-sky-600 dark:text-sky-400' },
    ],
    defaultVariants: {
      variant: 'soft',
      color: 'default',
      size: 'sm',
    },
  }
);

export default function Badge({ className, variant, color, size, dot, children, ...props }) {
  return (
    <span className={cn(badgeVariants({ variant, color, size }), className)} {...props}>
      {dot && (
        <span className={cn(
          'w-1.5 h-1.5 rounded-full',
          color === 'success' && 'bg-emerald-500',
          color === 'warning' && 'bg-amber-500',
          color === 'error' && 'bg-rose-500',
          color === 'info' && 'bg-sky-500',
          color === 'primary' && 'bg-primary-500',
          (!color || color === 'default') && 'bg-surface-500',
        )} />
      )}
      {children}
    </span>
  );
}
