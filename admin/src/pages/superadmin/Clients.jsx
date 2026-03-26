import React, { useState, useEffect, useRef } from 'react';
import {
    Users as UsersIcon, Loader2, Key, Mail, BuildingIcon, Globe,
    Copy, Check, Trash2, X, AlertCircle, Search
} from 'lucide-react';
import { getClients, deleteClient } from '../../services/api';

export default function SuperadminClients() {
    const [clients, setClients] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [copiedField, setCopiedField] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');

    // Client Details Modal State
    const [selectedClient, setSelectedClient] = useState(null);

    // Delete state
    const [confirmDeleteId, setConfirmDeleteId] = useState(null);
    const [deletingId, setDeletingId] = useState(null);

    // Toast
    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);
    const showToast = (type, message) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ type, message });
        toastTimer.current = setTimeout(() => setToast(null), 4000);
    };
    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    const handleCopy = (text, field) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    };

    const fetchClients = async () => {
        setIsLoading(true);
        try {
            const data = await getClients();
            setClients(data);
        } catch (err) {
            console.error("Failed to fetch clients", err);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchClients();
    }, []);

    const handleDelete = async (clientId, clientName) => {
        setDeletingId(clientId);
        try {
            await deleteClient(clientId);
            showToast('success', `Client "${clientName}" deleted successfully.`);
            setConfirmDeleteId(null);
            // Close modal if this client was being viewed
            if (selectedClient?.id === clientId) {
                setSelectedClient(null);
            }
            // Refresh list
            await fetchClients();
        } catch (err) {
            showToast('error', typeof err === 'string' ? err : 'Failed to delete client');
            setConfirmDeleteId(null);
        } finally {
            setDeletingId(null);
        }
    };

    // Filter clients by search
    const filteredClients = clients.filter(c =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.email.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="space-y-8 animate-slide-up">
            {/* Toast */}
            <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg border transition-all duration-500 ${
                toast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
            } ${
                toast?.type === 'success'
                    ? 'bg-green-50 dark:bg-green-900/90 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/90 border-red-200 dark:border-red-700 text-red-700 dark:text-red-300'
            }`}>
                {toast?.type === 'success' ? <Check size={18} /> : <AlertCircle size={18} />}
                <span className="text-sm font-medium">{toast?.message}</span>
                <button onClick={() => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(null); }}
                    className="ml-2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
                    <X size={14} />
                </button>
            </div>

            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Manage Clients</h1>
                    <p className="text-secondary-500 dark:text-secondary-400 mt-1">View and manage all registered organizations on the platform.</p>
                </div>
                {/* Search */}
                <div className="relative w-full sm:w-72">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary-400" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search clients..."
                        className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-secondary-200 dark:border-secondary-700 bg-white dark:bg-secondary-800 text-secondary-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all"
                    />
                </div>
            </div>

            {/* Clients Table */}
            <div className="bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm overflow-hidden flex flex-col">
                <div className="overflow-x-auto min-h-[400px]">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-secondary-50/50 dark:bg-secondary-900/50 border-b border-secondary-200 dark:border-secondary-700">
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider">Client Organization</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider">Primary Email</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider text-center">Role</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider text-right">Created Date</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-secondary-100 dark:divide-secondary-700/50">
                            {isLoading ? (
                                <tr>
                                    <td colSpan="5" className="py-12 text-center text-secondary-500 dark:text-secondary-400">
                                        <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-500 mb-4" />
                                        Fetching system clients...
                                    </td>
                                </tr>
                            ) : filteredClients.length === 0 ? (
                                <tr>
                                    <td colSpan="5" className="py-12 text-center text-secondary-500 dark:text-secondary-400">
                                        {searchQuery ? 'No clients match your search.' : 'No clients found. You are the only user!'}
                                    </td>
                                </tr>
                            ) : (
                                filteredClients.map((client) => (
                                    <tr
                                        key={client.id}
                                        className={`transition-colors ${!client.is_superadmin ? 'hover:bg-secondary-50/50 dark:hover:bg-secondary-700/20 cursor-pointer' : 'hover:bg-secondary-50/50 dark:hover:bg-secondary-700/20'}`}
                                        onClick={() => !client.is_superadmin && setSelectedClient(client)}
                                    >
                                        <td className="py-4 px-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-9 h-9 rounded-full bg-secondary-100 dark:bg-secondary-800 flex items-center justify-center text-secondary-600 dark:text-secondary-300">
                                                    <BuildingIcon size={16} />
                                                </div>
                                                <span className="font-semibold text-secondary-900 dark:text-white">
                                                    {client.name}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="py-4 px-6 text-secondary-600 dark:text-secondary-300">
                                            {client.email}
                                        </td>
                                        <td className="py-4 px-6 text-center">
                                            {client.is_superadmin ? (
                                                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800/60 uppercase tracking-wider">Superadmin</span>
                                            ) : (
                                                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-secondary-100 dark:bg-secondary-800 text-secondary-600 dark:text-secondary-400 border border-secondary-200 dark:border-secondary-700 uppercase tracking-wider">Client</span>
                                            )}
                                        </td>
                                        <td className="py-4 px-6 text-right text-sm text-secondary-500 dark:text-secondary-400">
                                            {client.created_at ? new Date(client.created_at).toLocaleDateString() : 'N/A'}
                                        </td>
                                        <td className="py-4 px-6 text-center" onClick={(e) => e.stopPropagation()}>
                                            {client.is_superadmin ? (
                                                <span className="text-[10px] text-secondary-400 uppercase tracking-wider">Protected</span>
                                            ) : confirmDeleteId === client.id ? (
                                                <div className="flex items-center justify-center gap-1.5">
                                                    <span className="text-[10px] text-secondary-500 mr-1">Sure?</span>
                                                    <button
                                                        onClick={() => handleDelete(client.id, client.name)}
                                                        disabled={deletingId === client.id}
                                                        className="p-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                                                        title="Confirm delete"
                                                    >
                                                        {deletingId === client.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                                    </button>
                                                    <button
                                                        onClick={() => setConfirmDeleteId(null)}
                                                        className="p-1.5 rounded-lg bg-secondary-100 dark:bg-secondary-700 text-secondary-500 hover:bg-secondary-200 dark:hover:bg-secondary-600 transition-colors"
                                                        title="Cancel"
                                                    >
                                                        <X size={13} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => setConfirmDeleteId(client.id)}
                                                    className="p-1.5 rounded-lg text-secondary-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                                    title="Delete client"
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Client Details Modal */}
            {selectedClient && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-secondary-900/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-secondary-800 rounded-2xl shadow-xl w-full max-w-lg border border-secondary-200 dark:border-secondary-700 overflow-hidden transform transition-all">
                        <div className="p-6">
                            <div className="flex justify-between items-start mb-6">
                                <div>
                                    <h2 className="text-xl font-bold text-secondary-900 dark:text-white flex items-center gap-2">
                                        <BuildingIcon className="w-5 h-5 text-indigo-500" />
                                        {selectedClient.name}
                                    </h2>
                                    <p className="text-sm text-secondary-500 dark:text-secondary-400 mt-1">Client Details</p>
                                </div>
                                <button
                                    onClick={() => setSelectedClient(null)}
                                    className="p-1.5 rounded-lg text-secondary-400 hover:text-secondary-600 dark:hover:text-secondary-200 hover:bg-secondary-100 dark:hover:bg-secondary-700 transition-colors"
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            <div className="space-y-4 mb-8">
                                <div className="p-4 bg-secondary-50 dark:bg-secondary-900/50 rounded-xl border border-secondary-100 dark:border-secondary-700/50 flex flex-col gap-3">
                                    <div className="flex items-start justify-between border-b border-secondary-200 dark:border-secondary-700/50 pb-3">
                                        <div className="text-sm">
                                            <p className="text-secondary-500 dark:text-secondary-400 font-medium mb-0.5">Contact Email</p>
                                            <p className="text-secondary-900 dark:text-white font-semibold flex items-center gap-2">
                                                <Mail className="w-4 h-4 text-secondary-400" />
                                                {selectedClient.email}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start justify-between border-b border-secondary-200 dark:border-secondary-700/50 pb-3">
                                        <div className="text-sm w-full">
                                            <p className="text-secondary-500 dark:text-secondary-400 font-medium mb-0.5">Website</p>
                                            <p className="text-secondary-900 dark:text-white font-semibold flex items-center gap-2">
                                                <Globe className="w-4 h-4 text-secondary-400" />
                                                {selectedClient.website ? (
                                                    <a href={selectedClient.website} target="_blank" rel="noopener noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline">
                                                        {selectedClient.website}
                                                    </a>
                                                ) : 'N/A'}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start justify-between border-b border-secondary-200 dark:border-secondary-700/50 pb-3">
                                        <div className="text-sm">
                                            <p className="text-secondary-500 dark:text-secondary-400 font-medium mb-0.5">Client ID</p>
                                            <p className="text-secondary-900 dark:text-white font-mono text-xs font-semibold bg-white dark:bg-secondary-800 px-2 py-1 rounded border border-secondary-200 dark:border-secondary-700 inline-block mt-1 space-x-2">
                                                <UsersIcon className="w-3.5 h-3.5 inline text-secondary-400" />
                                                <span>{selectedClient.id}</span>
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start justify-between">
                                        <div className="text-sm w-full">
                                            <div className="flex items-center justify-between mb-0.5">
                                                <p className="text-secondary-500 dark:text-secondary-400 font-medium">API Key</p>
                                                {selectedClient.api_key && (
                                                    <button
                                                        onClick={() => handleCopy(selectedClient.api_key, 'api_key')}
                                                        className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 transition-colors"
                                                    >
                                                        {copiedField === 'api_key' ? <Check size={12} /> : <Copy size={12} />}
                                                        <span className="text-[9px] font-bold uppercase">{copiedField === 'api_key' ? 'Copied' : 'Copy'}</span>
                                                    </button>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 mt-1">
                                                <Key className="w-4 h-4 text-amber-500 flex-shrink-0" />
                                                <code className="text-[11px] text-secondary-800 dark:text-secondary-200 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-2 py-1 rounded break-all w-full">
                                                    {selectedClient.api_key || 'Hidden or N/A'}
                                                </code>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Modal Actions */}
                            <div className="flex items-center justify-between gap-3">
                                {/* Delete Button */}
                                {confirmDeleteId === selectedClient.id ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-red-500 font-medium">Delete this client and all data?</span>
                                        <button
                                            onClick={() => handleDelete(selectedClient.id, selectedClient.name)}
                                            disabled={deletingId === selectedClient.id}
                                            className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-xl transition-colors flex items-center gap-2 disabled:opacity-50"
                                        >
                                            {deletingId === selectedClient.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                            Confirm
                                        </button>
                                        <button
                                            onClick={() => setConfirmDeleteId(null)}
                                            className="px-3 py-2 bg-secondary-100 dark:bg-secondary-700 text-secondary-600 dark:text-secondary-300 text-sm font-medium rounded-xl hover:bg-secondary-200 dark:hover:bg-secondary-600 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setConfirmDeleteId(selectedClient.id)}
                                        className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-red-500 hover:text-red-600 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 border border-red-200 dark:border-red-800/50 rounded-xl transition-colors"
                                    >
                                        <Trash2 size={15} />
                                        Delete Client
                                    </button>
                                )}

                                <button
                                    onClick={() => { setSelectedClient(null); setConfirmDeleteId(null); }}
                                    className="px-5 py-2.5 bg-secondary-100 hover:bg-secondary-200 dark:bg-secondary-700 dark:hover:bg-secondary-600 text-secondary-900 dark:text-white font-medium rounded-xl transition-colors"
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
