import { Bot, Plus, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function EmptyState({
    icon: Icon = Bot,
    title = 'Nothing here yet',
    description = 'Get started by creating your first chatbot.',
    actionLabel,
    actionTo,
    onAction,
    compact = false,
}) {
    const navigate = useNavigate();

    const handleAction = () => {
        if (onAction) return onAction();
        if (actionTo) navigate(actionTo);
    };

    return (
        <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-10' : 'py-16'}`}>
            <div className={`${compact ? 'w-14 h-14' : 'w-20 h-20'} rounded-2xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-5`}>
                <Icon size={compact ? 24 : 36} className="text-primary-500 dark:text-primary-400" />
            </div>

            <h3 className={`${compact ? 'text-lg' : 'text-xl'} font-bold text-secondary-900 dark:text-white mb-2`}>
                {title}
            </h3>

            <p className="text-secondary-500 dark:text-secondary-400 max-w-sm mb-6 leading-relaxed text-sm">
                {description}
            </p>

            {(actionLabel && (actionTo || onAction)) && (
                <button
                    onClick={handleAction}
                    className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-semibold text-sm shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
                >
                    <Plus size={16} />
                    {actionLabel}
                    <ArrowRight size={14} />
                </button>
            )}
        </div>
    );
}
