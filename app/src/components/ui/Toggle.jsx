import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';

export default function Toggle({ checked, onChange, disabled = false, size = 'md', id }) {
  const sizeConfig = {
    sm: { track: 'w-7 h-4', thumb: 'w-3 h-3', translate: 12 },
    md: { track: 'w-9 h-5', thumb: 'w-4 h-4', translate: 16 },
    lg: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 20 },
  };
  const s = sizeConfig[size] || sizeConfig.md;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        s.track,
        checked ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-600'
      )}
    >
      <motion.span
        animate={{ x: checked ? s.translate : 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className={cn(
          'pointer-events-none inline-block rounded-full bg-white shadow-sm ring-0 m-0.5',
          s.thumb
        )}
      />
    </button>
  );
}
