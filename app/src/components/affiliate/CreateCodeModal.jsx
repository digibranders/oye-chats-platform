import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, Link as LinkIcon, Sparkles } from 'lucide-react';
import { createAffiliateCode } from '../../services/api';
import { cn } from '../../lib/utils';

// Mirror of the DB-level CHECK constraint and the backend regex in
// app/services/affiliate_service.py. Fail fast in the browser to save a
// round-trip on obviously-malformed input.
const CODE_REGEX = /^[A-Za-z0-9_-]{3,20}$/;

// Landing-site origin used to render the live referral-link preview.
// Falls back to https://oyechats.com so the preview is meaningful even on
// localhost.
const LANDING_ORIGIN = import.meta.env.VITE_LANDING_URL || 'https://oyechats.com';

/**
 * Modal for creating a new referral code.
 *
 * Validates the code format client-side, posts to the backend, and hands
 * the created row back to the parent via ``onCreated`` so the parent's
 * codes table can prepend the new row without a full refetch. Failure
 * paths surface the backend's human-readable error (e.g. "Code 'X' is
 * already in use." or "You have 10 active codes…").
 */
export default function CreateCodeModal({ open, onClose, onCreated, poolPct = 0 }) {
    const [code, setCode] = useState('');
    const [myCommission, setMyCommission] = useState('');
    const [friendReward, setFriendReward] = useState('');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const inputRef = useRef(null);

    // Auto-focus the code input every time the modal opens, and reset
    // form state when the modal closes so the next open starts clean.
    useEffect(() => {
        if (open) {
            setCode('');
            setMyCommission('');
            setFriendReward('');
            setError('');
            // Focus after the framer-motion entrance animation settles.
            const t = setTimeout(() => inputRef.current?.focus(), 80);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [open]);

    // ESC closes — matches the existing modal pattern across the admin app.
    useEffect(() => {
        if (!open) return undefined;
        const handler = (e) => {
            if (e.key === 'Escape' && !isSaving) onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, isSaving, onClose]);

    const formatValid = CODE_REGEX.test(code);
    const previewUrl = formatValid
        ? `${LANDING_ORIGIN.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}`
        : null;

    // Split validation against the pool the super-admin set.
    const myNum = myCommission === '' ? 0 : Number(myCommission);
    const rewardNum = friendReward === '' ? 0 : Number(friendReward);
    const splitTotal = (Number.isFinite(myNum) ? myNum : 0) + (Number.isFinite(rewardNum) ? rewardNum : 0);
    const splitOverPool = splitTotal > poolPct;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!formatValid) {
            setError("Code must be 3–20 characters of letters, digits, '_' or '-'.");
            return;
        }
        if (myCommission !== '' && (!Number.isFinite(myNum) || myNum < 0 || myNum > 100)) {
            setError('My commission must be between 0 and 100.');
            return;
        }
        if (friendReward !== '' && (!Number.isFinite(rewardNum) || rewardNum < 0 || rewardNum > 100)) {
            setError("Friend's reward must be between 0 and 100.");
            return;
        }
        if (splitOverPool) {
            setError(`Split (${splitTotal}%) exceeds your pool (${poolPct}%).`);
            return;
        }
        try {
            setIsSaving(true);
            const created = await createAffiliateCode(
                code.trim(),
                null,  // label removed from UI; backend still accepts it
                {
                    affiliateCommissionPct: myCommission === '' ? null : myNum,
                    customerDiscountPct: friendReward === '' ? null : rewardNum,
                },
            );
            onCreated?.(created);
            onClose();
        } catch (err) {
            setError(err?.message || 'Failed to create code.');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <AnimatePresence>
            {open && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="create-code-title"
                >
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="absolute inset-0 bg-black/40 dark:bg-black/60"
                        onClick={() => !isSaving && onClose()}
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 14, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 14, scale: 0.98 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="relative w-full max-w-md bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-800"
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between p-5 border-b border-surface-200 dark:border-surface-800">
                            <div className="flex items-start gap-3">
                                <div className="w-9 h-9 rounded-xl bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center shrink-0">
                                    <Sparkles size={16} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h2
                                        id="create-code-title"
                                        className="text-[16px] font-bold text-surface-900 dark:text-surface-50"
                                    >
                                        Create referral code
                                    </h2>
                                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-0.5">
                                        Pick a memorable code — visitors will use it as <code className="font-mono">?ref=YOURCODE</code>.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => !isSaving && onClose()}
                                aria-label="Close"
                                className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300 disabled:opacity-50"
                                disabled={isSaving}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Form */}
                        <form onSubmit={handleSubmit} className="p-5 space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                                    Code
                                </label>
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                    placeholder="e.g. PRIYA20"
                                    maxLength={20}
                                    className={cn(
                                        'w-full h-10 px-3 text-sm font-mono uppercase tracking-wider',
                                        'bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                                        'border rounded-lg outline-none transition-colors',
                                        'placeholder:normal-case placeholder:tracking-normal placeholder:font-sans',
                                        code.length === 0
                                            ? 'border-surface-200 dark:border-surface-700 focus:border-primary-400'
                                            : formatValid
                                                ? 'border-emerald-400/60 focus:border-emerald-500 dark:border-emerald-500/40'
                                                : 'border-rose-400/60 focus:border-rose-500 dark:border-rose-500/40'
                                    )}
                                    disabled={isSaving}
                                />
                                <p className="text-[11px] text-surface-500 dark:text-surface-400">
                                    3–20 characters · letters, digits, hyphens, underscores · case-insensitive
                                </p>
                            </div>

                            {/* Commission split. Both inputs share the affiliate's pool
                                (set by super-admin). Live-validated against poolPct so
                                the user can't submit an over-budget split. */}
                            <div className="space-y-2">
                                <div className="flex items-baseline justify-between">
                                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                                        Split <span className="text-surface-400 font-normal">(optional)</span>
                                    </label>
                                    <span
                                        className={cn(
                                            'text-[11px] tabular-nums',
                                            splitOverPool
                                                ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                                : 'text-surface-500 dark:text-surface-400',
                                        )}
                                    >
                                        Pool used: {splitTotal}% / {poolPct}%
                                    </span>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <label className="text-[11px] font-medium text-surface-600 dark:text-surface-400">
                                            My commission
                                        </label>
                                        <div className="relative">
                                            <input
                                                type="number"
                                                min="0"
                                                max="100"
                                                step="0.01"
                                                value={myCommission}
                                                onChange={(e) => setMyCommission(e.target.value)}
                                                placeholder="0"
                                                className={cn(
                                                    'w-full h-10 pl-3 pr-8 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border rounded-lg outline-none transition-colors',
                                                    splitOverPool
                                                        ? 'border-rose-400/60 focus:border-rose-500'
                                                        : 'border-surface-200 dark:border-surface-700 focus:border-primary-400',
                                                )}
                                                disabled={isSaving}
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-surface-400 pointer-events-none">%</span>
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[11px] font-medium text-surface-600 dark:text-surface-400">
                                            Friend&apos;s reward
                                        </label>
                                        <div className="relative">
                                            <input
                                                type="number"
                                                min="0"
                                                max="100"
                                                step="0.01"
                                                value={friendReward}
                                                onChange={(e) => setFriendReward(e.target.value)}
                                                placeholder="0"
                                                className={cn(
                                                    'w-full h-10 pl-3 pr-8 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border rounded-lg outline-none transition-colors',
                                                    splitOverPool
                                                        ? 'border-rose-400/60 focus:border-rose-500'
                                                        : 'border-surface-200 dark:border-surface-700 focus:border-primary-400',
                                                )}
                                                disabled={isSaving}
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-surface-400 pointer-events-none">%</span>
                                        </div>
                                    </div>
                                </div>
                                <p className="text-[11px] text-surface-500 dark:text-surface-400">
                                    Both must sum to ≤ your pool ({poolPct}%).
                                </p>
                            </div>

                            {previewUrl && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-50 dark:bg-surface-800/60 border border-surface-200 dark:border-surface-700"
                                >
                                    <LinkIcon size={13} className="text-surface-400 shrink-0" />
                                    <code className="text-[12px] font-mono text-surface-700 dark:text-surface-300 truncate">
                                        {previewUrl}
                                    </code>
                                </motion.div>
                            )}

                            {error && (
                                <div
                                    role="alert"
                                    className="px-3 py-2.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[13px]"
                                >
                                    {error}
                                </div>
                            )}

                            <div className="flex items-center justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => !isSaving && onClose()}
                                    disabled={isSaving}
                                    className="px-4 h-9 text-sm font-medium text-surface-700 dark:text-surface-300 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isSaving || !formatValid || splitOverPool}
                                    className="inline-flex items-center gap-2 px-4 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                                    Create code
                                </button>
                            </div>
                        </form>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
