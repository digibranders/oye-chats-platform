const shimmerClass = 'bg-gradient-to-r from-secondary-200 via-secondary-100 to-secondary-200 bg-[length:200%_100%] animate-shimmer rounded-lg';

export function SkeletonText({ width = 'w-32', height = 'h-4' }) {
    return <div className={`${shimmerClass} ${width} ${height}`} />;
}

export function SkeletonCard() {
    return (
        <div className="bg-white p-6 rounded-2xl border border-secondary-200">
            <div className="space-y-3">
                <div className={`${shimmerClass} h-4 w-24`} />
                <div className={`${shimmerClass} h-8 w-20`} />
                <div className={`${shimmerClass} h-3 w-36`} />
            </div>
        </div>
    );
}

export function SkeletonTable({ rows = 5, cols = 4 }) {
    return (
        <div className="bg-white rounded-2xl border border-secondary-200 overflow-hidden">
            {/* Header */}
            <div className="flex gap-4 p-4 border-b border-secondary-100 bg-secondary-50">
                {Array.from({ length: cols }).map((_, i) => (
                    <div key={i} className={`${shimmerClass} h-3 flex-1`} />
                ))}
            </div>
            {/* Rows */}
            {Array.from({ length: rows }).map((_, row) => (
                <div key={row} className="flex gap-4 p-4 border-b border-secondary-50 last:border-0">
                    {Array.from({ length: cols }).map((_, col) => (
                        <div key={col} className={`${shimmerClass} h-4 flex-1`} />
                    ))}
                </div>
            ))}
        </div>
    );
}

export function SkeletonChart() {
    return (
        <div className="bg-white p-6 rounded-2xl border border-secondary-200">
            <div className="space-y-4">
                <div className="flex justify-between">
                    <div className={`${shimmerClass} h-5 w-40`} />
                    <div className={`${shimmerClass} h-5 w-24`} />
                </div>
                <div className={`${shimmerClass} h-64 w-full`} />
            </div>
        </div>
    );
}
