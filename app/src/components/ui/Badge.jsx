const variants = {
    success: 'bg-success-50 dark:bg-success-500/10 text-success-600 dark:text-success-500 border-success-500/20',
    warning: 'bg-warning-50 dark:bg-warning-500/10 text-warning-600 dark:text-warning-500 border-warning-500/20',
    error: 'bg-error-50 dark:bg-error-500/10 text-error-600 dark:text-error-500 border-error-500/20',
    info: 'bg-info-50 dark:bg-info-500/10 text-info-600 dark:text-info-500 border-info-500/20',
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 border-primary-500/20',
    neutral: 'bg-secondary-100 dark:bg-secondary-800 text-secondary-600 dark:text-secondary-400 border-secondary-200 dark:border-secondary-700',
};

export default function Badge({ children, variant = 'neutral', dot = false, className = '' }) {
    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold rounded-full border ${variants[variant]} ${className}`}>
            {dot && <span className={`w-1.5 h-1.5 rounded-full bg-current`} />}
            {children}
        </span>
    );
}
