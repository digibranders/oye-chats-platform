import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import BusinessHoursEditor from '../components/BusinessHoursEditor';
import {
    UsersRound, Building2, Plus, Trash2, X, Shield, User, Headphones,
    MessageSquareText, Pencil, Check, ChevronDown, Lock,
    Send, Mail, RotateCcw, Clock,
} from 'lucide-react';
import {
    getOperators, updateOperator, deleteOperator,
    getDepartments, createDepartment, updateDepartment, deleteDepartment,
    createOperatorInvite, listOperatorInvites, resendOperatorInvite, revokeOperatorInvite,
    addSelfAsOperator,
} from '../services/api';
import { getAuthItem } from '../utils/authStorage';
import { useToast } from '../context/ToastContext';
import { useUpgradeModal } from '../context/UpgradeModalContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBotContext } from '../context/BotContext';
import useEntitlements from '../hooks/useEntitlements';
import CannedResponses from './CannedResponses';
import { getAuthState } from '../utils/auth';
import { cn } from '../lib/utils';

const ROLES = ['operator', 'admin', 'owner'];

const inputCls = 'w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400 transition-colors';

export default function TeamManagement() {
    const { isOperator, isBotManager } = getAuthState();
    const { showToast } = useToast();
    const { requestUpgrade } = useUpgradeModal();
    const { entitlements: ent } = useEntitlements();
    // "Pure operator" = the caller has an operator role in the currently-
    // viewed workspace and can't manage the team. Two paths qualify:
    //   1. Legacy X-Operator-Key session with role != owner/admin.
    //   2. Client identity with ``auth_type='client'`` (so isBotManager stays
    //      true at the storage level) but ``currentRole='operator'`` — they
    //      accepted an invite into someone else's workspace and are acting
    //      as an operator there via the switcher.
    // Write actions (invite, create dept, edit/delete rows) gate on
    // ``canManageTeam``; tab visibility does NOT — operators still see the
    // Operators and Departments lists read-only. Kept in a single derivation
    // so a mismatch between the button gate and the payload gate is
    // impossible.
    const { currentRole: workspaceRole, currentWorkspaceId } = useWorkspace();
    const pureOperator = (isOperator && !isBotManager) || workspaceRole === 'operator';
    const canManageTeam = isBotManager && !pureOperator;
    // Live-chat-derived team features (operators, departments, canned
    // responses) are all bundled behind the `live_chat` plan feature. Free
    // plans render the team page so users can SEE the surface, but every
    // add-action opens the upgrade modal instead of mutating state.
    const liveChatEnabled = ent.hasFeature('live_chat');
    const requireLiveChat = (intent) => {
        if (!liveChatEnabled) {
            requestUpgrade(intent);
            return false;
        }
        return true;
    };

    const [operators, setOperators] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState(null);
    // Deep-linkable tab: a valid ``?tab=`` (e.g. Settings → Live Chat links to
    // ``/team?tab=departments``) wins; otherwise fall back to the role default.
    const [searchParams] = useSearchParams();
    const [activeTab, setActiveTab] = useState(() => {
        const urlTab = searchParams.get('tab');
        if (['operators', 'departments', 'quick-replies'].includes(urlTab)) return urlTab;
        return isOperator && !isBotManager ? 'quick-replies' : 'operators';
    });

    // Invite operator (new flow) — email-based magic-link invite. The invitee
    // signs up (or logs in) with the invited email; a linked Operator row is
    // created in this workspace on acceptance. See invite_service.py backend.
    const [showInviteOperator, setShowInviteOperator] = useState(false);
    const [inviteForm, setInviteForm] = useState({ email: '', role: 'operator', department_id: '' });
    const [inviteError, setInviteError] = useState('');
    const [inviteSubmitting, setInviteSubmitting] = useState(false);
    const [pendingInvites, setPendingInvites] = useState([]);
    const [pendingInvitesLoading, setPendingInvitesLoading] = useState(true);

    // Self-operator (Option B): the workspace owner explicitly opts into being
    // an operator in their own workspace via a Team-page CTA. The button is
    // shown when they have no self-operator row; it swaps to a "Leave live
    // chat" affordance on their own row once they've added themselves.
    const [selfOperatorBusy, setSelfOperatorBusy] = useState(false);
    const myClientId = Number(getAuthItem('admin_client_id') || 0) || null;
    // Workspace context — ``currentWorkspaceId`` is the workspace the switcher
    // is currently pointing at. For a solo owner or a fresh session with no
    // memberships, WorkspaceContext hasn't populated yet and this is null; in
    // that state we fall through to "viewing own workspace" behaviour (the
    // caller has no other workspace to be viewing anyway).
    const isViewingOwnWorkspace = !currentWorkspaceId || currentWorkspaceId === myClientId;
    // The sidebar's bot switcher scopes team management: an operator is
    // bound to exactly one bot (``Operator.bot_id``, migration
    // b1c7e9d3f2a5), and the roster / pending-invites lists here filter to
    // just that bot so a workspace with multiple bots doesn't drown one
    // team in another's members. When no bot is resolved yet (fresh
    // workspace, still-loading BotContext) both derived lists are empty
    // and the empty state prompts the admin to pick a bot.
    const { selectedBot } = useBotContext();
    const selectedBotId = selectedBot?.id ?? null;
    // Legacy X-Operator-Key sessions don't have a Client identity we can
    // check against ``linked_client_id`` — self-add is a Client-only affordance
    // so we don't render it for legacy operator logins.
    //
    // Also gated on ``isViewingOwnWorkspace``: ``POST /me/self-operator`` uses
    // ``get_current_client_strict`` which ignores ``X-Workspace-Id``, so it
    // always creates the row in the caller's OWN workspace. Showing the CTA
    // while the switcher points at someone else's workspace (Alice viewing
    // Acme as an invited operator) would silently create a self-op row in
    // Alice's own dormant workspace — invisible and confusing. Hiding the
    // CTA in that context makes the button semantically honest: "add yourself
    // as an operator HERE."
    const canSelfAdd = !isOperator && !!myClientId && isViewingOwnWorkspace;
    // The self-operator row (owner acting as operator in their own workspace).
    // Preference order matches the backend toggle-status lookup so the CTA
    // hides for either shape of row:
    //   1. The linked self-op row (``linked_client_id === myClientId``) —
    //      the row created by ``POST /me/self-operator``.
    //   2. A legacy ``role === 'owner'`` row with no linked identity — created
    //      by earlier auto-provisioning paths before the linked-identity model.
    // Only one row of either shape can exist per workspace for this caller,
    // so the ``find`` is safe.
    const selfOperatorRow = canSelfAdd
        ? (
            operators.find((op) => op.linked_client_id === myClientId)
            || operators.find((op) => op.role === 'owner' && !op.linked_client_id)
            || null
        )
        : null;
    const hasActiveSelfOperator = !!(selfOperatorRow && selfOperatorRow.is_active !== false);

    // Edit operator
    const [editingOperator, setEditingOperator] = useState(null); // operator object
    const [editOpForm, setEditOpForm] = useState({ name: '', email: '', role: '', department_id: '', max_concurrent_chats: 3 });
    const [editOpError, setEditOpError] = useState('');
    const [editOpSaving, setEditOpSaving] = useState(false);

    // Create department
    const [showCreateDept, setShowCreateDept] = useState(false);
    const [deptForm, setDeptForm] = useState({ name: '', description: '' });

    // Edit department
    const [editingDept, setEditingDept] = useState(null); // dept object
    const [editDeptForm, setEditDeptForm] = useState({ name: '', description: '', business_hours: null });
    const [editDeptError, setEditDeptError] = useState('');
    const [editDeptSaving, setEditDeptSaving] = useState(false);

    const fetchData = async () => {
        try {
            setLoading(true);
            setFetchError(null);
            const [operatorsData, deptsData] = await Promise.all([getOperators(), getDepartments()]);
            setOperators(operatorsData.operators || []);
            setDepartments(deptsData.departments || []);
        } catch (err) {
            setFetchError('Could not load team data. Please refresh the page.');
            console.error('TeamManagement fetch error:', err);
        } finally {
            setLoading(false);
        }
    };

    const fetchPendingInvites = async () => {
        // Legacy operator sessions (X-Operator-Key) can't list invites — the
        // endpoint requires a Client identity via X-API-Key. Skip silently.
        if (isOperator && !isBotManager) return;
        try {
            setPendingInvitesLoading(true);
            const rows = await listOperatorInvites('pending');
            setPendingInvites(Array.isArray(rows) ? rows : []);
        } catch (err) {
            // Non-fatal: pending invites are a management view, not a hard
            // dependency. A failure just hides the section this render.
            console.warn('Failed to load pending invites', err);
            setPendingInvites([]);
        } finally {
            setPendingInvitesLoading(false);
        }
    };

    useEffect(() => { fetchData(); fetchPendingInvites(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Derived rosters scoped to the sidebar-selected bot. Recomputed lazily
    // on every render — both source arrays live in state, so this is O(n)
    // and cheap even for a workspace with hundreds of operators. Kept
    // separate from the workspace-level ``operators`` array so places that
    // reason about the FULL workspace (self-op detection, department
    // counts) can still read the unfiltered list.
    const botScopedOperators = selectedBotId
        ? operators.filter((op) => op.bot_id === selectedBotId)
        : [];
    const botScopedPendingInvites = selectedBotId
        ? pendingInvites.filter((inv) => inv.bot_id === selectedBotId)
        : [];

    // ── Invite Operator (only flow) ──────────────────────────────────────────
    const handleSendInvite = async (e) => {
        e.preventDefault();
        setInviteError('');
        if (!requireLiveChat('add_operator')) return;
        setInviteSubmitting(true);
        try {
            const email = inviteForm.email;
            await createOperatorInvite({
                email,
                role: inviteForm.role,
                departmentId: inviteForm.department_id ? Number(inviteForm.department_id) : null,
            });
            setShowInviteOperator(false);
            setInviteForm({ email: '', role: 'operator', department_id: '' });
            fetchPendingInvites();
            showToast('success', `Invitation sent to ${email}`);
        } catch (err) {
            setInviteError(err.message || 'Failed to send invite');
        } finally {
            setInviteSubmitting(false);
        }
    };

    const handleResendInvite = async (inviteId) => {
        try {
            await resendOperatorInvite(inviteId);
            showToast('success', 'Invitation resent');
            fetchPendingInvites();
        } catch (err) {
            showToast('error', err.message || 'Failed to resend invite');
        }
    };

    const handleRevokeInvite = async (inviteId, email) => {
        if (!window.confirm(`Revoke invitation to ${email}?`)) return;
        try {
            await revokeOperatorInvite(inviteId);
            showToast('success', 'Invitation revoked');
            fetchPendingInvites();
        } catch (err) {
            showToast('error', err.message || 'Failed to revoke invite');
        }
    };

    // ── Self-operator (owner takes chats themselves) ─────────────────────────
    // ``addSelfAsOperator`` is idempotent on the backend. The Team page hides
    // the CTA once a self-operator row exists (the row appears in the operators
    // table below); if the owner later hard-deletes that row via the standard
    // operator delete affordance, ``selfOperatorRow`` becomes null on the next
    // fetchData() and the CTA reappears. No separate "Leave live chat" button
    // is needed — the operators-table Delete is the reversal action.
    const handleAddSelfAsOperator = async () => {
        if (!requireLiveChat('add_operator')) return;
        // Operators are one-to-one with a bot. Bind the new self-operator row
        // to the sidebar-selected bot; if the sidebar hasn't populated yet,
        // refuse cleanly rather than send a bad request the backend will 422.
        if (!selectedBotId) {
            showToast('error', 'Pick a bot in the sidebar first — operators are scoped to a bot.');
            return;
        }
        setSelfOperatorBusy(true);
        try {
            await addSelfAsOperator(selectedBotId);
            fetchData();
            showToast('success', "You're now taking live chats in this workspace");
        } catch (err) {
            showToast('error', err.message || 'Failed to add yourself as an operator');
        } finally {
            setSelfOperatorBusy(false);
        }
    };

    // ── Edit Operator ────────────────────────────────────────────────────────
    const openEditOperator = (op) => {
        setEditingOperator(op);
        setEditOpForm({
            name: op.name,
            email: op.email,
            role: op.role,
            department_id: op.department_id ?? '',
            max_concurrent_chats: op.max_concurrent_chats ?? 3,
        });
        setEditOpError('');
    };

    const handleEditOperator = async (e) => {
        e.preventDefault();
        setEditOpError('');
        setEditOpSaving(true);
        try {
            // Name/email are self-only. When the caller is NOT the operator being
            // edited, we omit those fields from the payload so the backend guard
            // doesn't 403 on an accidental send. Role / department / max chats
            // are always sent — those are the admin-editable fields.
            const isSelfEdit = !!(editingOperator?.linked_client_id && editingOperator.linked_client_id === myClientId);
            const payload = {
                role: editOpForm.role,
                department_id: editOpForm.department_id ? Number(editOpForm.department_id) : null,
                max_concurrent_chats: Number(editOpForm.max_concurrent_chats),
            };
            if (isSelfEdit) {
                payload.name = editOpForm.name.trim();
                payload.email = editOpForm.email.trim().toLowerCase();
            }
            await updateOperator(editingOperator.id, payload);
            const displayName = isSelfEdit ? editOpForm.name : editingOperator.name;
            showToast('success', `Operator "${displayName}" updated`);
            setEditingOperator(null);
            fetchData();
        } catch (err) {
            setEditOpError(err.message || 'Failed to update operator');
        } finally {
            setEditOpSaving(false);
        }
    };

    // ── Delete Operator ──────────────────────────────────────────────────────
    const handleDeleteOperator = async (id, name) => {
        if (!confirm(`Delete operator "${name}"? Their active chats will be unassigned.`)) return;
        try {
            await deleteOperator(id);
            showToast('success', `Operator "${name}" deleted`);
            fetchData();
        } catch (err) {
            showToast('error', err.message || 'Failed to delete operator');
        }
    };

    // ── Create Department ────────────────────────────────────────────────────
    const handleCreateDept = async (e) => {
        e.preventDefault();
        try {
            await createDepartment(deptForm);
            setShowCreateDept(false);
            setDeptForm({ name: '', description: '' });
            fetchData();
            showToast('success', 'Department created');
        } catch (err) {
            showToast('error', err.message || 'Failed to create department');
        }
    };

    // ── Edit Department ──────────────────────────────────────────────────────
    const openEditDept = (dept) => {
        setEditingDept(dept);
        setEditDeptForm({
            name: dept.name,
            description: dept.description || '',
            business_hours: dept.business_hours || null,
        });
        setEditDeptError('');
    };

    const handleEditDept = async (e) => {
        e.preventDefault();
        setEditDeptError('');
        setEditDeptSaving(true);
        try {
            // Send empty object to clear business hours back to "always open"
            // (the backend translates `{}` → null on the column).
            await updateDepartment(editingDept.id, {
                name: editDeptForm.name.trim(),
                description: editDeptForm.description.trim() || null,
                business_hours: editDeptForm.business_hours || {},
            });
            showToast('success', `Department "${editDeptForm.name}" updated`);
            setEditingDept(null);
            fetchData();
        } catch (err) {
            setEditDeptError(err.message || 'Failed to update department');
        } finally {
            setEditDeptSaving(false);
        }
    };

    // ── Delete Department ────────────────────────────────────────────────────
    const handleDeleteDept = async (id, name) => {
        if (!confirm(`Delete department "${name}"? Agents will be unassigned.`)) return;
        try {
            await deleteDepartment(id);
            showToast('success', `Department "${name}" deleted`);
            fetchData();
        } catch (err) {
            showToast('error', err.message || 'Failed to delete department');
        }
    };

    // ── Helpers ──────────────────────────────────────────────────────────────
    const roleIcon = (role) => {
        if (role === 'owner') return <Shield size={14} className="text-amber-500" />;
        if (role === 'admin') return <Shield size={14} className="text-primary-500 dark:text-primary-400" />;
        return <User size={14} className="text-surface-400 dark:text-surface-500" />;
    };

    const getDeptName = (deptId) => departments.find(d => d.id === deptId)?.name ?? '—';

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-50">Team Management</h1>
                <p className="text-surface-500 dark:text-surface-400 text-sm mt-1">Manage your operators and departments for live chat support.</p>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-surface-100 dark:bg-surface-800 rounded-xl p-1 w-fit">
                {[
                    { id: 'operators', label: 'Operators', icon: UsersRound },
                    { id: 'departments', label: 'Departments', icon: Building2 },
                    { id: 'quick-replies', label: 'Quick Replies', icon: MessageSquareText },
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                            'px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5',
                            activeTab === tab.id
                                ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-50 shadow-sm'
                                : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
                        )}
                    >
                        <tab.icon size={14} />
                        {tab.label}
                    </button>
                ))}
            </div>

            {fetchError && (
                <div className="px-4 py-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-xl text-sm text-rose-700 dark:text-rose-300">
                    {fetchError}
                </div>
            )}

            {activeTab === 'quick-replies' ? (
                <CannedResponses embedded />
            ) : loading ? (
                <div className="flex items-center justify-center py-20">
                    <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : activeTab === 'operators' ? (

                /* ── OPERATORS TAB ── */
                <div className="space-y-4">
                    <div className="flex justify-between items-center flex-wrap gap-3">
                        <p className="text-sm text-surface-500 dark:text-surface-400">
                            {botScopedOperators.length} operator{botScopedOperators.length !== 1 ? 's' : ''}
                            {botScopedPendingInvites.length > 0 && (
                                <span className="ml-2 text-surface-400 dark:text-surface-500">
                                    · {botScopedPendingInvites.length} pending
                                </span>
                            )}
                            {selectedBot?.name && (
                                <span className="ml-2 text-surface-400 dark:text-surface-500">
                                    · on <span className="font-medium text-surface-600 dark:text-surface-300">{selectedBot.name}</span>
                                </span>
                            )}
                        </p>
                        {canManageTeam && (
                            <div className="flex items-center gap-2">
                                {/* Primary CTA — email invite (invite-first onboarding).
                                    The invitee signs up on their own; no password
                                    handling on the owner side. */}
                                <button
                                    onClick={() => {
                                        if (!requireLiveChat('add_operator')) return;
                                        setShowInviteOperator(true);
                                        setInviteError('');
                                    }}
                                    className={cn(
                                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                                        liveChatEnabled
                                            ? 'bg-primary-600 hover:bg-primary-700 text-white'
                                            : 'bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm shadow-primary-500/30',
                                    )}
                                >
                                    {liveChatEnabled ? <Send size={14} /> : <Lock size={13} strokeWidth={2.6} />}
                                    Invite operator
                                </button>
                            </div>
                        )}
                    </div>

                    {/* ── Self-operator affordance (workspace owner takes chats) ──
                        Shown ONLY when the owner has no self-operator row yet.
                        Once added, the row lives in the operators table below;
                        deleting it from there brings this card back on the
                        next fetch. No persistent confirmation banner — the
                        operators table is the source of truth for "am I on
                        the roster right now?". */}
                    {canSelfAdd && !hasActiveSelfOperator && (
                        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-4 flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-surface-100 dark:bg-surface-800 flex items-center justify-center shrink-0">
                                <Headphones size={18} className="text-surface-600 dark:text-surface-300" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                                    Handle live chats yourself?
                                </h3>
                                <p className="text-xs text-surface-600 dark:text-surface-400 mt-0.5">
                                    Join the operator roster and take waiting chats directly from{' '}
                                    <Link to="/support" className="text-primary-600 dark:text-primary-400 hover:underline">/support</Link>.
                                    This takes up 1 of your plan&rsquo;s operator seats, same as inviting a teammate.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleAddSelfAsOperator}
                                disabled={selfOperatorBusy}
                                className={cn(
                                    'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors shrink-0',
                                    'bg-surface-900 hover:bg-surface-800 text-white',
                                    'dark:bg-surface-100 dark:hover:bg-white dark:text-surface-900',
                                    selfOperatorBusy && 'opacity-60',
                                )}
                            >
                                {liveChatEnabled ? <Headphones size={14} /> : <Lock size={13} strokeWidth={2.6} />}
                                {selfOperatorBusy ? 'Adding...' : 'Take chats yourself'}
                            </button>
                        </div>
                    )}

                    {/* ── Pending invites section (owner + admin) ───────────
                        Bot-scoped: only invites targeting the currently-
                        selected bot show up so a workspace with dozens of
                        pending invites across bots doesn't drown the surface. */}
                    {canManageTeam && !pendingInvitesLoading && botScopedPendingInvites.length > 0 && (
                        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <Clock size={14} className="text-surface-500" />
                                <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">Pending invitations</h3>
                            </div>
                            <div className="space-y-2">
                                {botScopedPendingInvites.map((inv) => (
                                    <div key={inv.id} className="flex items-center gap-3 py-2 border-b border-surface-100 dark:border-surface-800 last:border-0">
                                        <div className="w-8 h-8 rounded-lg bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
                                            <Mail size={14} className="text-surface-500" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                                                {inv.email}
                                            </div>
                                            <div className="text-xs text-surface-500 truncate">
                                                {inv.role === 'admin' ? 'Admin' : 'Operator'}
                                                {inv.expires_at && (
                                                    // en-GB locale forces DD/MM/YYYY so an owner in India
                                                    // doesn't see a US-style M/D/YYYY that reads as an
                                                    // ambiguous "7/17" — see also `dayjs`/`Intl` docs for
                                                    // the format table this maps to.
                                                    <> · Expires {new Date(inv.expires_at).toLocaleDateString('en-GB')}</>
                                                )}
                                                {inv.resend_count > 0 && (
                                                    <> · Resent {inv.resend_count}×</>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => handleResendInvite(inv.id)}
                                                className="p-1.5 rounded-lg text-surface-500 hover:text-surface-700 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                                                title="Resend invitation"
                                            >
                                                <RotateCcw size={14} />
                                            </button>
                                            <button
                                                onClick={() => handleRevokeInvite(inv.id, inv.email)}
                                                className="p-1.5 rounded-lg text-surface-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                                                title="Revoke invitation"
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ── Invite operator modal ───────────────────────────── */}
                    <AnimatePresence>
                        {canManageTeam && showInviteOperator && (
                            <motion.div
                                initial={{ opacity: 0, y: -8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm p-5"
                            >
                                <div className="flex items-center justify-between mb-4">
                                    <div>
                                        <h3 className="font-bold text-surface-900 dark:text-surface-50">Invite a new operator</h3>
                                        <p className="text-xs text-surface-500 mt-0.5">
                                            They&rsquo;ll get an email with a link to accept and set up their account.
                                        </p>
                                    </div>
                                    <button onClick={() => { setShowInviteOperator(false); setInviteError(''); }} className="text-surface-400 hover:text-surface-600">
                                        <X size={18} />
                                    </button>
                                </div>
                                <form onSubmit={handleSendInvite} className="space-y-3">
                                    <input
                                        type="email"
                                        required
                                        placeholder="Email address"
                                        autoFocus
                                        value={inviteForm.email}
                                        onChange={(e) => setInviteForm((p) => ({ ...p, email: e.target.value }))}
                                        className={inputCls}
                                    />
                                    <div className="grid grid-cols-2 gap-3">
                                        <select
                                            value={inviteForm.role}
                                            onChange={(e) => setInviteForm((p) => ({ ...p, role: e.target.value }))}
                                            className={inputCls}
                                        >
                                            <option value="operator">Operator</option>
                                            <option value="admin">Admin</option>
                                        </select>
                                        <select
                                            value={inviteForm.department_id}
                                            onChange={(e) => setInviteForm((p) => ({ ...p, department_id: e.target.value }))}
                                            className={inputCls}
                                        >
                                            <option value="">Any department</option>
                                            {departments.map((d) => (
                                                <option key={d.id} value={d.id}>{d.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    {inviteError && (
                                        <div className="text-sm text-red-600 dark:text-red-400">{inviteError}</div>
                                    )}
                                    <div className="flex gap-2 pt-2">
                                        <button
                                            type="button"
                                            onClick={() => { setShowInviteOperator(false); setInviteError(''); }}
                                            className="px-4 py-2 text-sm text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-xl"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={inviteSubmitting}
                                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white rounded-xl disabled:opacity-60"
                                        >
                                            {inviteSubmitting ? 'Sending…' : <><Send size={14} /> Send invitation</>}
                                        </button>
                                    </div>
                                </form>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Operators Table */}
                    <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm overflow-hidden">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-surface-100 dark:border-surface-800">
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Operator</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Bot</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Role</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Department</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Status</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Chats</th>
                                    {canManageTeam && (
                                        <th className="text-right px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Actions</th>
                                    )}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                                {botScopedOperators.map((operator) => (
                                    <>
                                        <tr key={operator.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors">
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 flex items-center justify-center text-xs font-bold shrink-0">
                                                        {operator.name.charAt(0).toUpperCase()}
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-medium text-surface-900 dark:text-surface-50">{operator.name}</p>
                                                        <p className="text-xs text-surface-500 dark:text-surface-400">{operator.email}</p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-surface-700 dark:text-surface-300">
                                                {/* Each operator is bound to exactly one bot at invite time
                                                    (``Operator.bot_id``, one-to-one). ``bot_name`` comes
                                                    from the /operators API which joins on Bot for us. */}
                                                {operator.bot_name || '—'}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-1.5">
                                                    {roleIcon(operator.role)}
                                                    <span className="text-sm text-surface-700 dark:text-surface-300 capitalize">{operator.role}</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-surface-600 dark:text-surface-400">{getDeptName(operator.department_id)}</td>
                                            <td className="px-4 py-3">
                                                <span className={cn(
                                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                                                    operator.is_online
                                                        ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                                                        : 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400'
                                                )}>
                                                    <span className={cn('w-1.5 h-1.5 rounded-full', operator.is_online ? 'bg-emerald-500' : 'bg-surface-400 dark:bg-surface-600')} />
                                                    {operator.is_online ? 'Online' : 'Offline'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-surface-600 dark:text-surface-400">{operator.active_chats || 0}</td>
                                            {canManageTeam && (
                                                <td className="px-4 py-3 text-right">
                                                    <div className="flex items-center justify-end gap-1">
                                                        <button
                                                            onClick={() => editingOperator?.id === operator.id ? setEditingOperator(null) : openEditOperator(operator)}
                                                            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-400 hover:text-primary-600 dark:text-surface-500 dark:hover:text-primary-400 transition-colors"
                                                            title="Edit operator"
                                                        >
                                                            <Pencil size={14} />
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteOperator(operator.id, operator.name)}
                                                            className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-rose-400 hover:text-rose-600 dark:text-rose-500 dark:hover:text-rose-400 transition-colors"
                                                            title="Delete operator"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </td>
                                            )}
                                        </tr>

                                        {/* Inline edit row. ``isEditingSelfOp`` gates the name/email
                                            fields — those are personal identity, only the operator
                                            themselves can change them. Everyone else edits role /
                                            department / max chats only. */}
                                        <AnimatePresence>
                                            {editingOperator?.id === operator.id && (() => {
                                                const isEditingSelfOp = !!(
                                                    operator.linked_client_id
                                                    && myClientId
                                                    && operator.linked_client_id === myClientId
                                                );
                                                return (
                                                <tr key={`edit-${operator.id}`}>
                                                    <td colSpan={isBotManager ? 7 : 6} className="px-0 py-0">
                                                        <motion.div
                                                            initial={{ opacity: 0, height: 0 }}
                                                            animate={{ opacity: 1, height: 'auto' }}
                                                            exit={{ opacity: 0, height: 0 }}
                                                            className="overflow-hidden"
                                                        >
                                                            <form
                                                                onSubmit={handleEditOperator}
                                                                className="px-4 py-4 bg-surface-50 dark:bg-surface-800/50 border-t border-surface-100 dark:border-surface-700"
                                                            >
                                                                <p className="text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 mb-3">
                                                                    Edit Operator — {operator.name}
                                                                </p>
                                                                {editOpError && <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{editOpError}</p>}
                                                                {/* Self-edit gate: name + email are personal-identity
                                                                    fields, editable ONLY by the operator themselves.
                                                                    Admins/owners can change role / department / max
                                                                    concurrent chats but not the person's name or email
                                                                    on their behalf — matches how most team tools work
                                                                    (Slack, Linear) and prevents an admin from silently
                                                                    reassigning an invite by editing the email. */}
                                                                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Name</label>
                                                                        <input type="text" required value={editOpForm.name} disabled={!isEditingSelfOp}
                                                                            onChange={(e) => setEditOpForm(p => ({ ...p, name: e.target.value }))}
                                                                            className={cn(inputCls, !isEditingSelfOp && 'opacity-60 cursor-not-allowed')}
                                                                            title={!isEditingSelfOp ? 'Only the operator can change their own name' : undefined} />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Email</label>
                                                                        <input type="email" required value={editOpForm.email} disabled={!isEditingSelfOp}
                                                                            onChange={(e) => setEditOpForm(p => ({ ...p, email: e.target.value }))}
                                                                            className={cn(inputCls, !isEditingSelfOp && 'opacity-60 cursor-not-allowed')}
                                                                            title={!isEditingSelfOp ? 'Only the operator can change their own email' : undefined} />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Role</label>
                                                                        <div className="relative">
                                                                            <select value={editOpForm.role} onChange={(e) => setEditOpForm(p => ({ ...p, role: e.target.value }))} className={cn(inputCls, 'appearance-none pr-9 cursor-pointer')}>
                                                                                {ROLES.map(r => <option key={r} value={r} className="capitalize">{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                                                                            </select>
                                                                            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                                                                        </div>
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Department</label>
                                                                        <div className="relative">
                                                                            <select value={editOpForm.department_id ?? ''} onChange={(e) => setEditOpForm(p => ({ ...p, department_id: e.target.value }))} className={cn(inputCls, 'appearance-none pr-9 cursor-pointer')}>
                                                                                <option value="">No department</option>
                                                                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                                                            </select>
                                                                            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                                                                        </div>
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Max concurrent chats</label>
                                                                        <input type="number" min={1} max={20} value={editOpForm.max_concurrent_chats}
                                                                            onChange={(e) => setEditOpForm(p => ({ ...p, max_concurrent_chats: e.target.value }))} className={inputCls} />
                                                                    </div>
                                                                    <div className="flex items-end gap-2">
                                                                        <button type="submit" disabled={editOpSaving}
                                                                            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white rounded-xl text-sm font-medium transition-colors">
                                                                            {editOpSaving ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <Check size={14} />}
                                                                            Save
                                                                        </button>
                                                                        <button type="button" onClick={() => setEditingOperator(null)}
                                                                            className="px-3 py-2 text-sm text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 transition-colors">
                                                                            Cancel
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </form>
                                                        </motion.div>
                                                    </td>
                                                </tr>
                                                );
                                            })()}
                                        </AnimatePresence>
                                    </>
                                ))}
                                {botScopedOperators.length === 0 && (
                                    <tr>
                                        <td colSpan={isBotManager ? 7 : 6} className="px-4 py-12 text-center text-surface-400 dark:text-surface-500">
                                            <Headphones size={32} className="mx-auto mb-2 opacity-50" />
                                            <p className="font-medium">
                                                {selectedBot?.name
                                                    ? `No operators on ${selectedBot.name} yet`
                                                    : 'No bot selected'}
                                            </p>
                                            <p className="text-xs mt-1">
                                                {selectedBot?.name
                                                    ? 'Invite an operator to handle this bot’s live chats.'
                                                    : 'Pick a bot in the sidebar to see its operators.'}
                                            </p>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            ) : (

                /* ── DEPARTMENTS TAB ── */
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-surface-500 dark:text-surface-400">
                            {departments.length} department{departments.length !== 1 ? 's' : ''}
                        </p>
                        {canManageTeam && (
                            <button
                                onClick={() => {
                                    if (!requireLiveChat('add_department')) return;
                                    setShowCreateDept(true);
                                }}
                                className={cn(
                                    'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                                    liveChatEnabled
                                        ? 'bg-primary-600 hover:bg-primary-700 text-white'
                                        : 'bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm shadow-primary-500/30 hover:shadow-md hover:shadow-primary-500/40',
                                )}
                            >
                                {liveChatEnabled ? <Plus size={15} /> : <Lock size={13} strokeWidth={2.6} />}
                                Add Department
                            </button>
                        )}
                    </div>

                    {/* Create Department Form */}
                    <AnimatePresence>
                        {canManageTeam && showCreateDept && (
                            <motion.div
                                initial={{ opacity: 0, y: -8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm p-5"
                            >
                                <div className="flex items-center justify-between mb-4">
                                    <h3 className="font-bold text-surface-900 dark:text-surface-50">New Department</h3>
                                    <button onClick={() => setShowCreateDept(false)} className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                        <X size={18} />
                                    </button>
                                </div>
                                <form onSubmit={handleCreateDept} className="flex gap-3">
                                    <input type="text" placeholder="Department name *" required
                                        value={deptForm.name} onChange={(e) => setDeptForm(p => ({ ...p, name: e.target.value }))} className={inputCls} />
                                    <input type="text" placeholder="Description (optional)"
                                        value={deptForm.description} onChange={(e) => setDeptForm(p => ({ ...p, description: e.target.value }))} className={inputCls} />
                                    <button type="submit" className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors shrink-0">
                                        Create
                                    </button>
                                </form>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <div className="grid gap-3">
                        {departments.map((dept) => {
                            const deptOperators = operators.filter(a => a.department_id === dept.id);
                            const isEditing = editingDept?.id === dept.id;
                            return (
                                <div key={dept.id} className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm overflow-hidden">
                                    <div className="p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center shrink-0">
                                                <Building2 size={18} className="text-primary-600 dark:text-primary-400" />
                                            </div>
                                            <div>
                                                <h3 className="font-semibold text-surface-900 dark:text-surface-50 text-sm">{dept.name}</h3>
                                                {dept.description && <p className="text-xs text-surface-500 dark:text-surface-400">{dept.description}</p>}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="text-xs text-surface-500 dark:text-surface-400">
                                                {deptOperators.length} operator{deptOperators.length !== 1 ? 's' : ''}
                                            </span>
                                            {canManageTeam && (
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={() => isEditing ? setEditingDept(null) : openEditDept(dept)}
                                                        className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-400 hover:text-primary-600 dark:text-surface-500 dark:hover:text-primary-400 transition-colors"
                                                        title="Edit department"
                                                    >
                                                        <Pencil size={14} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteDept(dept.id, dept.name)}
                                                        className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-rose-400 hover:text-rose-600 dark:text-rose-500 dark:hover:text-rose-400 transition-colors"
                                                        title="Delete department"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Inline edit form */}
                                    <AnimatePresence>
                                        {isEditing && (
                                            <motion.div
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                exit={{ opacity: 0, height: 0 }}
                                                className="overflow-hidden"
                                            >
                                                <form onSubmit={handleEditDept} className="px-4 pb-4 pt-0 border-t border-surface-100 dark:border-surface-800 bg-surface-50 dark:bg-surface-800/40">
                                                    <p className="text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 mt-3 mb-3">Edit Department</p>
                                                    {editDeptError && <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{editDeptError}</p>}
                                                    <div className="flex gap-3 mb-4">
                                                        <input type="text" placeholder="Name *" required value={editDeptForm.name}
                                                            onChange={(e) => setEditDeptForm(p => ({ ...p, name: e.target.value }))} className={inputCls} />
                                                        <input type="text" placeholder="Description"
                                                            value={editDeptForm.description} onChange={(e) => setEditDeptForm(p => ({ ...p, description: e.target.value }))} className={inputCls} />
                                                    </div>

                                                    {/* Per-department business hours — replaces the workspace-wide
                                                        Settings → Business Hours section so Sales (9-6) and Support
                                                        (24/7) can coexist. Saves on form submit alongside name+desc. */}
                                                    <div className="rounded-xl border border-surface-200 dark:border-surface-800 bg-[var(--bg-card)] dark:bg-surface-900 p-4 mb-4">
                                                        <BusinessHoursEditor
                                                            value={editDeptForm.business_hours}
                                                            onChange={(next) => setEditDeptForm(p => ({ ...p, business_hours: next }))}
                                                            disabled={editDeptSaving}
                                                        />
                                                    </div>

                                                    <div className="flex gap-3 justify-end">
                                                        <button type="button" onClick={() => setEditingDept(null)}
                                                            className="px-3 py-2 text-sm text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 transition-colors">
                                                            Cancel
                                                        </button>
                                                        <button type="submit" disabled={editDeptSaving}
                                                            className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white rounded-xl text-sm font-medium transition-colors">
                                                            {editDeptSaving ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <Check size={14} />}
                                                            Save changes
                                                        </button>
                                                    </div>
                                                </form>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>

                                    {/* Operators list */}
                                    {deptOperators.length > 0 && (
                                        <div className="px-4 pb-4 flex flex-wrap gap-2">
                                            {deptOperators.map(a => (
                                                <div key={a.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-50 dark:bg-surface-800 rounded-lg">
                                                    <span className={cn('w-1.5 h-1.5 rounded-full', a.is_online ? 'bg-emerald-500' : 'bg-surface-400 dark:bg-surface-600')} />
                                                    <span className="text-xs text-surface-700 dark:text-surface-300">{a.name}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {departments.length === 0 && (
                            <div className="text-center py-12 text-surface-400 dark:text-surface-500">
                                <Building2 size={32} className="mx-auto mb-2 opacity-50" />
                                <p className="font-medium">No departments yet</p>
                                <p className="text-xs mt-1">Create departments to organize your operators by team.</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
