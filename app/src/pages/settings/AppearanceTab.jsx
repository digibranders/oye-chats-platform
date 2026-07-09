import { Sun, Check } from 'lucide-react';

/**
 * AppearanceTab — admin dashboard appearance.
 *
 * Dark mode is disabled for now, so the app runs light-only (see
 * ThemeContext). This tab shows the active Light theme as a read-only state
 * rather than a switcher; the System/Dark options return when dark mode is
 * re-enabled.
 */
export default function AppearanceTab() {
    return (
        <div className="bg-[var(--bg-card)] p-6 rounded-2xl border border-surface-200 shadow-sm">
            <h2 className="text-base font-bold text-surface-900 mb-1 flex items-center gap-2">
                <Sun size={16} className="text-primary-600" />
                Appearance
            </h2>
            <p className="text-sm text-surface-500 mb-5">
                OyeChats currently uses a single, refined light theme. A dark theme is on the way.
            </p>

            <div className="flex items-center gap-4 p-4 rounded-xl border border-primary-500 bg-primary-50/60 ring-1 ring-primary-500/30">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary-600 text-white shrink-0">
                    <Sun size={18} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-surface-900">Light</p>
                    <p className="text-xs text-surface-500 mt-0.5">Active theme for this workspace.</p>
                </div>
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-white shrink-0">
                    <Check size={12} />
                </span>
            </div>
        </div>
    );
}
