export default function PageHeader({ title, subtitle, children }) {
    return (
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
            <div>
                <h1 className="text-2xl font-bold text-secondary-900 tracking-tight">
                    {title}
                </h1>
                {subtitle && (
                    <p className="text-secondary-500 mt-1 text-sm">
                        {subtitle}
                    </p>
                )}
            </div>
            {children && (
                <div className="flex items-center gap-3 shrink-0">
                    {children}
                </div>
            )}
        </div>
    );
}
