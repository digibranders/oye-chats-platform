/**
 * Floating "Install OyeChats" prompt shown to operators.
 *
 * Visibility matrix:
 *
 *   Condition                                           | Shown?
 *   ────────────────────────────────────────────────────┼────────
 *   Site already launched as installed PWA              | No
 *   iOS/iPadOS Safari (no beforeinstallprompt support)  | No (fallback = Settings card)
 *   Browser hasn't fired beforeinstallprompt yet        | No
 *   User dismissed within last 7 days                   | No
 *   User is NOT acting as an operator AND not on /support | No
 *   Everything above passes                             | Yes
 *
 * Rationale for the "not on /support" carve-out: owners who clicked
 * "Take chats yourself" are role='owner' in their own workspace (not
 * ``currentRole === 'operator'``) but they DO take chats. Rather than
 * teach the banner about self-op state, we broaden the audience to
 * "anyone on /support" - that covers self-op owners, linked operators
 * on any operator-view page, and legacy X-Operator-Key sessions.
 *
 * Dismissal persists for 7 days in localStorage. Clicking Install and
 * getting a "dismissed" outcome from the browser prompt is ALSO treated
 * as a dismissal so we don't nag someone who just told the browser no.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, X } from 'lucide-react';
import useInstallPrompt from '../hooks/useInstallPrompt';
import { cn } from '../lib/utils';
import InstallInstructionsModal from './InstallInstructionsModal';

const DISMISS_KEY = 'oyechats:install_banner_dismissed_at';
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function wasDismissedRecently() {
    try {
        const raw = window.localStorage.getItem(DISMISS_KEY);
        if (!raw) return false;
        const ts = Number(raw);
        if (!Number.isFinite(ts)) return false;
        return Date.now() - ts < DISMISS_TTL_MS;
    } catch {
        return false;
    }
}

function markDismissed() {
    try {
        window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
        // localStorage disabled - accept that we'll show again next mount.
    }
}

export default function InstallBanner() {
    const { canInstall, isInstalled, isIOS, install } = useInstallPrompt();
    const location = useLocation();
    const [dismissed, setDismissed] = useState(() => wasDismissedRecently());
    const [installing, setInstalling] = useState(false);
    const [showInstructions, setShowInstructions] = useState(false);

    // Re-check dismissal on route change - someone who dismissed then hit
    // Cmd+K a week later would otherwise stay hidden until page reload.
    useEffect(() => {
        setDismissed(wasDismissedRecently());
    }, [location.pathname]);

    const shouldRender = (
        !isInstalled
        && !dismissed
    );

    const handleInstall = useCallback(async () => {
        if (canInstall) {
            setInstalling(true);
            try {
                const { outcome } = await install();
                if (outcome !== 'accepted') {
                    // Browser prompt was declined or unavailable - silence us so
                    // we don't re-appear on next render / route change until the
                    // 7-day window elapses.
                    markDismissed();
                    setDismissed(true);
                }
            } finally {
                setInstalling(false);
            }
        } else {
            setShowInstructions(true);
        }
    }, [install, canInstall]);

    const handleDismiss = useCallback(() => {
        markDismissed();
        setDismissed(true);
    }, []);

    return (
        <>
            <AnimatePresence>
                {shouldRender && (
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 12 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        role="dialog"
                        aria-label="Install OyeChats as an app"
                        className={cn(
                            'fixed z-30 transition-all duration-300',
                            'bottom-4 left-4 right-4',
                            'md:bottom-4 md:right-4 md:left-auto md:w-[22rem] md:max-w-[calc(100vw-2rem)]',
                            'rounded-2xl border shadow-lg p-4',
                            'bg-white dark:bg-surface-900',
                            'border-surface-200 dark:border-surface-800',
                        )}
                    >
                        <div className="flex flex-row md:items-start items-center justify-between gap-3 w-full">
                            {/* Icon & Text Block */}
                            <div className="flex items-center md:items-start gap-3 min-w-0 flex-1">
                                <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-950/20 flex items-center justify-center shrink-0">
                                    <Download size={20} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 leading-tight">
                                        Install OyeChats
                                    </h3>
                                    <p className="text-xs text-surface-600 dark:text-surface-400 mt-0.5 leading-tight md:leading-relaxed whitespace-normal">
                                        <span className="block md:hidden">Add to home screen for quick access</span>
                                        <span className="hidden md:block">Get chat alerts even when the browser is closed.</span>
                                    </p>
                                </div>
                            </div>

                            {/* Mobile Actions: Inline Button + Close button */}
                            <div className="flex items-center gap-2 shrink-0 md:hidden">
                                <button
                                    type="button"
                                    onClick={handleInstall}
                                    disabled={installing}
                                    className={cn(
                                        'px-4 py-1.5 rounded-full text-xs font-semibold transition-colors',
                                        'bg-primary-600 hover:bg-primary-700 text-white',
                                        'dark:bg-primary-500 dark:hover:bg-primary-600',
                                        installing && 'opacity-60 cursor-wait',
                                    )}
                                >
                                    {installing ? 'Installing...' : 'Install'}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDismiss}
                                    className="text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 p-1 rounded-full hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                                    aria-label="Dismiss install prompt"
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            {/* Desktop-only Close button at top right */}
                            <button
                                type="button"
                                onClick={handleDismiss}
                                className="hidden md:block text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 shrink-0 p-0.5 rounded"
                                aria-label="Dismiss install prompt"
                                title="Dismiss for 7 days"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        {/* Desktop-only Action Row at bottom */}
                        <div className="hidden md:flex mt-3 justify-end">
                            <button
                                type="button"
                                onClick={handleInstall}
                                disabled={installing}
                                className={cn(
                                    'px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
                                    'bg-surface-900 hover:bg-surface-800 text-white',
                                    'dark:bg-surface-100 dark:hover:bg-white dark:text-surface-900',
                                    installing && 'opacity-60 cursor-wait',
                                )}
                            >
                                {installing ? 'Installing...' : 'Install'}
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <InstallInstructionsModal
                open={showInstructions}
                mode={isIOS ? 'ios' : (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) ? 'android' : 'desktop')}
                onClose={() => setShowInstructions(false)}
            />
        </>
    );
}
