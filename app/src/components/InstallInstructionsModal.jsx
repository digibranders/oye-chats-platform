import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Share, Plus, X, Smartphone, MoreVertical, MonitorSmartphone } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * InstallInstructionsModal — fallback walkthrough shown from the "Install as
 * app" CTA whenever the browser hasn't fired ``beforeinstallprompt`` and we
 * can't drive a programmatic install.
 *
 * Two variants, keyed by ``mode``:
 *   • ``ios``     — Safari Share → Add to Home Screen (Apple never fires
 *                    beforeinstallprompt, so this is the ONLY install path).
 *   • ``desktop`` — Chrome/Edge overflow menu → "Install OyeChats". Firefox
 *                    doesn't support PWA install on desktop so we mention it
 *                    as a fallback for parity with reality.
 *
 * Closes on Esc, backdrop click, and the X button. Locks body scroll while
 * open and restores focus to the trigger on close so keyboard users don't
 * lose their place.
 */
export default function InstallInstructionsModal({ open, mode, onClose }) {
    const dialogRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const previous = document.activeElement;
        dialogRef.current?.focus();
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        function onKey(e) {
            if (e.key === 'Escape') onClose();
        }
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', onKey);
            if (previous && typeof previous.focus === 'function') {
                previous.focus();
            }
        };
    }, [open, onClose]);

    const isIOS = mode === 'ios';
    const heroIcon = isIOS ? <Smartphone size={26} strokeWidth={2.2} /> : <MonitorSmartphone size={26} strokeWidth={2.2} />;
    const title = isIOS ? 'Install OyeChats on iOS' : 'Install OyeChats on desktop';
    const subtitle = isIOS
        ? "Safari doesn't offer a one-tap install button — follow these two steps."
        : "Your browser hasn't offered a one-tap install yet. Use its menu to add OyeChats as an app.";

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    key="install-modal-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="fixed inset-0 z-[200] flex items-center justify-center px-4 py-6"
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    <div className="absolute inset-0 bg-surface-950/60 dark:bg-black/70 backdrop-blur-md" />

                    <motion.div
                        key="install-modal-dialog"
                        ref={dialogRef}
                        tabIndex={-1}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="install-modal-title"
                        initial={{ opacity: 0, scale: 0.94, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{ type: 'spring', stiffness: 360, damping: 28 }}
                        className={cn(
                            'relative w-full max-w-md outline-none rounded-3xl overflow-hidden shadow-2xl',
                            'bg-white dark:bg-surface-950 border border-surface-200 dark:border-surface-800',
                        )}
                    >
                        <button
                            type="button"
                            onClick={onClose}
                            className="absolute top-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-100/80 dark:bg-surface-800/80 text-surface-500 dark:text-surface-400 transition-colors hover:bg-surface-200 dark:hover:bg-surface-700 hover:text-surface-900 dark:hover:text-surface-100"
                            aria-label="Close install instructions"
                        >
                            <X size={16} />
                        </button>

                        <div className="px-6 pt-8 pb-2 text-center">
                            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lg shadow-primary-500/30">
                                {heroIcon}
                            </div>
                            <h2
                                id="install-modal-title"
                                className="text-[20px] font-bold leading-tight text-surface-900 dark:text-surface-50"
                            >
                                {title}
                            </h2>
                            <p className="mt-1.5 text-sm text-surface-600 dark:text-surface-400">
                                {subtitle}
                            </p>
                        </div>

                        <div className="px-6 pt-4 pb-6 space-y-3">
                            {isIOS ? (
                                <>
                                    <Step
                                        index={1}
                                        icon={<Share size={16} strokeWidth={2.2} />}
                                        title="Tap the Share icon"
                                        body="It's the square with an upward arrow in the Safari toolbar (bottom on iPhone, top on iPad)."
                                    />
                                    <Step
                                        index={2}
                                        icon={<Plus size={16} strokeWidth={2.2} />}
                                        title="Choose 'Add to Home Screen'"
                                        body="Scroll the share sheet until you see it, then tap Add. OyeChats will launch like a native app."
                                    />
                                    <Note>
                                        Add to Home Screen only works from Safari on iOS — not Chrome, Firefox, or in-app browsers.
                                    </Note>
                                </>
                            ) : (
                                <>
                                    <Step
                                        index={1}
                                        icon={<MoreVertical size={16} strokeWidth={2.2} />}
                                        title="Open the browser menu"
                                        body="Click the ⋯ (three dots) icon in the top-right corner of Chrome or Edge."
                                    />
                                    <Step
                                        index={2}
                                        icon={<MonitorSmartphone size={16} strokeWidth={2.2} />}
                                        title="Choose 'Install OyeChats'"
                                        body="If you don't see it right away, look under 'Cast, save and share' or 'Apps'. OyeChats launches like a native app after install."
                                    />
                                    <Note>
                                        Firefox on desktop doesn&apos;t support PWA installs — use Chrome, Edge, or Brave for the one-click experience.
                                    </Note>
                                </>
                            )}
                        </div>

                        <div className="px-6 pb-6 flex justify-end">
                            <button
                                type="button"
                                onClick={onClose}
                                className={cn(
                                    'px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                                    'bg-surface-900 hover:bg-surface-800 text-white',
                                    'dark:bg-surface-100 dark:hover:bg-white dark:text-surface-900',
                                )}
                            >
                                Got it
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

function Step({ index, icon, title, body }) {
    return (
        <div className="flex items-start gap-3 rounded-xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 px-4 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-500/15 text-primary-700 dark:text-primary-300">
                {icon}
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                        Step {index}
                    </span>
                </div>
                <p className="mt-0.5 text-sm font-semibold text-surface-900 dark:text-surface-100">
                    {title}
                </p>
                <p className="mt-0.5 text-xs text-surface-600 dark:text-surface-400 leading-relaxed">
                    {body}
                </p>
            </div>
        </div>
    );
}

function Note({ children }) {
    return (
        <div className="mt-4 rounded-xl bg-surface-50 dark:bg-surface-800/50 border border-surface-100 dark:border-surface-700 px-4 py-3">
            <p className="text-xs text-surface-600 dark:text-surface-300 leading-relaxed">
                <span className="font-semibold text-surface-900 dark:text-surface-100">Heads up:</span>{' '}
                {children}
            </p>
        </div>
    );
}
