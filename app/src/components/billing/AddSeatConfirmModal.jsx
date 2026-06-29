import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Minus, Loader2, X, Smartphone, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';

/**
 * Confirmation step before adding or removing an operator seat.
 *
 * The backend ``POST /subscriptions/seats`` route dispatches to Razorpay
 * based on ``Subscription.payment_provider``. The modal surfaces:
 *   • Net effect on seat count.
 *   • The per-seat price in USD.
 *   • A clear CTA + cancel.
 *
 * When ``hasSubscription`` is false (Free plan), renders an upgrade CTA.
 */
export default function AddSeatConfirmModal({
    open,
    onClose,
    delta,
    seatPriceCents,
    currentSeatCount,
    includedSeats,
    hasSubscription,
    onConfirm, // async () => void
    onUpgradeClick, // () => void  (shown when !hasSubscription)
}) {
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);

    const isAdd = delta > 0;
    const newTotal = currentSeatCount + delta;
    const seatPriceDisplay = formatMoney(seatPriceCents);

    async function handleConfirm() {
        setSubmitting(true);
        setError(null);
        try {
            await onConfirm();
            onClose();
        } catch (err) {
            setError(err?.message || err?.detail || 'Could not update seats.');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AnimatePresence>
            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm"
                        onClick={() => !submitting && onClose()}
                    />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.96, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{ type: 'spring', stiffness: 280, damping: 28 }}
                        className="relative w-full max-w-md bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-800"
                    >
                        <button
                            type="button"
                            onClick={() => !submitting && onClose()}
                            className="absolute top-3 right-3 p-1.5 rounded-lg text-surface-400 hover:text-surface-700 hover:bg-surface-100 dark:hover:text-surface-200 dark:hover:bg-surface-800 transition-colors"
                            aria-label="Close"
                        >
                            <X className="w-4 h-4" />
                        </button>

                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-1">
                                <div
                                    className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                                        isAdd
                                            ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-300'
                                            : 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-300'
                                    }`}
                                >
                                    {isAdd ? <Plus className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                                </div>
                                <h2 className="text-lg font-semibold text-surface-900 dark:text-white">
                                    {isAdd ? 'Add an operator seat' : 'Remove an operator seat'}
                                </h2>
                            </div>
                            <p className="text-sm text-surface-500 dark:text-surface-400 ml-12">
                                {`You'll go from ${currentSeatCount} to ${newTotal} seats.`}
                            </p>

                            {hasSubscription ? (
                                <>
                                    <div className="mt-5 rounded-xl border border-surface-200 dark:border-surface-700 divide-y divide-surface-200 dark:divide-surface-700">
                                        <div className="flex items-center justify-between px-4 py-3">
                                            <span className="text-sm text-surface-600 dark:text-surface-300">
                                                Per-seat price
                                            </span>
                                            <span className="text-sm font-medium text-surface-900 dark:text-white">
                                                {seatPriceDisplay} / month
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between px-4 py-3">
                                            <span className="text-sm text-surface-600 dark:text-surface-300">
                                                {isAdd ? 'New billable extras' : 'Remaining billable extras'}
                                            </span>
                                            <span className="text-sm font-medium text-surface-900 dark:text-white">
                                                {Math.max(newTotal - includedSeats, 0)} seat
                                                {Math.max(newTotal - includedSeats, 0) === 1 ? '' : 's'}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between px-4 py-3 bg-surface-50 dark:bg-surface-800/40 rounded-b-xl">
                                            <span className="text-sm text-surface-600 dark:text-surface-300">
                                                Charged via
                                            </span>
                                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-500/30">
                                                <Smartphone className="w-3 h-3" />
                                                Razorpay
                                            </span>
                                        </div>
                                    </div>

                                    <p className="mt-3 text-xs text-surface-500 dark:text-surface-400">
                                        {isAdd
                                            ? `Your Razorpay subscription will be updated immediately. The next invoice picks up the new seat amount — Razorpay handles proration automatically.`
                                            : `The removed seat stops billing at the end of the current period. The operator keeps access until then.`}
                                    </p>

                                    {error && (
                                        <div className="mt-3 rounded-lg border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                            {error}
                                        </div>
                                    )}

                                    <div className="mt-5 flex items-center justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={() => !submitting && onClose()}
                                            disabled={submitting}
                                            className="px-3 py-2 rounded-lg text-sm font-medium text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-50 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleConfirm}
                                            disabled={submitting}
                                            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-sm transition-colors flex items-center gap-2 disabled:opacity-70 ${
                                                isAdd
                                                    ? 'bg-primary-600 hover:bg-primary-700'
                                                    : 'bg-rose-600 hover:bg-rose-700'
                                            }`}
                                        >
                                            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                            {isAdd
                                                ? `Add seat — ${seatPriceDisplay}/mo`
                                                : `Remove seat`}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="mt-5 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
                                        <p className="text-sm text-amber-900 dark:text-amber-200">
                                            You're on the Free plan. Extra operator seats need an active paid
                                            subscription.
                                        </p>
                                    </div>
                                    <div className="mt-5 flex items-center justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="px-3 py-2 rounded-lg text-sm font-medium text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                onClose();
                                                onUpgradeClick?.();
                                            }}
                                            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 shadow-sm flex items-center gap-2"
                                        >
                                            Choose a plan
                                            <ArrowUpRight className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}

function formatMoney(amountMinor) {
    const major = (Number(amountMinor) || 0) / 100;
    return `$${Number.isInteger(major) ? major.toLocaleString() : major.toFixed(2)}`;
}
