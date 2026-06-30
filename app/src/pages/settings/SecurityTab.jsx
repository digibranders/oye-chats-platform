import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, KeyRound, Eye, EyeOff, Check, Loader2, LogOut } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import { operatorChangePassword, changeClientPassword } from '../../services/api';
import { getAuthItem, clearAuthStorage } from '../../utils/authStorage';
import { clearTrialBannerDismissals } from '../../utils/trialBanner';

const hasLetter = (v) => /[a-zA-Z]/.test(v);
const hasNumber = (v) => /\d/.test(v);

/**
 * SecurityTab — change password (for both account types) and sign out.
 *
 * Clients hit POST /client/change-password; operators hit the existing
 * /auth/operator-change-password endpoint. The account type is read from
 * auth storage. Client-side validation mirrors registration (≥8 chars, at
 * least one letter and one number, confirm match) before any network call.
 */
export default function SecurityTab() {
    const { showToast } = useToast();
    const navigate = useNavigate();
    const isOperator = getAuthItem('auth_type') === 'operator';

    const [form, setForm] = useState({ current: '', next: '', confirm: '' });
    const [show, setShow] = useState({ current: false, next: false });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const handleChangePassword = async (e) => {
        e.preventDefault();
        setError('');

        if (form.next !== form.confirm) {
            setError('New passwords do not match.');
            return;
        }
        if (form.next.length < 8 || !hasLetter(form.next) || !hasNumber(form.next)) {
            setError('New password must be at least 8 characters and include a letter and a number.');
            return;
        }

        setSaving(true);
        try {
            if (isOperator) {
                await operatorChangePassword(form.current, form.next);
            } else {
                await changeClientPassword(form.current, form.next);
            }
            setForm({ current: '', next: '', confirm: '' });
            showToast('success', 'Password changed successfully.');
        } catch (err) {
            setError(err.message || 'Failed to change password.');
        } finally {
            setSaving(false);
        }
    };

    const handleSignOut = () => {
        // Clear both stores so a session-only login leaves no stale shadow that
        // would auto-log the user back in, then reset trial-banner dismissals
        // for the next user on this tab. Mirrors TopBar's logout handler.
        clearAuthStorage();
        clearTrialBannerDismissals();
        navigate('/login');
    };

    const confirmMismatch = form.confirm && form.confirm !== form.next;

    return (
        <div className="space-y-6">
            {/* ── Change Password ─────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                    <KeyRound size={16} className="text-primary-600 dark:text-primary-400" />
                    Change Password
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                    Update your login password. Must be at least 8 characters with a letter and a number.
                </p>

                {error && (
                    <div className="p-3 mb-4 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                        {error}
                    </div>
                )}

                <form onSubmit={handleChangePassword} className="space-y-3">
                    {/* Current password */}
                    <div>
                        <label htmlFor="security-current-password" className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                            Current Password
                        </label>
                        <div className="relative">
                            <input
                                id="security-current-password"
                                type={show.current ? 'text' : 'password'}
                                required
                                value={form.current}
                                onChange={(e) => setForm((p) => ({ ...p, current: e.target.value }))}
                                placeholder="Your current password"
                                autoComplete="current-password"
                                className={cn(
                                    'w-full px-3 py-2 pr-10 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                    'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                    'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                                )}
                            />
                            <button
                                type="button"
                                onClick={() => setShow((p) => ({ ...p, current: !p.current }))}
                                aria-label={show.current ? 'Hide password' : 'Show password'}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                            >
                                {show.current ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                        </div>
                    </div>

                    {/* New password */}
                    <div>
                        <label htmlFor="security-new-password" className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                            New Password
                        </label>
                        <div className="relative">
                            <input
                                id="security-new-password"
                                type={show.next ? 'text' : 'password'}
                                required
                                minLength={8}
                                value={form.next}
                                onChange={(e) => setForm((p) => ({ ...p, next: e.target.value }))}
                                placeholder="At least 8 chars, letter + number"
                                autoComplete="new-password"
                                className={cn(
                                    'w-full px-3 py-2 pr-10 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                    'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                    'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                                )}
                            />
                            <button
                                type="button"
                                onClick={() => setShow((p) => ({ ...p, next: !p.next }))}
                                aria-label={show.next ? 'Hide password' : 'Show password'}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                            >
                                {show.next ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                        </div>
                    </div>

                    {/* Confirm new password */}
                    <div>
                        <label htmlFor="security-confirm-password" className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                            Confirm New Password
                        </label>
                        <input
                            id="security-confirm-password"
                            type="password"
                            required
                            value={form.confirm}
                            onChange={(e) => setForm((p) => ({ ...p, confirm: e.target.value }))}
                            placeholder="Repeat new password"
                            autoComplete="new-password"
                            className={cn(
                                'w-full px-3 py-2 rounded-xl border text-sm transition-all outline-none',
                                confirmMismatch
                                    ? 'border-rose-400 dark:border-rose-500 focus:ring-2 focus:ring-rose-500/20'
                                    : 'border-surface-200 dark:border-surface-600 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                                'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500'
                            )}
                        />
                        {confirmMismatch && (
                            <p className="text-xs text-rose-500 mt-1">Passwords do not match</p>
                        )}
                    </div>

                    <button
                        type="submit"
                        disabled={saving || !form.current || !form.next || !form.confirm}
                        className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                        Change Password
                    </button>
                </form>
            </div>

            {/* ── Sign out ────────────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                    <Shield size={16} className="text-primary-600 dark:text-primary-400" />
                    Session
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                    Sign out of the dashboard on this device.
                </p>
                <button
                    type="button"
                    onClick={handleSignOut}
                    className="inline-flex items-center gap-2 py-2.5 px-5 text-sm font-medium rounded-xl border border-surface-200 dark:border-surface-700 text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                >
                    <LogOut size={15} />
                    Sign out
                </button>
            </div>
        </div>
    );
}
