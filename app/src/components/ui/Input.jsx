import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

const Input = forwardRef(({ className, icon: Icon, suffix, error, ...props }, ref) => {
  return (
    <div className="relative">
      {Icon && (
        <Icon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 dark:text-surface-500 pointer-events-none" />
      )}
      <input
        ref={ref}
        className={cn(
          'w-full h-10 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 outline-none transition-all duration-200 text-sm',
          Icon ? 'pl-10' : 'pl-3.5',
          suffix ? 'pr-10' : 'pr-3.5',
          error
            ? 'border-rose-400 dark:border-rose-500 focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500'
            : 'border-surface-200 dark:border-surface-700 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400 hover:border-surface-300 dark:hover:border-surface-600',
          className
        )}
        {...props}
      />
      {suffix && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          {suffix}
        </div>
      )}
    </div>
  );
});

Input.displayName = 'Input';

export { Input };
