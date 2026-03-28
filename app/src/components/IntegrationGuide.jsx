import { ArrowLeft, Copy, Check, ExternalLink } from 'lucide-react';
import PlatformIcon from './icons/PlatformIcons';

/**
 * Renders step-by-step integration instructions for a selected platform.
 *
 * @param {Object}   props
 * @param {Object}   props.platform     - Platform config object from platformIntegrations.js
 * @param {string}   props.botKey       - The bot's key (e.g. "bot-abc123")
 * @param {string}   props.env          - 'production' | 'development'
 * @param {Function} props.onEnvChange  - Callback to toggle env
 * @param {Function} props.onBack       - Callback to go back to platform selector
 * @param {Function} props.onCopy       - Callback (text, fieldId) => void
 * @param {string|null} props.copiedField - Currently copied field id
 */
export default function IntegrationGuide({
    platform,
    botKey,
    env,
    onEnvChange,
    onBack,
    onCopy,
    copiedField,
}) {
    const steps = platform.getSteps(botKey, env);

    return (
        <div className="space-y-4 animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <button
                        type="button"
                        onClick={onBack}
                        className="flex items-center gap-1 text-[11px] font-medium text-secondary-500 hover:text-secondary-700 dark:hover:text-secondary-300 transition-colors flex-shrink-0"
                    >
                        <ArrowLeft size={13} />
                        All platforms
                    </button>
                    <div className="w-px h-4 bg-secondary-200 dark:bg-secondary-700 flex-shrink-0" />
                    <div className="flex items-center gap-2 min-w-0">
                        <PlatformIcon id={platform.id} size={18} />
                        <span className="text-sm font-bold text-secondary-900 dark:text-white truncate">
                            {platform.name}
                        </span>
                    </div>
                </div>

                {/* Env toggle + docs link */}
                <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="flex items-center gap-1 p-0.5 bg-secondary-100 dark:bg-secondary-800 rounded-lg">
                        <button
                            type="button"
                            onClick={() => onEnvChange('production')}
                            className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${
                                env === 'production'
                                    ? 'bg-white dark:bg-secondary-700 text-secondary-900 dark:text-white shadow-sm'
                                    : 'text-secondary-400'
                            }`}
                        >
                            Production
                        </button>
                        <button
                            type="button"
                            onClick={() => onEnvChange('development')}
                            className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${
                                env === 'development'
                                    ? 'bg-white dark:bg-secondary-700 text-secondary-900 dark:text-white shadow-sm'
                                    : 'text-secondary-400'
                            }`}
                        >
                            Development
                        </button>
                    </div>
                </div>
            </div>

            {/* Steps timeline */}
            <div className="relative pl-8">
                {/* Vertical connector line */}
                <div className="absolute left-3 top-3 bottom-3 w-px bg-secondary-200 dark:bg-secondary-700" />

                <div className="space-y-5">
                    {steps.map((step, idx) => {
                        const copyFieldId = `step-${platform.id}-${idx}-${env}`;
                        return (
                            <div key={idx} className="relative">
                                {/* Step number badge */}
                                <div className="absolute -left-8 top-0 w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-500/15 flex items-center justify-center">
                                    <span className="text-[10px] font-bold text-primary-600 dark:text-primary-400">
                                        {idx + 1}
                                    </span>
                                </div>

                                {/* Step content */}
                                <div>
                                    <h5 className="text-xs font-bold text-secondary-900 dark:text-white">
                                        {step.title}
                                    </h5>
                                    <p className="text-[11px] text-secondary-500 dark:text-secondary-400 mt-0.5 leading-relaxed">
                                        {step.description}
                                    </p>

                                    {step.code && (
                                        <div className="mt-2 relative group">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    onCopy(
                                                        step.code,
                                                        copyFieldId,
                                                    )
                                                }
                                                className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md bg-secondary-800 hover:bg-secondary-700 text-secondary-300 transition-colors opacity-0 group-hover:opacity-100 z-10"
                                            >
                                                {copiedField === copyFieldId ? (
                                                    <Check size={11} />
                                                ) : (
                                                    <Copy size={11} />
                                                )}
                                                <span className="text-[9px] font-bold uppercase">
                                                    {copiedField === copyFieldId
                                                        ? 'Copied'
                                                        : 'Copy'}
                                                </span>
                                            </button>
                                            <pre
                                                className={`p-4 rounded-xl text-[11px] leading-relaxed overflow-x-auto border font-mono ${
                                                    env === 'production'
                                                        ? 'bg-secondary-900 dark:bg-secondary-950 text-green-400 border-secondary-800'
                                                        : 'bg-secondary-900 dark:bg-secondary-950 text-amber-400 border-secondary-800'
                                                }`}
                                            >
                                                {step.code}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-secondary-100 dark:border-secondary-800">
                <p className="text-[10px] text-secondary-400">
                    Need help?{' '}
                    <a
                        href="mailto:developer@oyechats.com"
                        className="text-primary-500 hover:text-primary-600 transition-colors"
                    >
                        developer@oyechats.com
                    </a>
                </p>
                <a
                    href={`https://docs.oyechats.com/integrations/${platform.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] font-medium text-primary-500 hover:text-primary-600 transition-colors"
                >
                    Full docs <ExternalLink size={10} />
                </a>
            </div>
        </div>
    );
}
