import { Clock } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * BusinessHoursEditor — reusable business hours UI.
 *
 * Was previously inlined in the workspace Settings page; now lives in
 * Team → Departments → Edit so each department can have its own schedule.
 * Same JSONB shape on both ends so the backend resolver code stays simple.
 *
 * Value shape (matches Bot.business_hours / Department.business_hours):
 *   {
 *     enabled: bool,
 *     timezone: "Asia/Kolkata",
 *     days: {
 *       mon: { enabled: bool, start: "09:00", end: "17:00" },
 *       tue: { ... },
 *       ...
 *     }
 *   }
 *
 * Empty/null value means "always open" (no business hours restriction).
 *
 * Props:
 *   - value         : current business hours config (or null)
 *   - onChange      : (next) => void  — called on every edit
 *   - saving        : optional bool — render a spinner if true
 *   - disabled      : optional bool
 */

const DAYS = [
    { key: 'mon', label: 'Monday' },
    { key: 'tue', label: 'Tuesday' },
    { key: 'wed', label: 'Wednesday' },
    { key: 'thu', label: 'Thursday' },
    { key: 'fri', label: 'Friday' },
    { key: 'sat', label: 'Saturday' },
    { key: 'sun', label: 'Sunday' },
];

const DEFAULT_HOURS = {
    enabled: false,
    timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
    days: Object.fromEntries(
        DAYS.map(({ key }) => [key, { enabled: key !== 'sat' && key !== 'sun', start: '09:00', end: '17:00' }])
    ),
};

function Toggle({ checked, onChange, disabled, id }) {
    return (
        <button
            type="button"
            role="switch"
            id={id}
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-900',
                'disabled:cursor-not-allowed disabled:opacity-50',
                checked ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-700'
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                    checked ? 'translate-x-4' : 'translate-x-0'
                )}
            />
        </button>
    );
}

export default function BusinessHoursEditor({ value, onChange, disabled = false }) {
    // Merge with defaults so callers can pass null on a freshly-created
    // department without crashing the UI.
    const hours = { ...DEFAULT_HOURS, ...(value || {}), days: { ...DEFAULT_HOURS.days, ...((value || {}).days || {}) } };

    const update = (mutator) => {
        const next = mutator({ ...hours, days: { ...hours.days } });
        onChange(next);
    };

    const tzOptions = (() => {
        try {
            return Intl.supportedValuesOf('timeZone');
        } catch {
            return ['UTC', hours.timezone].filter(Boolean);
        }
    })();

    return (
        <div className="space-y-4">
            {/* Master enable toggle — null/false means "always open" so the
                state resolver short-circuits without checking days. */}
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-sm font-medium text-surface-800 dark:text-surface-200 flex items-center gap-2">
                        <Clock size={14} className="text-primary-600 dark:text-primary-400" />
                        Enable business hours
                    </p>
                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-0.5">
                        Outside these hours, visitors see the offline form for this department.
                    </p>
                </div>
                <Toggle
                    checked={hours.enabled}
                    disabled={disabled}
                    onChange={(v) => update((h) => ({ ...h, enabled: v }))}
                />
            </div>

            {hours.enabled && (
                <>
                    {/* Timezone */}
                    <div className="flex items-center justify-between gap-4">
                        <label className="text-sm text-surface-700 dark:text-surface-300 flex-shrink-0">Timezone</label>
                        <select
                            value={hours.timezone}
                            disabled={disabled}
                            onChange={(e) => update((h) => ({ ...h, timezone: e.target.value }))}
                            className={cn(
                                'text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-1.5',
                                'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                'focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                'max-w-xs'
                            )}
                        >
                            {tzOptions.map((tz) => (
                                <option key={tz} value={tz}>{tz}</option>
                            ))}
                        </select>
                    </div>

                    {/* Per-day rows */}
                    <div className="divide-y divide-surface-100 dark:divide-surface-700 border border-surface-100 dark:border-surface-700 rounded-xl overflow-hidden">
                        {DAYS.map(({ key, label }) => {
                            const day = hours.days?.[key] || { enabled: false, start: '09:00', end: '17:00' };
                            return (
                                <div key={key} className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-surface-900">
                                    <Toggle
                                        id={`bh-${key}`}
                                        checked={day.enabled}
                                        disabled={disabled}
                                        onChange={(v) =>
                                            update((h) => ({
                                                ...h,
                                                days: { ...h.days, [key]: { ...day, enabled: v } },
                                            }))
                                        }
                                    />
                                    <label htmlFor={`bh-${key}`} className="text-sm text-surface-700 dark:text-surface-300 w-24 flex-shrink-0 cursor-pointer">
                                        {label}
                                    </label>
                                    {day.enabled ? (
                                        <div className="flex items-center gap-2 ml-auto">
                                            <input
                                                type="time"
                                                value={day.start}
                                                disabled={disabled}
                                                onChange={(e) =>
                                                    update((h) => ({
                                                        ...h,
                                                        days: { ...h.days, [key]: { ...day, start: e.target.value } },
                                                    }))
                                                }
                                                className="text-xs border border-surface-200 dark:border-surface-600 rounded-lg px-2 py-1 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
                                            />
                                            <span className="text-surface-400 dark:text-surface-500 text-xs">to</span>
                                            <input
                                                type="time"
                                                value={day.end}
                                                disabled={disabled}
                                                onChange={(e) =>
                                                    update((h) => ({
                                                        ...h,
                                                        days: { ...h.days, [key]: { ...day, end: e.target.value } },
                                                    }))
                                                }
                                                className="text-xs border border-surface-200 dark:border-surface-600 rounded-lg px-2 py-1 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
                                            />
                                        </div>
                                    ) : (
                                        <span className="ml-auto text-xs text-surface-400 dark:text-surface-500">Closed</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
