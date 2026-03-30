import { TrendingUp, TrendingDown } from 'lucide-react';

export default function StatCard({
    icon: Icon,
    label,
    value,
    trend,
    trendLabel,
    badge,
    badgeColor = 'success',
    loading = false,
    children,
}) {
    const badgeStyles = {
        success: 'bg-success-500/10 text-success-600',
        warning: 'bg-warning-500/10 text-warning-600',
        error: 'bg-error-500/10 text-error-600',
        info: 'bg-info-500/10 text-info-600',
        primary: 'bg-primary-500/10 text-primary-600',
    };

    if (loading) {
        return (
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <div className="animate-pulse space-y-3">
                    <div className="h-4 w-24 bg-secondary-200 rounded-lg" />
                    <div className="h-8 w-20 bg-secondary-200 rounded-lg" />
                    <div className="h-3 w-32 bg-secondary-100 rounded-lg" />
                </div>
            </div>
        );
    }

    return (
        <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm hover:shadow-md transition-all group relative overflow-hidden">
            {/* Subtle gradient accent on hover */}
            <div className="absolute inset-0 bg-gradient-to-br from-primary-500/[0.02] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

            <div className="relative">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-secondary-500 flex items-center gap-2">
                        {Icon && (
                            <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center">
                                <Icon size={16} className="text-primary-600" />
                            </div>
                        )}
                        {label}
                    </h3>
                    {badge && (
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${badgeStyles[badgeColor]}`}>
                            {badge}
                        </span>
                    )}
                </div>

                <div className="flex items-end justify-between">
                    <div>
                        <p className="text-3xl font-bold text-secondary-900 tracking-tight">
                            {value}
                        </p>
                        {trend !== undefined && (
                            <div className="flex items-center gap-1.5 mt-2">
                                {trend >= 0 ? (
                                    <TrendingUp size={14} className="text-success-500" />
                                ) : (
                                    <TrendingDown size={14} className="text-error-500" />
                                )}
                                <span className={`text-xs font-semibold ${trend >= 0 ? 'text-success-600' : 'text-error-600'}`}>
                                    {trend >= 0 ? '+' : ''}{trend}%
                                </span>
                                {trendLabel && (
                                    <span className="text-xs text-secondary-400">{trendLabel}</span>
                                )}
                            </div>
                        )}
                    </div>
                    {children}
                </div>
            </div>
        </div>
    );
}
