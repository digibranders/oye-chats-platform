import { useState, useEffect } from 'react';
import { UsersRound, Building2, Plus, Trash2, X, Shield, User, Headphones, MessageSquareText, Eye, EyeOff } from 'lucide-react';
import { getOperators, createOperator, deleteOperator, getDepartments, createDepartment, deleteDepartment } from '../services/api';
import { useToast } from '../context/ToastContext';
import CannedResponses from './CannedResponses';
import { getAuthState } from '../utils/auth';
import { cn } from '../lib/utils';

export default function TeamManagement() {
    const { isOperator, isBotManager } = getAuthState();
    const { showToast } = useToast();

    const [operators, setOperators] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreateOperator, setShowCreateOperator] = useState(false);
    const [showCreateDept, setShowCreateDept] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [operatorForm, setOperatorForm] = useState({ name: '', email: '', password: '', role: 'operator', department_id: '' });
    const [deptForm, setDeptForm] = useState({ name: '', description: '' });
    const [error, setError] = useState('');
    const [fetchError, setFetchError] = useState(null);
    // Regular operators land on Quick Replies — that's their primary use case on this page.
    const [activeTab, setActiveTab] = useState(isOperator && !isBotManager ? 'quick-replies' : 'operators');

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

    const handleCreateOperator = async (e) => {
        e.preventDefault();
        setError('');
        try {
            await createOperator({
                ...operatorForm,
                department_id: operatorForm.department_id ? Number(operatorForm.department_id) : null,
            });
            setShowCreateOperator(false);
            setOperatorForm({ name: '', email: '', password: '', role: 'operator', department_id: '' });
            fetchData();
        } catch (err) {
            setError(err.message || 'Failed to create operator');
        }
    };

    const handleDeleteOperator = async (id, name) => {
        if (!confirm(`Delete operator "${name}"? Their active chats will be unassigned.`)) return;
        try {
            await deleteOperator(id);
            showToast('success', `Operator "${name}" deleted`);
            fetchData();
        } catch (err) {
            console.error('Failed to delete operator:', err);
            showToast('error', err.message || 'Failed to delete operator');
        }
    };

    const handleCreateDept = async (e) => {
        e.preventDefault();
        try {
            await createDepartment(deptForm);
            setShowCreateDept(false);
            setDeptForm({ name: '', description: '' });
            fetchData();
        } catch (err) {
            console.error('Failed to create department:', err);
            showToast('error', err.message || 'Failed to create department');
        }
    };

    const handleDeleteDept = async (id, name) => {
        if (!confirm(`Delete department "${name}"? Agents will be unassigned.`)) return;
        try {
            await deleteDepartment(id);
            showToast('success', `Department "${name}" deleted`);
            fetchData();
        } catch (err) {
            console.error('Failed to delete department:', err);
            showToast('error', err.message || 'Failed to delete department');
        }
    };

    const roleIcon = (role) => {
        if (role === 'owner') return <Shield size={14} className="text-amber-500" />;
        if (role === 'admin') return <Shield size={14} className="text-sky-500 dark:text-sky-400" />;
        return <User size={14} className="text-surface-400 dark:text-surface-500" />;
    };

    const getDeptName = (deptId) => {
        const dept = departments.find(d => d.id === deptId);
        return dept ? dept.name : '—';
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-50">Team Management</h1>
                <p className="text-surface-500 dark:text-surface-400 text-sm mt-1">Manage your operators and departments for live chat support.</p>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-surface-100 dark:bg-surface-800 rounded-xl p-1 w-fit">
                <button
                    onClick={() => setActiveTab('operators')}
                    className={cn(
                        'px-4 py-2 text-sm font-medium rounded-lg transition-all',
                        activeTab === 'operators'
                            ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-50 shadow-sm'
                            : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
                    )}
                >
                    <UsersRound size={15} className="inline mr-1.5 -mt-0.5" /> Operators
                </button>
                <button
                    onClick={() => setActiveTab('departments')}
                    className={cn(
                        'px-4 py-2 text-sm font-medium rounded-lg transition-all',
                        activeTab === 'departments'
                            ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-50 shadow-sm'
                            : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
                    )}
                >
                    <Building2 size={15} className="inline mr-1.5 -mt-0.5" /> Departments
                </button>
                <button
                    onClick={() => setActiveTab('quick-replies')}
                    className={cn(
                        'px-4 py-2 text-sm font-medium rounded-lg transition-all',
                        activeTab === 'quick-replies'
                            ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-50 shadow-sm'
                            : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
                    )}
                >
                    <MessageSquareText size={15} className="inline mr-1.5 -mt-0.5" /> Quick Replies
                </button>
            </div>

            {fetchError && (
                <div className="mb-4 px-4 py-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-xl text-sm text-rose-700 dark:text-rose-300">
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
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-surface-500 dark:text-surface-400">{operators.length} operator{operators.length !== 1 ? 's' : ''}</p>
                        {isBotManager && (
                            <button
                                onClick={() => setShowCreateOperator(true)}
                                className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors"
                            >
                                <Plus size={15} /> Add Operator
                            </button>
                        )}
                    </div>

                    {/* Create Operator Modal — owners/admins only */}
                    {isBotManager && showCreateOperator && (
                        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 p-5">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-bold text-surface-900 dark:text-surface-50">Create New Operator</h3>
                                <button onClick={() => { setShowCreateOperator(false); setError(''); setShowPassword(false); }} className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                    <X size={18} />
                                </button>
                            </div>
                            {error && <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{error}</p>}
                            <form onSubmit={handleCreateOperator} className="grid grid-cols-2 gap-3">
                                <input
                                    type="text" placeholder="Name *" required
                                    value={operatorForm.name} onChange={(e) => setOperatorForm(p => ({ ...p, name: e.target.value }))}
                                    className="px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400"
                                />
                                <input
                                    type="email" placeholder="Email *" required
                                    value={operatorForm.email} onChange={(e) => setOperatorForm(p => ({ ...p, email: e.target.value }))}
                                    className="px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400"
                                />
                                <div className="relative">
                                    <input
                                        type={showPassword ? 'text' : 'password'} placeholder="Password *" required minLength={8}
                                        value={operatorForm.password} onChange={(e) => setOperatorForm(p => ({ ...p, password: e.target.value }))}
                                        className="w-full px-3 py-2 pr-9 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(v => !v)}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                                    >
                                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                                <select
                                    value={operatorForm.department_id} onChange={(e) => setOperatorForm(p => ({ ...p, department_id: e.target.value }))}
                                    className="px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400"
                                >
                                    <option value="">No department</option>
                                    {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                </select>
                                <button type="submit" className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors">
                                    Create Operator
                                </button>
                            </form>
                        </div>
                    )}

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
                                    <tr key={operator.id} className="hover:bg-surface-50 dark:hover:bg-surface-800/50">
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 flex items-center justify-center text-xs font-bold">
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
                                        <td className="px-4 py-3 text-sm text-surface-600 dark:text-surface-400">
                                            {getDeptName(operator.department_id)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={cn(
                                                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                                                operator.is_online
                                                    ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                                                    : 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400'
                                            )}>
                                                <span className={cn(
                                                    'w-1.5 h-1.5 rounded-full',
                                                    operator.is_online ? 'bg-emerald-500' : 'bg-surface-400 dark:bg-surface-600'
                                                )} />
                                                {operator.is_online ? 'Online' : 'Offline'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-surface-600 dark:text-surface-400">
                                            {operator.active_chats || 0}
                                        </td>
                                        {isBotManager && (
                                            <td className="px-4 py-3 text-right">
                                                <button
                                                    onClick={() => handleDeleteOperator(operator.id, operator.name)}
                                                    className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-rose-400 hover:text-rose-600 dark:text-rose-500 dark:hover:text-rose-400 transition-colors"
                                                    title="Delete operator"
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            </td>
                                        )}
                                    </tr>
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
                /* Departments Tab */
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-surface-500 dark:text-surface-400">{departments.length} department{departments.length !== 1 ? 's' : ''}</p>
                        {isBotManager && (
                            <button
                                onClick={() => setShowCreateDept(true)}
                                className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors"
                            >
                                <Plus size={15} /> Add Department
                            </button>
                        )}
                    </div>

                    {isBotManager && showCreateDept && (
                        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 p-5">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-bold text-surface-900 dark:text-surface-50">Create Department</h3>
                                <button onClick={() => setShowCreateDept(false)} className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                    <X size={18} />
                                </button>
                            </div>
                            <form onSubmit={handleCreateDept} className="flex gap-3">
                                <input
                                    type="text" placeholder="Department name *" required
                                    value={deptForm.name} onChange={(e) => setDeptForm(p => ({ ...p, name: e.target.value }))}
                                    className="flex-1 px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400"
                                />
                                <input
                                    type="text" placeholder="Description (optional)"
                                    value={deptForm.description} onChange={(e) => setDeptForm(p => ({ ...p, description: e.target.value }))}
                                    className="flex-1 px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 text-sm outline-none focus:border-primary-500 dark:focus:border-primary-400"
                                />
                                <button type="submit" className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium transition-colors shrink-0">
                                    Create
                                </button>
                            </form>
                        </div>
                    )}

                    <div className="grid gap-3">
                        {departments.map((dept) => {
                            const deptOperators = operators.filter(a => a.department_id === dept.id);
                            return (
                                <div key={dept.id} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 p-4">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-900/30 flex items-center justify-center">
                                                <Building2 size={18} className="text-sky-600 dark:text-sky-400" />
                                            </div>
                                            <div>
                                                <h3 className="font-semibold text-surface-900 dark:text-surface-50 text-sm">{dept.name}</h3>
                                                {dept.description && <p className="text-xs text-surface-500 dark:text-surface-400">{dept.description}</p>}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="text-xs text-surface-500 dark:text-surface-400">{deptOperators.length} operator{deptOperators.length !== 1 ? 's' : ''}</span>
                                            {isBotManager && (
                                                <button
                                                    onClick={() => handleDeleteDept(dept.id, dept.name)}
                                                    className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-rose-400 hover:text-rose-600 dark:text-rose-500 dark:hover:text-rose-400 transition-colors"
                                                    title="Delete department"
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {deptOperators.length > 0 && (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {deptOperators.map(a => (
                                                <div key={a.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-50 dark:bg-surface-800 rounded-lg">
                                                    <span className={cn(
                                                        'w-1.5 h-1.5 rounded-full',
                                                        a.is_online ? 'bg-emerald-500' : 'bg-surface-400 dark:bg-surface-600'
                                                    )} />
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
