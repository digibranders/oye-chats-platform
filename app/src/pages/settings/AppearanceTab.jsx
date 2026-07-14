import { Sun, Moon, Monitor, Check } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { cn } from '../../lib/utils';

/**
 * AppearanceTab — admin dashboard theme switcher.
 *
 * Wired to ThemeContext: Light / Dark, plus System which follows the OS
 * preference. The chosen mode persists per browser (localStorage) and is
 * applied before first paint (see the inline script in index.html).
 */

const OPTIONS = [
    { id: 'light', label: 'Light', desc: 'Bright, high-contrast interface.', Icon: Sun },
    { id: 'dark', label: 'Dark', desc: 'Dimmed surfaces for low-light work.', Icon: Moon },
    { id: 'system', label: 'System', desc: 'Match your device appearance.', Icon: Monitor },
];

export default function AppearanceTab() {
    const { mode, theme, setMode } = useTheme();

    return (
        <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
            <h2 className="text-base font-bold text-surface-900 dark:text-surface-100 mb-1 flex items-center gap-2">
                <Sun size={16} className="text-primary-600 dark:text-primary-400" />
                Appearance
            </h2>
            <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                Choose how OyeChats looks. System follows your device’s light or dark setting
                {mode === 'system' ? ` (currently ${theme}).` : '.'}
            </p>

            <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
                {OPTIONS.map((opt) => {
                    const { id, label, desc } = opt;
                    const OptIcon = opt.Icon;
                    const active = mode === id;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => setMode(id)}
                            className={cn(
                                'group relative flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
                                active
                                    ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 ring-1 ring-primary-500/30'
                                    : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600 hover:bg-surface-50 dark:hover:bg-surface-800/50'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-flex h-10 w-10 items-center justify-center rounded-lg shrink-0',
                                    active
                                        ? 'bg-primary-600 text-white'
                                        : 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400'
                                )}
                            >
                                <OptIcon size={18} />
                            </span>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-surface-900 dark:text-surface-100">{label}</p>
                                <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{desc}</p>
                            </div>
                            {active && (
                                <span className="absolute top-3 right-3 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-white">
                                    <Check size={12} />
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
