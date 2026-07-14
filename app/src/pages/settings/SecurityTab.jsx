import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, KeyRound, Eye, EyeOff, Loader2, LogOut, ArrowLeft, Mail } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import {
    operatorChangePassword,
    changeClientPassword,
    getCurrentUser,
    requestPasswordReset,
    resetPassword,
} from '../../services/api';
import { getAuthItem, clearAuthStorage } from '../../utils/authStorage';
import { clearTrialBannerDismissals } from '../../utils/trialBanner';

const hasLetter = (v) => /[a-zA-Z]/.test(v);
const hasNumber = (v) => /\d/.test(v);

const inputCls = cn(
    'w-full px-3 py-2 pr-10 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
    'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
    'placeholder:text-surface-400 dark:placeholder:text-surface-500',
    'focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)] outline-none transition-all'
);

const labelCls = 'text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block';

/**
 * SecurityTab — change password (for both account types), an inline
 * "forgot password" recovery flow, and sign out.
 *
 * Clients hit POST /client/change-password; operators hit the existing
 * /auth/operator-change-password endpoint. The account type is read from
 * auth storage. Client-side validation mirrors registration (≥8 chars, at
 * least one letter and one number, confirm match) before any network call.
 *
 * The "Forgot your password?" link swaps the Change Password card for the
 * same OTP-based recovery flow as the public /forgot-password page, but
 * inline — the user stays on Settings and never has to sign out to reset a
 * password they can't remember. Only offered to clients (operators reset
 * via their workspace owner, same as the standalone page).
 */
