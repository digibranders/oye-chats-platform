const variants = {
    success: 'bg-success-50 text-success-600 border-success-500/20',
    warning: 'bg-warning-50 text-warning-600 border-warning-500/20',
    error: 'bg-error-50 text-error-600 border-error-500/20',
    info: 'bg-info-50 text-info-600 border-info-500/20',
    primary: 'bg-primary-50 text-primary-600 border-primary-500/20',
    neutral: 'bg-secondary-100 text-secondary-600 border-secondary-200',
};

export default function Badge({ children, variant = 'neutral', dot = false, className = '' }) {
    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold rounded-full border ${variants[variant]} ${className}`}>
            {dot && <span className={`w-1.5 h-1.5 rounded-full bg-current`} />}
            {children}
        </span>
    );
}
