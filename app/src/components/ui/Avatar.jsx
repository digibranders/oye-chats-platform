import { cn } from '../../lib/utils';

const sizes = {
  xs: 'w-6 h-6 text-[9px]',
  sm: 'w-8 h-8 text-[10px]',
  md: 'w-9 h-9 text-xs',
  lg: 'w-11 h-11 text-sm',
  xl: 'w-14 h-14 text-base',
};

const statusColors = {
  online: 'bg-emerald-500',
  offline: 'bg-surface-400',
  busy: 'bg-rose-500',
  away: 'bg-amber-500',
};

export default function Avatar({ src, name, size = 'md', status, className }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className={cn('relative flex-shrink-0', className)}>
      {src ? (
        <img
          src={src}
          alt={name || ''}
          className={cn(
            'rounded-full object-cover',
            status === 'online'
              ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-white dark:ring-offset-surface-900'
              : 'ring-2 ring-white dark:ring-surface-900',
            sizes[size]
          )}
        />
      ) : (
        <div className={cn(
          'rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center font-bold',
          status === 'online'
            ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-white dark:ring-offset-surface-900'
            : 'ring-2 ring-white dark:ring-surface-900',
          sizes[size]
        )}>
          {initials}
        </div>
      )}
      {status && status !== 'online' && (
        <span className={cn(
          'absolute bottom-0 right-0 rounded-full border-2 border-white dark:border-surface-900',
          statusColors[status] || statusColors.offline,
          size === 'xs' || size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3',
        )} />
      )}
    </div>
  );
}
