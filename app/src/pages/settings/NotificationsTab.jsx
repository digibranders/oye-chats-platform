import { useState } from 'react';
import { Bell, BellOff, ShieldAlert, Loader2, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import { usePush } from '../../context/PushContext';

/**
 * NotificationsTab — browser/desktop push enable–disable controls.
 *
 * Reads the shared push state from PushContext (same instance the
 * PushPermissionBanner uses), so toggling here updates the banner and vice
 * versa. Three meaningful states:
 *   • Enabled  — permission granted + subscribed → offer "Turn off".
 *   • Off      — permission default / not subscribed → offer "Enable".
 *   • Blocked  — permission denied → JS cannot re-prompt, so show the
 *                lock-icon recovery copy reused from PushPermissionBanner.
 */
export default function NotificationsTab() {
    const { showToast } = useToast();
    const push = usePush();
    const { supported, permission, subscribed, error, initializing, request, disable } = push;

    const [busy, setBusy] = useState(false);
    const [stillBlocked, setStillBlocked] = useState(false);

    const isEnabled = permission === 'granted' && subscribed && !error;
    const isBlocked = permission === 'denied';

    const handleEnable = async () => {
        setBusy(true);
        setStillBlocked(false);
        try {
            const result = await request();
            if (result === 'denied') {
                setStillBlocked(true);
                showToast('warning', 'Notifications are blocked in your browser.');
            } else if (result === 'granted') {
                showToast('success', 'Browser notifications enabled.');
            }
        } finally {
            setBusy(false);
        }
    };

    const handleDisable = async () => {
        setBusy(true);
        try {
            await disable();
            showToast('success', 'Browser notifications turned off.');
        } finally {
            setBusy(false);
        }
    };

    // Status pill config keyed by the resolved state.
    let pill;
    if (!supported) {
        pill = { label: 'Unavailable', className: 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400' };
    } else if (isBlocked) {
        pill = { label: 'Blocked', className: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' };
    } else if (isEnabled) {
        pill = { label: 'Enabled', className: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' };
    } else {
        pill = { label: 'Off', className: 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300' };
    }

    return (
        <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
            <div className="flex items-start justify-between gap-4 mb-1">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Bell size={16} className="text-primary-600 dark:text-primary-400" />
                    Browser Notifications
                </h2>
                <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold', pill.className)}>
                    {pill.label}
                </span>
            </div>
            <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                Get alerted the moment a visitor wants to chat, even when the dashboard tab is in the background.
            </p>

            {!supported ? (
                <div className="flex items-start gap-3 rounded-xl bg-surface-50 dark:bg-surface-800/50 border border-surface-100 dark:border-surface-700 px-4 py-3">
                    <ShieldAlert size={16} className="text-surface-400 dark:text-surface-500 mt-0.5 shrink-0" />
                    <p className="text-sm text-surface-600 dark:text-surface-300">
                        This browser doesn&apos;t support web push notifications. Try a recent version of Chrome, Edge, or Firefox on desktop.
                    </p>
                </div>
            ) : initializing ? (
                <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2">
                    <Loader2 size={14} className="animate-spin" />
                    Checking notification status…
                </div>
            ) : isBlocked ? (
                <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-4 py-3">
                        <BellOff size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                                Notifications are blocked in your browser
                            </p>
                            <p className="text-sm text-amber-700 dark:text-amber-400 mt-1 leading-relaxed">
                                Click the lock icon next to the URL → Notifications → Allow, then click below.
                            </p>
                        </div>
                    </div>
                    {stillBlocked && (
                        <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                            Still blocked — set it to Allow via the lock icon, then click again (or reload).
                        </p>
                    )}
                    <button
                        type="button"
                        onClick={handleEnable}
                        disabled={busy}
                        className="inline-flex items-center gap-2 py-2.5 px-5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {busy ? <Loader2 size={15} className="animate-spin" /> : <Bell size={15} />}
                        Re-check permission
                    </button>
                </div>
            ) : isEnabled ? (
                <div className="space-y-4">
                    {error && (
                        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
                    )}
                    <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                        <Check size={15} />
                        You&apos;re subscribed on this device.
                    </div>
                    <button
                        type="button"
                        onClick={handleDisable}
                        disabled={busy}
                        className="inline-flex items-center gap-2 py-2.5 px-5 text-sm font-medium rounded-xl border border-surface-200 dark:border-surface-700 text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {busy ? <Loader2 size={15} className="animate-spin" /> : <BellOff size={15} />}
                        Turn off
                    </button>
                </div>
            ) : (
                <div className="space-y-4">
                    {error && (
                        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
                    )}
                    <button
                        type="button"
                        onClick={handleEnable}
                        disabled={busy}
                        className="inline-flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {busy ? <Loader2 size={15} className="animate-spin" /> : <Bell size={15} />}
                        {error ? 'Try again' : 'Enable notifications'}
                    </button>
                </div>
            )}
        </div>
    );
}
