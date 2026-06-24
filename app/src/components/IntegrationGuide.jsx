import { ArrowLeft, Copy, Check, ExternalLink } from 'lucide-react';
import PlatformIcon from './icons/PlatformIcons';
import { cn } from '../lib/utils';

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
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-[11px] font-medium text-surface-500 hover:text-surface-700 dark:hover:text-surface-300 transition-colors flex-shrink-0"
          >
            <ArrowLeft size={13} />
            All platforms
          </button>
          <div className="w-px h-4 bg-surface-200 dark:bg-surface-700 flex-shrink-0" />
          <div className="flex items-center gap-2 min-w-0">
            <PlatformIcon id={platform.id} size={18} />
            <span className="text-sm font-bold text-surface-900 dark:text-white truncate">
              {platform.name}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex items-center gap-1 p-0.5 bg-surface-100 dark:bg-surface-800 rounded-lg">
            <button
              type="button"
              onClick={() => onEnvChange('production')}
              className={cn(
                'px-3 py-1 text-[10px] font-bold rounded-md transition-all',
                env === 'production'
                  ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                  : 'text-surface-400'
              )}
            >
              Production
            </button>
            <button
              type="button"
              onClick={() => onEnvChange('development')}
              className={cn(
                'px-3 py-1 text-[10px] font-bold rounded-md transition-all',
                env === 'development'
                  ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                  : 'text-surface-400'
              )}
            >
              Development
            </button>
          </div>
        </div>
      </div>

      {/* Steps timeline */}
      <div className="relative pl-8">
        <div className="absolute left-3 top-3 bottom-3 w-px bg-surface-200 dark:bg-surface-700" />

        <div className="space-y-5">
          {steps.map((step, idx) => {
            const copyFieldId = `step-${platform.id}-${idx}-${env}`;
            return (
              <div key={idx} className="relative">
                <div className="absolute -left-8 top-0 w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center">
                  <span className="text-[10px] font-bold text-primary-600 dark:text-primary-400">
                    {idx + 1}
                  </span>
                </div>

                <div>
                  <h5 className="text-xs font-bold text-surface-900 dark:text-white">
                    {step.title}
                  </h5>
                  <p className="text-[11px] text-surface-500 mt-0.5 leading-relaxed">
                    {step.description}
                  </p>

                  {step.code && (
                    <div className="mt-2 relative group">
                      <button
                        type="button"
                        onClick={() => onCopy(step.code, copyFieldId)}
                        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md bg-surface-800 dark:bg-surface-700 hover:bg-surface-700 dark:hover:bg-surface-600 text-surface-300 transition-colors opacity-0 group-hover:opacity-100 z-10"
                      >
                        {copiedField === copyFieldId ? <Check size={11} /> : <Copy size={11} />}
                        <span className="text-[9px] font-bold uppercase">
                          {copiedField === copyFieldId ? 'Copied' : 'Copy'}
                        </span>
                      </button>
                      <pre
                        className={cn(
                          'p-4 rounded-xl text-[11px] leading-relaxed overflow-x-auto border font-mono',
                          'bg-surface-950 border-surface-800',
                          env === 'production' ? 'text-emerald-400' : 'text-amber-400'
                        )}
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
      <div className="flex items-center justify-between pt-2 border-t border-surface-100 dark:border-surface-800">
        <p className="text-[10px] text-surface-400">
          Need help?{' '}
          <a
            href="mailto:support@oyechats.com"
            className="text-primary-500 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
          >
            support@oyechats.com
          </a>
        </p>
        <a
          href={`https://docs.oyechats.com/integrations/${platform.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] font-medium text-primary-500 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
        >
          Full docs <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
