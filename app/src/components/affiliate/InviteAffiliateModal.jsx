import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, Mail, UserPlus, AlertCircle } from 'lucide-react';
import { inviteSuperadminAffiliate } from '../../services/api';
import { cn } from '../../lib/utils';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Super-admin modal for inviting a new affiliate by email.
 *
 * v1 limitation: the target email must already have an OyeChats account.
 * The backend returns a 404 with a clear message when that's not the case;
 * we surface it verbatim instead of pre-checking, so super admin sees the
 * same source of truth.
 *
 * The ``max_active_codes`` field is optional — leaving it blank uses the
 * service-layer default of 10. Pass a positive integer to give that
 * specific affiliate a different ceiling (e.g. 25 for a star partner).
 */
export default function InviteAffiliateModal({ open, onClose, onInvited }) {
    const [email, setEmail] = useState('');
    const [maxCodes, setMaxCodes] = useState('');
    const [commission, setCommission] = useState('');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        if (open) {
            setEmail('');
            setMaxCodes('');
            setCommission('');
            setError('');
            const t = setTimeout(() => inputRef.current?.focus(), 80);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        const handler = (e) => { if (e.key === 'Escape' && !isSaving) onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, isSaving, onClose]);

    const emailValid = EMAIL_REGEX.test(email.trim());

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!emailValid) {
            setError('Enter a valid email address.');
            return;
        }
        // Parse max_active_codes — empty string means "use default".
        let maxCodesNum = null;
        if (maxCodes.trim() !== '') {
            const parsed = Number(maxCodes);
            if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
                setError('Max active codes must be an integer between 1 and 100.');
                return;
            }
            maxCodesNum = parsed;
        }
        // Parse commission % — empty means "default 0".
        let commissionNum = null;
        if (commission.trim() !== '') {
            const parsed = Number(commission);
            if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
                setError('Commission must be a number between 0 and 100.');
                return;
            }
            commissionNum = parsed;
        }
        try {
            setIsSaving(true);
            const created = await inviteSuperadminAffiliate(
                email.trim().toLowerCase(),
                maxCodesNum,
                commissionNum,
            );
            onInvited?.(created);
            onClose();
        } catch (err) {
            setError(err?.message || 'Failed to invite affiliate.');
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
                    aria-labelledby="invite-affiliate-title"
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
                                    <UserPlus size={16} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h2
                                        id="invite-affiliate-title"
                                        className="text-[16px] font-bold text-surface-900 dark:text-surface-50"
                                    >
                                        Invite affiliate
                                    </h2>
                                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-0.5">
                                        Enroll an existing OyeChats customer in the referral program.
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
                                    Email
                                </label>
                                <div className="relative">
                                    <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                                    <input
                                        ref={inputRef}
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="customer@example.com"
                                        className={cn(
                                            'w-full h-10 pl-9 pr-3 text-sm',
                                            'bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                                            'border rounded-lg outline-none transition-colors',
                                            email.length === 0
                                                ? 'border-surface-200 dark:border-surface-700 focus:border-primary-400'
                                                : emailValid
                                                    ? 'border-emerald-400/60 focus:border-emerald-500 dark:border-emerald-500/40'
                                                    : 'border-rose-400/60 focus:border-rose-500 dark:border-rose-500/40',
                                        )}
                                        disabled={isSaving}
                                    />
                                </div>
                                <p className="text-[11px] text-surface-500 dark:text-surface-400">
                                    Must match an existing OyeChats account. If they haven&apos;t signed up,
                                    ask them to register first.
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                                        Max codes <span className="text-surface-400 font-normal">(optional)</span>
                                    </label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="100"
                                        value={maxCodes}
                                        onChange={(e) => setMaxCodes(e.target.value)}
                                        placeholder="10"
                                        className="w-full h-10 px-3 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-lg outline-none focus:border-primary-400 transition-colors"
                                        disabled={isSaving}
                                    />
                                    <p className="text-[11px] text-surface-500 dark:text-surface-400">
                                        Defaults to 10.
                                    </p>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                                        Commission % <span className="text-surface-400 font-normal">(optional)</span>
                                    </label>
                                    <div className="relative">
                                        <input
                                            type="number"
                                            min="0"
                                            max="100"
                                            step="0.01"
                                            value={commission}
                                            onChange={(e) => setCommission(e.target.value)}
                                            placeholder="0"
                                            className="w-full h-10 pl-3 pr-8 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-lg outline-none focus:border-primary-400 transition-colors"
                                            disabled={isSaving}
                                        />
                                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-surface-400 pointer-events-none">%</span>
                                    </div>
                                    <p className="text-[11px] text-surface-500 dark:text-surface-400">
                                        0–100. Default 0.
                                    </p>
                                </div>
                            </div>

                            {error && (
                                <div
                                    role="alert"
                                    className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[13px]"
                                >
                                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                    <span>{error}</span>
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
                                    disabled={isSaving || !emailValid}
                                    className="inline-flex items-center gap-2 px-4 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                                    Invite
                                </button>
                            </div>
                        </form>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
