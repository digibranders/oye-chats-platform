import { Sun, Moon, Monitor, Check, Palette } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTheme } from '../../context/ThemeContext';

const THEME_OPTIONS = [
    { id: 'system', label: 'System', description: 'Match your device setting', icon: Monitor },
    { id: 'light', label: 'Light', description: 'Always use the light theme', icon: Sun },
    { id: 'dark', label: 'Dark', description: 'Always use the dark theme', icon: Moon },
];

/**
 * AppearanceTab — admin dashboard theme selector (system / light / dark).
 *
 * Migrated verbatim from the legacy Settings "Appearance" section. Theme is a
 * device-local preference handled entirely by ThemeContext (persisted in
 * localStorage); there is no backend involved.
 */
export default function AppearanceTab() {
    const { mode: themeMode, setMode: setThemeMode } = useTheme();

    return (
        <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
            <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                <Palette size={16} className="text-primary-600 dark:text-primary-400" />
                Appearance
            </h2>
            <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                Choose how the admin dashboard looks. Affects this device only.
            </p>

            <div
                role="radiogroup"
                aria-label="Theme"
                className="grid grid-cols-1 sm:grid-cols-3 gap-3"
            >
                {THEME_OPTIONS.map((option) => {
                    const { id, label, description } = option;
                    const Icon = option.icon;
                    const selected = themeMode === id;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setThemeMode(id)}
                            className={cn(
                                'group relative text-left p-4 rounded-xl border transition-all',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-900',
                                selected
                                    ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 ring-1 ring-primary-500/30'
                                    : 'border-surface-200 dark:border-surface-700 hover:border-primary-300 dark:hover:border-primary-500/40 hover:bg-surface-50 dark:hover:bg-surface-800/60'
                            )}
                        >
                            <div className="flex items-center justify-between">
                                <span
                                    className={cn(
                                        'inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                                        selected
                                            ? 'bg-primary-600 text-white'
                                            : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 group-hover:text-primary-600 dark:group-hover:text-primary-400'
                                    )}
                                >
                                    <Icon size={16} />
                                </span>
                                {selected && (
                                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-white">
                                        <Check size={12} />
                                    </span>
                                )}
                            </div>
                            <p className="mt-3 text-sm font-medium text-surface-900 dark:text-surface-50">{label}</p>
                            <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{description}</p>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
