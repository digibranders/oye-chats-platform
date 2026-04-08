import { AlertCircle, CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';

const config = {
  info: { icon: Info, bg: 'bg-sky-50 dark:bg-sky-900/20', border: 'border-sky-200 dark:border-sky-800', text: 'text-sky-800 dark:text-sky-200', iconColor: 'text-sky-500' },
  success: { icon: CheckCircle2, bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-800 dark:text-emerald-200', iconColor: 'text-emerald-500' },
  warning: { icon: AlertTriangle, bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-800 dark:text-amber-200', iconColor: 'text-amber-500' },
  error: { icon: AlertCircle, bg: 'bg-rose-50 dark:bg-rose-900/20', border: 'border-rose-200 dark:border-rose-800', text: 'text-rose-800 dark:text-rose-200', iconColor: 'text-rose-500' },
};

export default function Alert({ type = 'info', title, children, onDismiss, className }) {
  const c = config[type];
  const Icon = c.icon;

  return (
    <div className={cn('flex items-start gap-3 p-4 rounded-xl border', c.bg, c.border, className)}>
      <Icon size={16} className={cn('flex-shrink-0 mt-0.5', c.iconColor)} />
      <div className={cn('flex-1 text-sm', c.text)}>
        {title && <p className="font-semibold mb-0.5">{title}</p>}
        {children}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss alert" className={cn('flex-shrink-0 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors', c.text)}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
