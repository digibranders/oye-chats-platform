import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import BusinessHoursEditor from '../components/BusinessHoursEditor';
import {
    UsersRound, Building2, Plus, Trash2, X, Shield, User, Headphones,
    MessageSquareText, Eye, EyeOff, Pencil, Check, ChevronDown, Lock,
} from 'lucide-react';
import {
    getOperators, createOperator, updateOperator, deleteOperator,
    getDepartments, createDepartment, updateDepartment, deleteDepartment,
} from '../services/api';
import { useToast } from '../context/ToastContext';
import { useUpgradeModal } from '../context/UpgradeModalContext';
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
    const [activeTab, setActiveTab] = useState(isOperator && !isBotManager ? 'quick-replies' : 'operators');

    // Create operator
    const [showCreateOperator, setShowCreateOperator] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [operatorForm, setOperatorForm] = useState({ name: '', email: '', password: '', role: 'operator', department_id: '' });
    const [createError, setCreateError] = useState('');

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

    useEffect(() => { fetchData(); }, []);

    // ── Create Operator ──────────────────────────────────────────────────────
    const handleCreateOperator = async (e) => {
        e.preventDefault();
        setCreateError('');
        try {
            await createOperator({
                ...operatorForm,
                department_id: operatorForm.department_id ? Number(operatorForm.department_id) : null,
            });
            setShowCreateOperator(false);
            setOperatorForm({ name: '', email: '', password: '', role: 'operator', department_id: '' });
            fetchData();
            showToast('success', 'Operator created');
        } catch (err) {
            setCreateError(err.message || 'Failed to create operator');
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
            await updateOperator(editingOperator.id, {
                name: editOpForm.name.trim(),
                email: editOpForm.email.trim().toLowerCase(),
                role: editOpForm.role,
                department_id: editOpForm.department_id ? Number(editOpForm.department_id) : null,
                max_concurrent_chats: Number(editOpForm.max_concurrent_chats),
            });
            showToast('success', `Operator "${editOpForm.name}" updated`);
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
        if (role === 'admin') return <Shield size={14} className="text-sky-500 dark:text-sky-400" />;
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
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-surface-500 dark:text-surface-400">
                            {operators.length} operator{operators.length !== 1 ? 's' : ''}
                        </p>
                        {isBotManager && (
                            <button
                                onClick={() => {
                                    if (!requireLiveChat('add_operator')) return;
                                    setShowCreateOperator(true);
                                    setCreateError('');
                                }}
                                className={cn(
                                    'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                                    liveChatEnabled
                                        ? 'bg-primary-600 hover:bg-primary-700 text-white'
                                        : 'bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm shadow-primary-500/30 hover:shadow-md hover:shadow-primary-500/40',
                                )}
                            >
                                {liveChatEnabled ? <Plus size={15} /> : <Lock size={13} strokeWidth={2.6} />}
                                Add Operator
                            </button>
                        )}
                    </div>

                    {/* Create Operator Form */}
                    <AnimatePresence>
                        {isBotManager && showCreateOperator && (
                            <motion.div
                                initial={{ opacity: 0, y: -8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 p-5"
                            >
                                <div className="flex items-center justify-between mb-4">
                                    <h3 className="font-bold text-surface-900 dark:text-surface-50">New Operator</h3>
                                    <button onClick={() => { setShowCreateOperator(false); setCreateError(''); setShowPassword(false); }} className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                        <X size={18} />
                                    </button>
                                </div>
                                {createError && <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{createError}</p>}
                                <form onSubmit={handleCreateOperator} className="grid grid-cols-2 gap-3">
                                    <input type="text" placeholder="Name *" required value={operatorForm.name}
                                        onChange={(e) => setOperatorForm(p => ({ ...p, name: e.target.value }))} className={inputCls} />
                                    <input type="email" placeholder="Email *" required value={operatorForm.email}
                                        onChange={(e) => setOperatorForm(p => ({ ...p, email: e.target.value }))} className={inputCls} />
                                    <div className="relative">
                                        <input type={showPassword ? 'text' : 'password'} placeholder="Password *" required minLength={8}
                                            value={operatorForm.password} onChange={(e) => setOperatorForm(p => ({ ...p, password: e.target.value }))}
                                            className={cn(inputCls, 'pr-9')} />
                                        <button type="button" onClick={() => setShowPassword(v => !v)}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                    </div>
                                    <select value={operatorForm.role} onChange={(e) => setOperatorForm(p => ({ ...p, role: e.target.value }))} className={inputCls}>
                                        {ROLES.map(r => <option key={r} value={r} className="capitalize">{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                                    </select>
                                    <select value={operatorForm.department_id} onChange={(e) => setOperatorForm(p => ({ ...p, department_id: e.target.value }))} className={inputCls}>
                                        <option value="">No department</option>
                                        {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </select>
                                    <button type="submit" className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors">
                                        Create Operator
                                    </button>
                                </form>
                                {/* Business hours nudge — set workspace-wide
                                    in Settings → Live Chat Queue (per-operator
                                    schedules aren't a v1 feature). Helper text
                                    sets the right expectation so admins don't
                                    look for a per-operator hours field that
                                    doesn't exist. */}
                                <p className="col-span-2 mt-3 text-[12px] text-surface-500 dark:text-surface-400">
                                    Business hours and queue behaviour apply to all operators.{' '}
                                    <Link
                                        to="/settings"
                                        className="font-medium text-primary-600 dark:text-primary-400 hover:underline"
                                    >
                                        Configure in Settings → Live Chat
                                    </Link>
                                </p>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Operators Table */}
                    <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 overflow-hidden">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-surface-100 dark:border-surface-800">
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Operator</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Role</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Department</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Status</th>
                                    <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Chats</th>
                                    {isBotManager && (
                                        <th className="text-right px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Actions</th>
                                    )}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                                {operators.map((operator) => (
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
                                            {isBotManager && (
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

                                        {/* Inline edit row */}
                                        <AnimatePresence>
                                            {editingOperator?.id === operator.id && (
                                                <tr key={`edit-${operator.id}`}>
                                                    <td colSpan={isBotManager ? 6 : 5} className="px-0 py-0">
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
                                                                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Name</label>
                                                                        <input type="text" required value={editOpForm.name}
                                                                            onChange={(e) => setEditOpForm(p => ({ ...p, name: e.target.value }))} className={inputCls} />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Email</label>
                                                                        <input type="email" required value={editOpForm.email}
                                                                            onChange={(e) => setEditOpForm(p => ({ ...p, email: e.target.value }))} className={inputCls} />
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Role</label>
                                                                        <select value={editOpForm.role} onChange={(e) => setEditOpForm(p => ({ ...p, role: e.target.value }))} className={inputCls}>
                                                                            {ROLES.map(r => <option key={r} value={r} className="capitalize">{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                                                                        </select>
                                                                    </div>
                                                                    <div>
                                                                        <label className="text-[11px] text-surface-500 dark:text-surface-400 mb-1 block">Department</label>
                                                                        <select value={editOpForm.department_id ?? ''} onChange={(e) => setEditOpForm(p => ({ ...p, department_id: e.target.value }))} className={inputCls}>
                                                                            <option value="">No department</option>
                                                                            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                                                        </select>
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
                                            )}
                                        </AnimatePresence>
                                    </>
                                ))}
                                {operators.length === 0 && (
                                    <tr>
                                        <td colSpan={isBotManager ? 6 : 5} className="px-4 py-12 text-center text-surface-400 dark:text-surface-500">
                                            <Headphones size={32} className="mx-auto mb-2 opacity-50" />
                                            <p className="font-medium">No operators yet</p>
                                            <p className="text-xs mt-1">Create operators to handle live chat conversations.</p>
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
                        {isBotManager && (
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
                        {isBotManager && showCreateDept && (
                            <motion.div
                                initial={{ opacity: 0, y: -8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 p-5"
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
                                <div key={dept.id} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 overflow-hidden">
                                    <div className="p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-900/30 flex items-center justify-center shrink-0">
                                                <Building2 size={18} className="text-sky-600 dark:text-sky-400" />
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
                                            {isBotManager && (
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
                                                    <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-4 mb-4">
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
