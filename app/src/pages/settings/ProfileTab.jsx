import { useState, useEffect, useCallback } from 'react';
import { User, Loader2, Check, Mail, Calendar, Building2, Pencil, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import { getCurrentUser, updateClientProfile } from '../../services/api';
import { getAuthItem, setAuthItem } from '../../utils/authStorage';

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

/**
 * ProfileTab — view and inline-edit the authenticated user's name + email.
 *
 * Reads /auth/me (works for clients and operators). Editing is wired to the
 * client-only PATCH /client/profile endpoint, so the edit affordance is shown
 * only for client (workspace-owner) accounts; operators see a read-only view
 * with a note pointing them at their workspace owner.
 */
export default function ProfileTab() {
    const { showToast } = useToast();
    const isOperator = getAuthItem('auth_type') === 'operator';

    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState({ name: '', email: '' });
    const [fieldError, setFieldError] = useState('');
    const [saving, setSaving] = useState(false);

    const loadProfile = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
            const data = await getCurrentUser();
            setProfile(data);
        } catch (err) {
            setLoadError(err.message || 'Failed to load profile');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadProfile();
    }, [loadProfile]);

    const startEditing = () => {
        setForm({ name: profile?.name || '', email: profile?.email || '' });
        setFieldError('');
        setEditing(true);
    };

    const cancelEditing = () => {
        setEditing(false);
        setFieldError('');
    };

    const handleSave = async (e) => {
        e.preventDefault();
        const name = form.name.trim();
        const email = form.email.trim();
        if (!name) {
            setFieldError('Name cannot be empty.');
            return;
        }
        if (!EMAIL_RE.test(email)) {
            setFieldError('Enter a valid email address.');
            return;
        }

        // Only send the fields that actually changed so an unchanged email
        // never trips the backend's duplicate-email check against itself.
        const patch = {};
        if (name !== (profile?.name || '')) patch.name = name;
        if (email.toLowerCase() !== (profile?.email || '').toLowerCase()) patch.email = email;
        if (Object.keys(patch).length === 0) {
            setEditing(false);
            return;
        }

        setSaving(true);
        setFieldError('');
        try {
            const updated = await updateClientProfile(patch);
            setProfile((prev) => ({ ...prev, name: updated.name, email: updated.email }));
            // Keep the cached display name (TopBar / user menu) in sync. Write to
            // whichever store this session used for auth so a session-only login
            // (sessionStorage) and a persistent login (localStorage) both update.
            if (typeof patch.name === 'string') {
                const persistent = window.sessionStorage.getItem('admin_name') === null;
                setAuthItem('admin_name', updated.name, persistent);
            }
            setEditing(false);
            showToast('success', 'Profile updated.');
        } catch (err) {
            setFieldError(err.message || 'Failed to update profile.');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
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
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
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
        <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
            <div className="flex items-start justify-between gap-4 mb-5">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <User size={16} className="text-primary-600 dark:text-primary-400" />
                    Profile
                </h2>
                {!isOperator && !editing && (
                    <button
                        type="button"
                        onClick={startEditing}
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

            {editing ? (
                <form onSubmit={handleSave} className="space-y-4">
                    {fieldError && (
                        <div className="p-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                            {fieldError}
                        </div>
                    )}
                    <div>
                        <label htmlFor="profile-name" className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                            Name
                        </label>
                        <input
                            id="profile-name"
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                            placeholder="Your name"
                            className={cn(
                                'w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                            )}
                        />
                    </div>
                    <div>
                        <label htmlFor="profile-email" className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                            Email
                        </label>
                        <input
                            id="profile-email"
                            type="email"
                            value={form.email}
                            onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                            placeholder="you@example.com"
                            className={cn(
                                'w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                            )}
                        />
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                        <button
                            type="submit"
                            disabled={saving}
                            className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                            Save changes
                        </button>
                        <button
                            type="button"
                            onClick={cancelEditing}
                            disabled={saving}
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
                    <ReadonlyRow icon={<Mail size={15} />} label="Email" value={profile?.email} />
                    {profile?.company_name && (
                        <ReadonlyRow icon={<Building2 size={15} />} label="Company" value={profile.company_name} />
                    )}
                    <ReadonlyRow icon={<Calendar size={15} />} label="Joined" value={formatJoined(profile?.created_at)} />
                    {isOperator && (
                        <p className="text-xs text-surface-400 dark:text-surface-500 pt-3">
                            Operator profiles are managed by your workspace owner. Contact them to change your name or email.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
