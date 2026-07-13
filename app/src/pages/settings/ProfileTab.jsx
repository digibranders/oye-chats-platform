import { useState, useEffect, useCallback } from 'react';
import { User, Loader2, Check, Mail, Calendar, Building2, Pencil, X, ShieldAlert } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import {
    getCurrentUser,
    updateClientProfile,
    requestClientEmailChange,
    confirmClientEmailChange,
    cancelClientEmailChange,
} from '../../services/api';
import { getAuthItem, setAuthItem } from '../../utils/authStorage';
import { useWorkspace } from '../../context/WorkspaceContext';
import InstallAsAppCard from '../../components/InstallAsAppCard';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatJoined(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function initialsFor(name, email) {
    const source = (name || email || '').trim();
    if (!source) return '?';
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

function ReadonlyRow({ icon, label, value }) {
    return (
        <div className="flex items-center justify-between gap-4 py-3">
            <span className="flex items-center gap-2 text-sm text-surface-500 dark:text-surface-400">
                {icon}
                {label}
            </span>
            <span className="text-sm font-medium text-surface-900 dark:text-surface-50 truncate max-w-[60%] text-right">
                {value || '—'}
            </span>
        </div>
    );
}

const inputCls = cn(
    'w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
    'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
    'placeholder:text-surface-400 dark:placeholder:text-surface-500',
    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
);

const labelCls = 'text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block';

/**
 * ProfileTab — view/edit the authenticated user's name, and change email via a
 * password-confirmed, OTP-verified flow (name and email are edited independently
 * since email now requires re-authentication + inbox verification).
 *
 * Reads /auth/me (works for clients and operators). Both edit affordances are
 * shown only for client (workspace-owner) accounts; operators see a read-only
 * view with a note pointing them at their workspace owner.
 */
export default function ProfileTab() {
    const { showToast } = useToast();
    const isOperator = getAuthItem('auth_type') === 'operator';
    // Linked-operator flow: a Client viewing a workspace where
    // ``currentRole === 'operator'``. Same audience as InstallBanner —
    // cover both flavors so the workspace switcher swap is enough to
    // reveal (or hide) the install card without a reload.
    const { currentRole: workspaceRole } = useWorkspace();
    const isOperatorRole = isOperator || workspaceRole === 'operator';

    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    // Name editing
    const [nameEditing, setNameEditing] = useState(false);
    const [name, setName] = useState('');
    const [nameError, setNameError] = useState('');
    const [savingName, setSavingName] = useState(false);

    // Email change: 'idle' -> 'request' (new email + current password) -> 'verify' (otp)
    const [emailStep, setEmailStep] = useState('idle');
    const [newEmail, setNewEmail] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [otp, setOtp] = useState('');
    const [emailError, setEmailError] = useState('');
    const [emailBusy, setEmailBusy] = useState(false);

    const loadProfile = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
            const data = await getCurrentUser();
            setProfile(data);
            if (data?.pending_email) setEmailStep('verify');
        } catch (err) {
            setLoadError(err.message || 'Failed to load profile');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadProfile();
    }, [loadProfile]);

    const startNameEditing = () => {
        setName(profile?.name || '');
        setNameError('');
        setNameEditing(true);
    };

    const handleSaveName = async (e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) {
            setNameError('Name cannot be empty.');
            return;
        }
        if (trimmed === (profile?.name || '')) {
            setNameEditing(false);
            return;
        }
        setSavingName(true);
        setNameError('');
        try {
            const updated = await updateClientProfile({ name: trimmed });
            setProfile((prev) => ({ ...prev, name: updated.name }));
            // Keep the cached display name (TopBar / user menu) in sync. Write to
            // whichever store this session used for auth so a session-only login
            // (sessionStorage) and a persistent login (localStorage) both update.
            const persistent = window.sessionStorage.getItem('admin_name') === null;
            setAuthItem('admin_name', updated.name, persistent);
            setNameEditing(false);
            showToast('success', 'Name updated.');
        } catch (err) {
            setNameError(err.message || 'Failed to update name.');
        } finally {
            setSavingName(false);
        }
    };

    const startEmailChange = () => {
        setNewEmail('');
        setCurrentPassword('');
        setEmailError('');
        setEmailStep('request');
    };

    const cancelEmailChange = async (silent) => {
        const hadPending = emailStep === 'verify';
        setEmailStep('idle');
        setEmailError('');
        setOtp('');
        if (hadPending) {
            try {
                await cancelClientEmailChange();
                setProfile((prev) => ({ ...prev, pending_email: null }));
                if (!silent) showToast('success', 'Email change cancelled.');
            } catch {
                // Best-effort — the pending state will still expire on its own via OTP TTL.
            }
        }
    };

    const handleRequestEmailChange = async (e) => {
        e.preventDefault();
        const email = newEmail.trim();
        if (!EMAIL_RE.test(email)) {
            setEmailError('Enter a valid email address.');
            return;
        }
        if (email.toLowerCase() === (profile?.email || '').toLowerCase()) {
            setEmailError("That's already your current email address.");
            return;
        }
        if (!currentPassword) {
            setEmailError('Enter your current password to confirm this change.');
            return;
        }
        setEmailBusy(true);
        setEmailError('');
        try {
            const res = await requestClientEmailChange(email, currentPassword);
            setProfile((prev) => ({ ...prev, pending_email: res.pending_email }));
            setCurrentPassword('');
            setOtp('');
            setEmailStep('verify');
            showToast('success', 'Verification code sent to your new email.');
        } catch (err) {
            setEmailError(err.message || 'Failed to start email change.');
        } finally {
            setEmailBusy(false);
        }
    };

    const handleConfirmEmailChange = async (e) => {
        e.preventDefault();
        if (!otp.trim()) {
            setEmailError('Enter the verification code.');
            return;
        }
        setEmailBusy(true);
        setEmailError('');
        try {
            const updated = await confirmClientEmailChange(otp.trim());
            setProfile((prev) => ({ ...prev, email: updated.email, pending_email: null }));
            setOtp('');
            setEmailStep('idle');
            showToast('success', 'Email address updated.');
        } catch (err) {
            setEmailError(err.message || 'Failed to confirm email change.');
        } finally {
            setEmailBusy(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <div className="animate-pulse space-y-5">
                    <div className="flex items-center gap-4">
                        <div className="h-16 w-16 rounded-full bg-surface-200 dark:bg-surface-800" />
                        <div className="space-y-2">
                            <div className="h-4 w-40 rounded bg-surface-200 dark:bg-surface-800" />
                            <div className="h-3 w-56 rounded bg-surface-200 dark:bg-surface-800" />
                        </div>
                    </div>
                    <div className="h-px bg-surface-100 dark:bg-surface-800" />
                    <div className="space-y-3">
                        <div className="h-4 w-full rounded bg-surface-200 dark:bg-surface-800" />
                        <div className="h-4 w-3/4 rounded bg-surface-200 dark:bg-surface-800" />
                    </div>
                </div>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{loadError}</p>
                <button
                    type="button"
                    onClick={loadProfile}
                    className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
                >
                    Try again
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* ── Profile (name) ──────────────────────────────────────────── */}
            <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <div className="flex items-start justify-between gap-4 mb-5">
                    <h2 className="text-base font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                        <User size={16} className="text-primary-600 dark:text-primary-400" />
                        Profile
                    </h2>
                    {!isOperator && !nameEditing && (
                        <button
                            type="button"
                            onClick={startNameEditing}
                            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                        >
                            <Pencil size={14} />
                            Edit
                        </button>
                    )}
                </div>

                {/* Identity header */}
                <div className="flex items-center gap-4 mb-6">
                    <div className="h-16 w-16 rounded-full bg-primary-600 text-white flex items-center justify-center text-lg font-semibold shrink-0">
                        {initialsFor(profile?.name, profile?.email)}
                    </div>
                    <div className="min-w-0">
                        <p className="text-base font-semibold text-surface-900 dark:text-surface-50 truncate">
                            {profile?.name || '—'}
                        </p>
                        <p className="text-sm text-surface-500 dark:text-surface-400 truncate">
                            {profile?.email || '—'}
                        </p>
                    </div>
                </div>

                {nameEditing ? (
                    <form onSubmit={handleSaveName} className="space-y-4">
                        {nameError && (
                            <div className="p-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                                {nameError}
                            </div>
                        )}
                        <div>
                            <label htmlFor="profile-name" className={labelCls}>
                                Name
                            </label>
                            <input
                                id="profile-name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Your name"
                                className={inputCls}
                            />
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                            <button
                                type="submit"
                                disabled={savingName}
                                className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {savingName ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                                Save changes
                            </button>
                            <button
                                type="button"
                                onClick={() => setNameEditing(false)}
                                disabled={savingName}
                                className="flex items-center gap-2 py-2.5 px-4 text-sm font-medium text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-xl transition-colors disabled:opacity-50"
                            >
                                <X size={15} />
                                Cancel
                            </button>
                        </div>
                    </form>
                ) : (
                    <div className="divide-y divide-surface-100 dark:divide-surface-800">
                        <ReadonlyRow icon={<User size={15} />} label="Name" value={profile?.name} />
                        <ReadonlyRow icon={<Calendar size={15} />} label="Joined" value={formatJoined(profile?.created_at)} />
                        {profile?.company_name && (
                            <ReadonlyRow icon={<Building2 size={15} />} label="Company" value={profile.company_name} />
                        )}
                        {isOperator && (
                            <p className="text-xs text-surface-400 dark:text-surface-500 pt-3">
                                Operator profiles are managed by your workspace owner. Contact them to change your name or email.
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* ── Email (separate: requires password + inbox verification) ─── */}
            {!isOperator && (
                <div className="bg-[var(--bg-card)] dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <div className="flex items-start justify-between gap-4 mb-5">
                        <h2 className="text-base font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                            <Mail size={16} className="text-primary-600 dark:text-primary-400" />
                            Email address
                        </h2>
                        {emailStep === 'idle' && (
                            <button
                                type="button"
                                onClick={startEmailChange}
                                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                            >
                                <Pencil size={14} />
                                Change
                            </button>
                        )}
                    </div>

                    {emailStep === 'idle' && (
                        <ReadonlyRow icon={<Mail size={15} />} label="Current email" value={profile?.email} />
                    )}

                    {emailStep === 'request' && (
                        <form onSubmit={handleRequestEmailChange} className="space-y-4">
                            <p className="text-sm text-surface-500 dark:text-surface-400">
                                We'll send a verification code to the new address before it becomes your login email.
                            </p>
                            {emailError && (
                                <div className="p-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                                    {emailError}
                                </div>
                            )}
                            <div>
                                <label htmlFor="new-email" className={labelCls}>
                                    New email
                                </label>
                                <input
                                    id="new-email"
                                    type="email"
                                    value={newEmail}
                                    onChange={(e) => setNewEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    autoComplete="email"
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label htmlFor="current-password-for-email" className={labelCls}>
                                    Current password
                                </label>
                                <input
                                    id="current-password-for-email"
                                    type="password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                    placeholder="Confirm it's you"
                                    autoComplete="current-password"
                                    className={inputCls}
                                />
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    type="submit"
                                    disabled={emailBusy}
                                    className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {emailBusy ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
                                    Send verification code
                                </button>
                                <button
                                    type="button"
                                    onClick={() => cancelEmailChange(true)}
                                    disabled={emailBusy}
                                    className="flex items-center gap-2 py-2.5 px-4 text-sm font-medium text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-xl transition-colors disabled:opacity-50"
                                >
                                    <X size={15} />
                                    Cancel
                                </button>
                            </div>
                        </form>
                    )}

                    {emailStep === 'verify' && (
                        <form onSubmit={handleConfirmEmailChange} className="space-y-4">
                            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl text-sm text-amber-700 dark:text-amber-400">
                                <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                                <span>
                                    Verification pending for <strong>{profile?.pending_email}</strong>. Enter the code we
                                    emailed there to finish the change — your login email stays{' '}
                                    <strong>{profile?.email}</strong> until then.
                                </span>
                            </div>
                            {emailError && (
                                <div className="p-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                                    {emailError}
                                </div>
                            )}
                            <div>
                                <label htmlFor="email-otp" className={labelCls}>
                                    Verification code
                                </label>
                                <input
                                    id="email-otp"
                                    type="text"
                                    inputMode="numeric"
                                    value={otp}
                                    onChange={(e) => setOtp(e.target.value)}
                                    placeholder="6-digit code"
                                    autoComplete="one-time-code"
                                    className={inputCls}
                                />
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    type="submit"
                                    disabled={emailBusy}
                                    className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {emailBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                                    Confirm change
                                </button>
                                <button
                                    type="button"
                                    onClick={() => cancelEmailChange(false)}
                                    disabled={emailBusy}
                                    className="flex items-center gap-2 py-2.5 px-4 text-sm font-medium text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-xl transition-colors disabled:opacity-50"
                                >
                                    <X size={15} />
                                    Cancel change
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            )}

            {/* Install-as-app card is only rendered on the Profile tab when
                the current role is operator — for admins/owners the same
                card lives on the Notifications tab (which operators can't
                see, see Settings.jsx tab filter). */}
            {isOperatorRole && <InstallAsAppCard />}
        </div>
    );
}
