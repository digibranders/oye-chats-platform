/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useCallback } from 'react';
import { Toaster, toast as sonnerToast } from 'sonner';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X, Loader2 } from 'lucide-react';

const ToastContext = createContext(null);

const KNOWN_TYPES = new Set(['success', 'error', 'warning', 'info', 'loading', 'default']);

/**
 * Resolve ``(arg1, arg2)`` into ``{type, message}`` regardless of which order
 * the caller used. Historically two argument orders ended up in the codebase:
 *
 *   showToast('success', 'Plan upgraded')   // older convention
 *   showToast('Plan upgraded', 'success')   // newer convention
 *
 * Auto-detecting which arg is the type avoids touching every call site each
 * time we rename a caller, and avoids the symptom from the bug report — a
 * toast that just rendered the literal string "success" because the args
 * were swapped and the actual message was being passed as the type.
 */
function normalizeArgs(a, b) {
    const aIsType = typeof a === 'string' && KNOWN_TYPES.has(a);
    const bIsType = typeof b === 'string' && KNOWN_TYPES.has(b);
    if (aIsType && !bIsType) return { type: a, message: b ?? '' };
    if (bIsType && !aIsType) return { type: b, message: a ?? '' };
    // Both look like types or both don't — default to "first arg is type",
    // which matches the original context signature.
    return { type: typeof a === 'string' ? a : 'info', message: b ?? a ?? '' };
}

const TYPE_STYLES = {
    success: {
        icon: CheckCircle2,
        iconWrap: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
        accent: 'bg-emerald-500',
        ring: 'ring-emerald-500/20 dark:ring-emerald-400/20',
        label: 'Success',
    },
    error: {
        icon: AlertCircle,
        iconWrap: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
        accent: 'bg-rose-500',
        ring: 'ring-rose-500/20 dark:ring-rose-400/20',
        label: 'Error',
    },
    warning: {
        icon: AlertTriangle,
        iconWrap: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
        accent: 'bg-amber-500',
        ring: 'ring-amber-500/20 dark:ring-amber-400/20',
        label: 'Heads up',
    },
    info: {
        icon: Info,
        iconWrap: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400',
        accent: 'bg-sky-500',
        ring: 'ring-sky-500/20 dark:ring-sky-400/20',
        label: 'Info',
    },
    loading: {
        icon: Loader2,
        iconWrap: 'bg-surface-100 text-surface-600 dark:bg-surface-700 dark:text-surface-300',
        accent: 'bg-surface-400',
        ring: 'ring-surface-300/30 dark:ring-surface-600/30',
        label: 'Working…',
    },
};

/**
 * Custom toast card. Sonner gives us a wrapping animated container; this
 * fills it with the polished content. Layout:
 *
 *   [ icon ]  TYPE LABEL                      [ × ]
 *             message body wraps to 2 lines.
 *
 * Left accent bar reinforces the type colour without making the whole
 * card a shouting block of colour. Width is comfortable for one-line
 * messages and graceful for two-line ones; very long messages truncate
 * to 3 lines with an ellipsis rather than ballooning the toast.
 */
function RichToast({ id, type, message }) {
    const conf = TYPE_STYLES[type] || TYPE_STYLES.info;
    const Icon = conf.icon;
    const isLoading = type === 'loading';
    return (
        <div
            role="status"
            className={[
                'pointer-events-auto relative w-[min(360px,calc(100vw-2rem))] overflow-hidden',
                'flex items-start gap-3 px-4 py-3.5 pr-3 rounded-xl',
                'bg-white dark:bg-surface-900',
                'border border-surface-200/80 dark:border-surface-800',
                'shadow-[0_8px_24px_-6px_rgba(15,23,42,0.18),0_2px_6px_-2px_rgba(15,23,42,0.10)]',
                'dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.55)]',
                'ring-1', conf.ring,
            ].join(' ')}
        >
            {/* Accent bar — same colour as the icon's tint but bolder, hugs the left edge. */}
            <span className={`absolute inset-y-0 left-0 w-1 ${conf.accent}`} aria-hidden="true" />

            {/* Icon in a tinted circle */}
            <span
                className={[
                    'shrink-0 mt-0.5 inline-flex items-center justify-center',
                    'w-8 h-8 rounded-full',
                    conf.iconWrap,
                ].join(' ')}
                aria-hidden="true"
            >
                <Icon size={16} className={isLoading ? 'animate-spin' : ''} strokeWidth={2.4} />
            </span>

            {/* Body */}
            <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-surface-500 dark:text-surface-400 leading-none">
                    {conf.label}
                </p>
                <p className="mt-1 text-[13.5px] font-medium leading-snug text-surface-800 dark:text-surface-100 line-clamp-3 break-words">
                    {message}
                </p>
            </div>

            {/* Close button — hidden for loading toasts which auto-resolve. */}
            {!isLoading && (
                <button
                    type="button"
                    onClick={() => sonnerToast.dismiss(id)}
                    aria-label="Dismiss notification"
                    className={[
                        'shrink-0 -mr-1 -mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-md',
                        'text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-200',
                        'hover:bg-surface-100 dark:hover:bg-surface-800',
                        'transition-colors',
                    ].join(' ')}
                >
                    <X size={14} strokeWidth={2.4} />
                </button>
            )}
        </div>
    );
}

/**
 * Helper — render a custom toast of the given type. ``options`` is the
 * standard sonner option bag (``duration``, ``id``, etc.); we just set a
 * sensible default duration per type so errors linger long enough to read.
 */
function emitToast(type, message, options) {
    if (!message) return undefined;
    const durationDefaults = { success: 3500, info: 3500, warning: 5000, error: 6500, loading: Infinity };
    return sonnerToast.custom((id) => <RichToast id={id} type={type} message={message} />, {
        duration: durationDefaults[type] ?? 3500,
        ...options,
    });
}

export function ToastProvider({ children }) {
    const showToast = useCallback((a, b, options) => {
        const { type, message } = normalizeArgs(a, b);
        emitToast(type, message, options);
    }, []);

    const dismissToast = useCallback(() => {
        sonnerToast.dismiss();
    }, []);

    return (
        <ToastContext.Provider value={{ toast: null, showToast, dismissToast }}>
            {children}
            <Toaster
                position="top-right"
                offset={20}
                gap={10}
                // ``richColors`` is intentionally off — we render every toast
                // through ``toast.custom`` and don't want sonner adding its
                // own colour layer underneath ours. ``unstyled`` on the toast
                // option silently disables sonner's <ol> mount, so we instead
                // pass ``classNames`` that zero out sonner's default chrome
                // (padding, border, background, shadow) at the wrapper level.
                // The outer list still mounts (so positioning + animation
                // work), our ``RichToast`` card just owns the inside.
                toastOptions={{
                    className: 'font-sans',
                    classNames: {
                        toast: '!p-0 !bg-transparent !border-0 !shadow-none !w-auto',
                    },
                }}
            />
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within a ToastProvider');
    return ctx;
}