export default function SecurityTab() {
    const { showToast } = useToast();
    const navigate = useNavigate();
    const isOperator = getAuthItem('auth_type') === 'operator';

    // 'password' (default) | 'forgot-request' | 'forgot-verify'
    const [mode, setMode] = useState('password');

    const [form, setForm] = useState({ current: '', next: '', confirm: '' });
    const [show, setShow] = useState({ current: false, next: false });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const [accountEmail, setAccountEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [recoveryPassword, setRecoveryPassword] = useState('');
    const [showRecoveryPassword, setShowRecoveryPassword] = useState(false);
    const [recoveryBusy, setRecoveryBusy] = useState(false);
    const [recoveryError, setRecoveryError] = useState('');

    useEffect(() => {
        if (isOperator) return;
        getCurrentUser()
            .then((data) => setAccountEmail(data?.email || ''))
            .catch(() => {});
    }, [isOperator]);

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

    const startForgotPassword = () => {
        setRecoveryError('');
        setOtp('');
        setRecoveryPassword('');
        setMode('forgot-request');
    };

    const backToChangePassword = () => {
        setMode('password');
        setRecoveryError('');
        setOtp('');
        setRecoveryPassword('');
    };

    const sendRecoveryCode = useCallback(
        async (e) => {
            e?.preventDefault?.();
            if (!accountEmail) {
                setRecoveryError('Could not determine your account email. Please refresh and try again.');
                return;
            }
            setRecoveryBusy(true);
            setRecoveryError('');
            try {
                await requestPasswordReset(accountEmail);
                showToast('success', `Recovery code sent to ${accountEmail}.`);
                setMode('forgot-verify');
            } catch (err) {
                setRecoveryError(err.message || 'Failed to send recovery code.');
            } finally {
                setRecoveryBusy(false);
            }
        },
        [accountEmail, showToast]
    );

    const handleResetPassword = async (e) => {
        e.preventDefault();
        setRecoveryError('');

        if (!otp.trim()) {
            setRecoveryError('Enter the recovery code.');
            return;
        }
        if (recoveryPassword.length < 8 || !hasLetter(recoveryPassword) || !hasNumber(recoveryPassword)) {
            setRecoveryError('New password must be at least 8 characters and include a letter and a number.');
            return;
        }

        setRecoveryBusy(true);
        try {
            await resetPassword(accountEmail, otp.trim(), recoveryPassword);
            showToast('success', 'Password reset. You can sign in with your new password next time.');
            backToChangePassword();
        } catch (err) {
            setRecoveryError(err.message || 'Failed to reset password.');
        } finally {
            setRecoveryBusy(false);
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
            {/* ── Change Password / Forgot Password ──────────────────────────── */}
            <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                {mode === 'password' && (
                    <>
                        <div className="flex items-start justify-between gap-4 mb-1">
                            <h2 className="text-base font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                                <KeyRound size={16} className="text-primary-600 dark:text-primary-400" />
                                Change Password
                            </h2>
                            {!isOperator && (
                                <button
                                    type="button"
                                    onClick={startForgotPassword}
                                    className="text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline whitespace-nowrap"
                                >
                                    Forgot your password?
                                </button>
                            )}
                        </div>
                        <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                            Update your login password. Must be at least 8 characters with a letter and a number.
                            {!isOperator && " Don't know your current password? Use the link above to reset it instead."}
                        </p>

                        {error && (
                            <div className="p-3 mb-4 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                                {error}
                            </div>
                        )}

                        <form onSubmit={handleChangePassword} className="space-y-3">
                            {/* Current password */}
                            <div>
                                <label htmlFor="security-current-password" className={labelCls}>
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
                                        className={inputCls}
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
                                <label htmlFor="security-new-password" className={labelCls}>
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
                                        className={inputCls}
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
                                <label htmlFor="security-confirm-password" className={labelCls}>
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
                                            ? 'border-rose-400 dark:border-rose-500 focus:ring-1 focus:ring-rose-500/20'
                                            : 'border-surface-200 dark:border-surface-600 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)]',
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
                    </>
                )}

                {mode === 'forgot-request' && (
                    <>
                        <button
                            type="button"
                            onClick={backToChangePassword}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 mb-3"
                        >
                            <ArrowLeft size={13} />
                            Back to Change Password
                        </button>
                        <h2 className="text-base font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2 mb-1">
                            <Mail size={16} className="text-primary-600 dark:text-primary-400" />
                            Reset your password
                        </h2>
                        <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                            We'll email a recovery code to{' '}
                            <strong className="text-surface-700 dark:text-surface-200">{accountEmail || 'your account email'}</strong>.
                            Use it to set a new password without your old one.
                        </p>

                        {recoveryError && (
                            <div className="p-3 mb-4 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                                {recoveryError}
                            </div>
                        )}

                        <form onSubmit={sendRecoveryCode}>
                            <button
                                type="submit"
                                disabled={recoveryBusy || !accountEmail}
                                className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {recoveryBusy ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
                                Send recovery code
                            </button>
                        </form>
                    </>
                )}

                {mode === 'forgot-verify' && (
                    <>
                        <button
                            type="button"
                            onClick={backToChangePassword}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 mb-3"
                        >
                            <ArrowLeft size={13} />
                            Back to Change Password
                        </button>
                        <h2 className="text-base font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2 mb-1">
                            <KeyRound size={16} className="text-primary-600 dark:text-primary-400" />
                            Enter recovery code
                        </h2>
                        <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                            Enter the code sent to <strong className="text-surface-700 dark:text-surface-200">{accountEmail}</strong> and
                            choose a new password.
                        </p>

                        {recoveryError && (
                            <div className="p-3 mb-4 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                                {recoveryError}
                            </div>
                        )}

                        <form onSubmit={handleResetPassword} className="space-y-3">
                            <div>
                                <label htmlFor="security-recovery-otp" className={labelCls}>
                                    Recovery Code
                                </label>
                                <input
                                    id="security-recovery-otp"
                                    type="text"
                                    inputMode="numeric"
                                    required
                                    value={otp}
                                    onChange={(e) => setOtp(e.target.value)}
                                    placeholder="6-digit code"
                                    autoComplete="one-time-code"
                                    className="w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 text-sm bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)] outline-none transition-all font-mono tracking-widest"
                                />
                                <button
                                    type="button"
                                    onClick={sendRecoveryCode}
                                    disabled={recoveryBusy}
                                    className="mt-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Didn't receive a code? Resend
                                </button>
                            </div>

                            <div>
                                <label htmlFor="security-recovery-password" className={labelCls}>
                                    New Password
                                </label>
                                <div className="relative">
                                    <input
                                        id="security-recovery-password"
                                        type={showRecoveryPassword ? 'text' : 'password'}
                                        required
                                        minLength={8}
                                        value={recoveryPassword}
                                        onChange={(e) => setRecoveryPassword(e.target.value)}
                                        placeholder="At least 8 chars, letter + number"
                                        autoComplete="new-password"
                                        className={inputCls}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowRecoveryPassword((v) => !v)}
                                        aria-label={showRecoveryPassword ? 'Hide password' : 'Show password'}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                                    >
                                        {showRecoveryPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                                    </button>
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={recoveryBusy || !otp || !recoveryPassword}
                                className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {recoveryBusy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                                Reset Password
                            </button>
                        </form>
                    </>
                )}
            </div>

            {/* ── Sign out ────────────────────────────────────────────────── */}
            <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-bold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
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
