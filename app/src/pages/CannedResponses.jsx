import { useState, useEffect } from 'react';
import { MessageSquareText, Plus, Pencil, Trash2, Search, Tag, X } from 'lucide-react';
import { getCannedResponses, createCannedResponse, updateCannedResponse, deleteCannedResponse } from '../services/api';

export default function CannedResponses({ embedded = false }) {
    const [responses, setResponses] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('');
    const [showModal, setShowModal] = useState(false);
    const [editingResponse, setEditingResponse] = useState(null);
    const [form, setForm] = useState({ title: '', content: '', shortcut: '', category: '' });

    const fetchResponses = async () => {
        try {
            setLoading(true);
            const data = await getCannedResponses(categoryFilter || null);
            setResponses(data.responses || []);
        } catch {
            // silent
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchResponses(); }, [categoryFilter]); // eslint-disable-line react-hooks/exhaustive-deps

    const categories = [...new Set(responses.map(r => r.category).filter(Boolean))];

    const filteredResponses = responses.filter(r => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (
            r.title.toLowerCase().includes(q) ||
            r.content.toLowerCase().includes(q) ||
            (r.shortcut && r.shortcut.toLowerCase().includes(q))
        );
    });

    const openCreateModal = () => {
        setEditingResponse(null);
        setForm({ title: '', content: '', shortcut: '', category: '' });
        setShowModal(true);
    };

    const openEditModal = (response) => {
        setEditingResponse(response);
        setForm({
            title: response.title,
            content: response.content,
            shortcut: response.shortcut || '',
            category: response.category || '',
        });
        setShowModal(true);
    };

    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!form.title.trim() || !form.content.trim() || submitting) return;

        const payload = {
            title: form.title.trim(),
            content: form.content.trim(),
            shortcut: form.shortcut.trim() || null,
            category: form.category.trim() || null,
        };

        setSubmitting(true);
        try {
            if (editingResponse) {
                await updateCannedResponse(editingResponse.id, payload);
            } else {
                await createCannedResponse(payload);
            }
            setShowModal(false);
            fetchResponses();
        } catch (err) {
            alert(typeof err === 'string' ? err : err?.detail || 'Failed to save response');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this canned response?')) return;
        try {
            await deleteCannedResponse(id);
            fetchResponses();
        } catch (err) {
            alert(typeof err === 'string' ? err : err?.detail || 'Failed to delete response');
        }
    };

    return (
        <div className={embedded ? "max-w-5xl" : "p-6 max-w-5xl mx-auto"}>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                {!embedded && (
                    <div>
                        <h1 className="text-xl font-bold text-surface-900 dark:text-surface-100 flex items-center gap-2">
                            <MessageSquareText className="w-5 h-5" />
                            Canned Responses
                        </h1>
                        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Pre-saved quick replies for live chat agents</p>
                    </div>
                )}
                <button
                    onClick={openCreateModal}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Add Response
                </button>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 relative">
                    <Search className="w-4 h-4 text-surface-400 dark:text-surface-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                        type="text"
                        placeholder="Search responses..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:border-indigo-300 dark:focus:border-indigo-600 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                    />
                </div>
                {categories.length > 0 && (
                    <select
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        className="px-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:border-indigo-300 dark:focus:border-indigo-600"
                    >
                        <option value="">All categories</option>
                        {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                        ))}
                    </select>
                )}
            </div>

            {/* Response list */}
            {loading ? (
                <div className="text-center py-12 text-surface-400 dark:text-surface-500">Loading...</div>
            ) : filteredResponses.length === 0 ? (
                <div className="text-center py-12">
                    <MessageSquareText className="w-10 h-10 text-surface-300 dark:text-surface-600 mx-auto mb-3" />
                    <p className="text-surface-500 dark:text-surface-400 text-sm">
                        {responses.length === 0
                            ? 'No canned responses yet. Create your first one!'
                            : 'No responses match your search.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {filteredResponses.map(response => (
                        <div
                            key={response.id}
                            className="border border-surface-200 dark:border-surface-700 rounded-lg p-4 hover:border-surface-300 dark:hover:border-surface-600 transition-colors bg-white dark:bg-surface-900"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <h3 className="font-semibold text-sm text-surface-900 dark:text-surface-100">{response.title}</h3>
                                        {response.shortcut && (
                                            <span className="px-2 py-0.5 bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400 text-[11px] font-mono rounded">
                                                /{response.shortcut}
                                            </span>
                                        )}
                                        {response.category && (
                                            <span className="flex items-center gap-1 px-2 py-0.5 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[11px] rounded">
                                                <Tag className="w-3 h-3" />
                                                {response.category}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm text-surface-600 dark:text-surface-400 line-clamp-2">{response.content}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => openEditModal(response)}
                                        className="p-1.5 text-surface-400 dark:text-surface-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 rounded transition-colors"
                                        title="Edit"
                                    >
                                        <Pencil className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(response.id)}
                                        className="p-1.5 text-surface-400 dark:text-surface-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded transition-colors"
                                        title="Delete"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Create/Edit Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/50 dark:bg-black/70 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-surface-900 rounded-xl shadow-xl w-full max-w-lg border border-surface-200 dark:border-surface-700">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-100 dark:border-surface-800">
                            <h2 className="font-semibold text-surface-900 dark:text-surface-100">
                                {editingResponse ? 'Edit Response' : 'New Canned Response'}
                            </h2>
                            <button onClick={() => setShowModal(false)} className="text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-5 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">Title *</label>
                                <input
                                    type="text"
                                    value={form.title}
                                    onChange={(e) => setForm(prev => ({ ...prev, title: e.target.value }))}
                                    placeholder="e.g., Greeting"
                                    className="w-full px-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:border-indigo-300 dark:focus:border-indigo-600 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">Content *</label>
                                <textarea
                                    value={form.content}
                                    onChange={(e) => setForm(prev => ({ ...prev, content: e.target.value }))}
                                    placeholder="The message content that will be sent..."
                                    rows={4}
                                    className="w-full px-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:border-indigo-300 dark:focus:border-indigo-600 resize-none placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                    required
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">Shortcut</label>
                                    <div className="flex items-center">
                                        <span className="px-2 py-2 text-sm text-surface-400 dark:text-surface-500 bg-surface-50 dark:bg-surface-800 border border-r-0 border-surface-200 dark:border-surface-700 rounded-l-lg">/</span>
                                        <input
                                            type="text"
                                            value={form.shortcut}
                                            onChange={(e) => setForm(prev => ({ ...prev, shortcut: e.target.value.replace(/\s/g, '') }))}
                                            placeholder="greeting"
                                            className="flex-1 px-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-r-lg bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:border-indigo-300 dark:focus:border-indigo-600 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1">Category</label>
                                    <input
                                        type="text"
                                        value={form.category}
                                        onChange={(e) => setForm(prev => ({ ...prev, category: e.target.value }))}
                                        placeholder="e.g., Sales, Support"
                                        className="w-full px-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:outline-none focus:border-indigo-300 dark:focus:border-indigo-600 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                    />
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowModal(false)}
                                    className="px-4 py-2 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
                                >
                                    {submitting ? 'Saving...' : editingResponse ? 'Update' : 'Create'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
