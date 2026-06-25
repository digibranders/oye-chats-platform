import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, Sparkles, ArrowRight, Check, Crown, X } from 'lucide-react';
import useEntitlements from '../hooks/useEntitlements';
import { cn } from '../lib/utils';

/**
 * UpgradeModal — the single premium upsell surface used by every gate.
 *
 * Driven by `payload` from <UpgradeModalProvider />. When non-null we render
 * the dialog; when null we render nothing (AnimatePresence handles the
 * exit). All copy comes from the payload so the modal stays presentational
 * — wording lives in the intent registry in `UpgradeModalContext`.
 *
 * Design notes:
 *  - Frosted backdrop + glow halo to feel like a "moment" rather than a toast.
 *  - Crown icon with a slow-pulsing halo + three floating sparkles to telegraph
 *    "premium" without resorting to "PRO" badges.
 *  - Current → recommended plan chip so the customer immediately understands
 *    the transition they're being asked to make.
 *  - Highlights stagger in (40-50ms) to direct the eye down the list, then to
 *    the primary CTA which gets a horizontal sheen on hover.
 *  - Esc / backdrop click / X button / "Maybe later" all dismiss; primary CTA
 *    dismisses + navigates to /billing in a single click.
 */
export default function UpgradeModal({ payload, onClose }) {
    const navigate = useNavigate();
    const { entitlements } = useEntitlements();
    const dialogRef = useRef(null);

    // Restore focus to the trigger when the modal closes. Without this,
    // keyboard users dismissing the modal land at the top of <body>, losing
    // the context of what they were doing.
    useEffect(() => {
        if (!payload) return undefined;
        const previous = document.activeElement;
        dialogRef.current?.focus();
        return () => {
            if (previous && typeof previous.focus === 'function') {
                previous.focus();
            }
        };
    }, [payload]);

    // Lock body scroll while the modal is open so backgrounds don't shift
    // behind the dialog when the user scrolls inside it.
    useEffect(() => {
        if (!payload) return undefined;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [payload]);

    const handleViewPlans = () => {
        onClose();
        navigate('/billing');
    };

    return (
        <AnimatePresence>
            {payload && (
                <motion.div
                    key="upgrade-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="fixed inset-0 z-[200] flex items-center justify-center px-4 py-6"
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    {/* Frosted backdrop */}
                    <div className="absolute inset-0 bg-surface-950/60 dark:bg-black/70 backdrop-blur-md" />

                    {/* Soft colour halo behind the card so it lifts off the page */}
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <div className="w-[640px] h-[640px] rounded-full bg-gradient-to-br from-primary-500/30 to-primary-700/20 blur-[120px] opacity-70" />
                    </div>

                    <motion.div
                        key="upgrade-dialog"
                        ref={dialogRef}
                        tabIndex={-1}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="upgrade-modal-title"
                        aria-describedby={payload?.description ? 'upgrade-modal-desc' : undefined}
                        initial={{ opacity: 0, scale: 0.94, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{ type: 'spring', stiffness: 360, damping: 28 }}
                        className={cn(
                            'relative w-full max-w-lg outline-none',
                            'rounded-3xl overflow-hidden',
                            'shadow-2xl shadow-primary-900/30',
                        )}
                    >
                        {/* Animated gradient border — sits in a 1.5px padded
                            outer layer so the inner surface stays a clean
                            opaque card while the perimeter glows. */}
                        <div className="absolute inset-0 rounded-3xl p-[1.5px]">
                            <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-primary-500/80 to-primary-700/70" />
                        </div>

                        <div className="relative rounded-[calc(theme(borderRadius.3xl)-1.5px)] bg-white dark:bg-surface-950">
                            {/* Close button */}
                            <button
                                type="button"
                                onClick={onClose}
                                className="absolute top-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-100/80 dark:bg-surface-800/80 text-surface-500 dark:text-surface-400 transition-colors hover:bg-surface-200 dark:hover:bg-surface-700 hover:text-surface-900 dark:hover:text-surface-100"
                                aria-label="Close upgrade dialog"
                            >
                                <X size={16} />
                            </button>

                            {/* Hero — animated crown + sparkles */}
                            <div className="relative px-6 pt-9 pb-5 text-center">
                                <div className="relative mx-auto mb-5 w-16 h-16">
                                    <motion.div
                                        className="absolute inset-[-14px] rounded-full bg-gradient-to-br from-primary-500/40 to-primary-700/25 blur-xl"
                                        animate={{ scale: [1, 1.08, 1], opacity: [0.6, 0.85, 0.6] }}
                                        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                                    />
                                    <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lg shadow-primary-500/40">
                                        <Crown size={28} strokeWidth={2.2} />
                                    </div>
                                    {/* Drifting sparkles — staggered offsets and
                                        durations so they don't visibly loop in
                                        sync. */}
                                    {SPARKLE_POSITIONS.map((pos, i) => (
                                        <motion.div
                                            key={i}
                                            className="absolute"
                                            style={{ top: pos.top, left: pos.left }}
                                            animate={{ y: [0, -6, 0], opacity: [0.35, 1, 0.35] }}
                                            transition={{
                                                duration: 2.2 + i * 0.25,
                                                repeat: Infinity,
                                                delay: i * 0.4,
                                                ease: 'easeInOut',
                                            }}
                                        >
                                            <Sparkles
                                                size={pos.size}
                                                className="text-primary-400 dark:text-primary-300"
                                                strokeWidth={2.5}
                                            />
                                        </motion.div>
                                    ))}
                                </div>

                                {payload.eyebrow && (
                                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-600 dark:text-primary-400">
                                        {payload.eyebrow}
                                    </p>
                                )}
                                <h2
                                    id="upgrade-modal-title"
                                    className="text-[22px] font-bold leading-tight text-surface-900 dark:text-surface-50"
                                >
                                    {payload.title || 'Upgrade your plan'}
                                </h2>
                                {payload.description && (
                                    <p
                                        id="upgrade-modal-desc"
                                        className="mx-auto mt-2.5 max-w-md text-[13.5px] leading-relaxed text-surface-600 dark:text-surface-400"
                                    >
                                        {payload.description}
                                    </p>
                                )}
                            </div>

                            {/* Plan transition chip — only when a recommended
                                plan is given. Visually anchors the "from →
                                to" the user is being asked to take. */}
                            {payload.recommendedPlan && (
                                <div className="px-6 pb-5">
                                    <div className="mx-auto flex w-fit items-center gap-2.5 rounded-2xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-200/60 dark:bg-surface-800 px-2.5 py-1 text-[11px] font-semibold text-surface-600 dark:text-surface-400">
                                            <Lock size={10} strokeWidth={2.5} />
                                            {entitlements.planName || 'Free'}
                                        </span>
                                        <ArrowRight
                                            size={13}
                                            className="text-surface-400 dark:text-surface-500"
                                        />
                                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm">
                                            <Crown size={10} strokeWidth={2.8} />
                                            {payload.recommendedPlan}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {/* Highlights — what you get if you upgrade */}
                            {payload.highlights?.length > 0 && (
                                <div className="px-6 pb-6">
                                    <ul className="space-y-2.5">
                                        {payload.highlights.map((line, i) => (
                                            <motion.li
                                                key={line}
                                                initial={{ opacity: 0, x: -6 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                transition={{ delay: 0.1 + i * 0.05, duration: 0.25 }}
                                                className="flex items-start gap-2.5 text-[13px] text-surface-700 dark:text-surface-300"
                                            >
                                                <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400">
                                                    <Check size={10} strokeWidth={3} />
                                                </span>
                                                <span>{line}</span>
                                            </motion.li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* CTAs — single path now that bot seats are
                                gone. "See plans" always routes to /billing
                                where the user can subscribe (or, for the
                                add_bot intent, mint a second per-bot sub). */}
                            <div className="flex flex-col-reverse gap-2.5 px-6 pb-6 sm:flex-row">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="flex-1 rounded-xl px-4 py-2.5 text-[13px] font-medium text-surface-600 transition-colors hover:bg-surface-100 dark:text-surface-400 dark:hover:bg-surface-800 sm:flex-none"
                                >
                                    Maybe later
                                </button>
                                <button
                                    type="button"
                                    onClick={handleViewPlans}
                                    className={cn(
                                        'group relative inline-flex flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-2.5',
                                        'bg-gradient-to-br from-primary-500 to-primary-700 text-[13.5px] font-semibold text-white',
                                        'shadow-lg shadow-primary-500/30 transition-shadow hover:shadow-primary-500/60',
                                    )}
                                >
                                    <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-white/0 via-white/30 to-white/0 transition-transform duration-700 group-hover:translate-x-full" />
                                    <span className="relative z-10">See plans &amp; upgrade</span>
                                    <ArrowRight
                                        size={14}
                                        className="relative z-10 transition-transform group-hover:translate-x-0.5"
                                    />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

// Sparkle anchor points around the crown. Hand-placed so they hug the icon
// without overlapping; defining them as a constant keeps the JSX scannable.
const SPARKLE_POSITIONS = [
    { top: '-10px', left: '-14px', size: 10 },
    { top: '8px', left: '60px', size: 8 },
    { top: '34px', left: '-6px', size: 12 },
];
