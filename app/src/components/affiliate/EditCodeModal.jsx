import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, Tag, Pencil, AlertTriangle, Copy, Check } from 'lucide-react';
import { updateAffiliateCode } from '../../services/api';
import { cn } from '../../lib/utils';

// Same regex as the backend CHECK constraint + create flow.
const CODE_REGEX = /^[A-Za-z0-9_-]{3,20}$/;

/**
 * Modal for editing an existing referral code.
 *
 * Mirrors ``CreateCodeModal`` but pre-fills both fields and submits a
 * PATCH instead of POST. The headline behavior we surface here:
 *
 *   - Renaming the code string is allowed (backend accepts it), but
 *     destructive in effect — anyone who saved the OLD code stops being
 *     attributed. We render a prominent amber warning whenever the code
 *     field is edited away from its original value.
 *
 *   - Reward/commission edits are non-destructive; no warning.
 *
 * Returns the updated code (with fresh stats) to the parent via ``onUpdated``
 * so the codes table can replace the row in place without a full refetch.
 */
export default function EditCodeModal({ open, code, onClose, onUpdated, poolPct = 0 }) {
    const [codeName, setCodeName] = useState('');
    const [myCommission, setMyCommission] = useState('');
    const [friendReward, setFriendReward] = useState('');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    // Brief "Copied" confirmation flash on the preview URL. Boolean +
    // setTimeout — a fresh click resets the 1.5s window.
    const [copied, setCopied] = useState(false);
    const inputRef = useRef(null);

    // Re-seed state whenever the modal opens for a different code.
    useEffect(() => {
        if (open && code) {
            setCodeName(code.code || '');
            setMyCommission(
                code.affiliate_commission_pct != null
                    ? String(code.affiliate_commission_pct)
                    : '0',
            );
            setFriendReward(
                code.customer_discount_pct != null
                    ? String(code.customer_discount_pct)
                    : '0',
            );
            setError('');
            const t = setTimeout(() => inputRef.current?.focus(), 80);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [open, code]);

    // ESC to close — matches the existing modal pattern.
    useEffect(() => {
        if (!open) return undefined;
        const handler = (e) => {
            if (e.key === 'Escape' && !isSaving) onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, isSaving, onClose]);

    if (!code) return null;

    const originalCode = code.code || '';
    const originalMy = code.affiliate_commission_pct ?? 0;
    const originalReward = code.customer_discount_pct ?? 0;
    const codeChanged = codeName.trim().toLowerCase() !== originalCode.toLowerCase();

    const myNum = myCommission === '' ? 0 : Number(myCommission);
    const rewardNum = friendReward === '' ? 0 : Number(friendReward);
    const splitTotal = (Number.isFinite(myNum) ? myNum : 0) + (Number.isFinite(rewardNum) ? rewardNum : 0);
    const splitOverPool = splitTotal > poolPct;
    const myChanged = myNum !== originalMy;
    const rewardChanged = rewardNum !== originalReward;

    const formatValid = CODE_REGEX.test(codeName.trim());
    const previewCode = formatValid ? codeName.trim().toUpperCase() : null;
    const hasChanges = codeChanged || myChanged || rewardChanged;

    /**
     * Copy the code to the clipboard with a graceful fallback for non-https
     * origins (Safari & some embedded webviews block the Clipboard API
     * there). The fallback uses an off-screen textarea + execCommand —
     * deprecated but universally supported.
     */
    const handleCopy = async () => {
        if (!previewCode) return;
        try {
            await navigator.clipboard.writeText(previewCode);
        } catch {
            const ta = document.createElement('textarea');
            ta.value = previewCode;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
            } catch {
                /* swallow — last-resort failure */
            }
            document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (codeChanged && !formatValid) {
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
        if (!hasChanges) {
            onClose();
            return;
        }
        try {
            setIsSaving(true);
            // Build a minimal patch — only changed fields go on the wire.
            const patch = {};
            if (codeChanged) patch.code = codeName.trim();
            if (myChanged) patch.affiliateCommissionPct = myNum;
            if (rewardChanged) patch.customerDiscountPct = rewardNum;
            const updated = await updateAffiliateCode(code.id, patch);
            onUpdated?.(updated);
            onClose();
        } catch (err) {
            setError(err?.message || 'Failed to update code.');
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
                    aria-labelledby="edit-code-title"
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
                        <div className="flex items-start justify-between p-5 border-b border-surface-200 dark:border-surface-800">
                            <div className="flex items-start gap-3">
                                <div className="w-9 h-9 rounded-xl bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center shrink-0">
                                    <Pencil size={16} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h2
                                        id="edit-code-title"
                                        className="text-[16px] font-bold text-surface-900 dark:text-surface-50"
                                    >
                                        Edit referral code
                                    </h2>
                                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-0.5">
                                        Update the code or its internal label.
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

                        <form onSubmit={handleSubmit} className="p-5 space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                                    Code
                                </label>
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={codeName}
                                    onChange={(e) => setCodeName(e.target.value)}
                                    maxLength={20}
                                    className={cn(
                                        'w-full h-10 px-3 text-sm font-mono uppercase tracking-wider',
                                        'bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                                        'border rounded-lg outline-none transition-colors',
                                        codeName.length === 0 || !codeChanged
                                            ? 'border-surface-200 dark:border-surface-700 focus:border-primary-400'
                                            : formatValid
                                                ? 'border-amber-400/60 focus:border-amber-500 dark:border-amber-500/40'
                                                : 'border-rose-400/60 focus:border-rose-500 dark:border-rose-500/40',
                                    )}
                                    disabled={isSaving}
                                />
                                <p className="text-[11px] text-surface-500 dark:text-surface-400">
                                    3–20 characters · letters, digits, hyphens, underscores · case-insensitive
                                </p>
                            </div>

                            {codeChanged && (
                                <motion.div
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    role="alert"
                                    className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-amber-800 dark:text-amber-200"
                                >
                                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                                    <div className="text-[12px] leading-relaxed">
                                        <strong className="font-semibold">Renaming retires the old code.</strong>{' '}
                                        Anyone who tries{' '}
                                        <code className="font-mono uppercase">{originalCode}</code> at checkout
                                        will see &quot;code not found&quot; and won&apos;t be attributed to you.
                                        Existing referrals you&apos;ve already brought in stay attributed.
                                    </div>
                                </motion.div>
                            )}

                            {/* Per-code split, validated live against the affiliate's pool. */}
                            <div className="space-y-2">
                                <div className="flex items-baseline justify-between">
                                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                                        Split
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

                            {previewCode && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-50 dark:bg-surface-800/60 border border-surface-200 dark:border-surface-700"
                                >
                                    <Tag size={13} className="text-surface-400 shrink-0" />
                                    <code className="flex-1 text-[12px] font-mono font-semibold uppercase tracking-wider text-surface-900 dark:text-surface-100 truncate">
                                        {previewCode}
                                    </code>
                                    <button
                                        type="button"
                                        onClick={handleCopy}
                                        aria-label={copied ? 'Copied' : 'Copy referral code'}
                                        title={copied ? 'Copied' : 'Copy referral code'}
                                        className={cn(
                                            'shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors',
                                            copied
                                                ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15'
                                                : 'text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700',
                                        )}
                                    >
                                        {copied ? <Check size={13} /> : <Copy size={13} />}
                                    </button>
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
                                    disabled={
                                        isSaving
                                        || !hasChanges
                                        || (codeChanged && !formatValid)
                                        || splitOverPool
                                    }
                                    className="inline-flex items-center gap-2 px-4 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
                                    Save changes
                                </button>
                            </div>
                        </form>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
