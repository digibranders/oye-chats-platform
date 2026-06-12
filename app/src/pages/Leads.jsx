import React, { useState, useEffect } from 'react';
import { Target, Download, X, Loader2, User, Mail, Phone, Building2, MapPin, Monitor, MessageCircle, Search, ChevronRight, ChevronDown, Tag, FileText, CheckSquare, Square, Trash2, CheckCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { RadialBarChart, RadialBar, ResponsiveContainer, Tooltip as ReTooltip } from 'recharts';
import { getLeads, getLeadDetail, getLeadStats, exportLeadsCsv, markLeadViewed, markAllLeadsViewed } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';

const STATUS_CONFIG = {
    unqualified: { label: 'Unqualified', color: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400' },
    mql: { label: 'MQL', color: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400' },
    sal: { label: 'SAL', color: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400' },
    sql: { label: 'SQL', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' },
    // backward-compat aliases
    cold: { label: 'Unqualified', color: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400' },
    warm: { label: 'MQL', color: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400' },
    hot: { label: 'SAL', color: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400' },
    qualified: { label: 'SQL', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' },
};

const BANT_LABELS = { need: 'Need', budget: 'Budget', authority: 'Authority', timeline: 'Timeline' };

// Contact-type filter options for the leads list. Default is ``named`` so the
// page opens with identified contacts surfaced first — anonymous chats are a
// secondary view operators opt into.
const CONTACT_FILTERS = [
    { value: 'named', label: 'Named contacts' },
    { value: 'anonymous', label: 'Anonymous' },
    { value: 'all', label: 'All contacts' },
];

const hasContactName = (lead) => Boolean(lead?.contact?.name && lead.contact.name.trim() !== '');

export default function Leads() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [leads, setLeads] = useState([]);
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    // Default to ``named`` so the page opens with identified leads only;
    // operators can flip to ``anonymous`` or ``all`` from the search-bar
    // dropdown.
    const [contactFilter, setContactFilter] = useState('named');
    const [selectedLead, setSelectedLead] = useState(null);
    const [leadDetail, setLeadDetail] = useState(null);
    const [isDetailLoading, setIsDetailLoading] = useState(false);
    // Chat-only drawer (lighter-weight than the full lead drawer — surfaces
    // just the conversation, with the same getLeadDetail payload reused).
    const [chatLead, setChatLead] = useState(null);
    const [chatDetail, setChatDetail] = useState(null);
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [notesByLead, setNotesByLead] = useState(() => {
        try { return JSON.parse(localStorage.getItem('lead_notes') || '{}'); } catch { return {}; }
    });
    const [tagsByLead, setTagsByLead] = useState(() => {
        try { return JSON.parse(localStorage.getItem('lead_tags') || '{}'); } catch { return {}; }
    });
    const [noteInput, setNoteInput] = useState('');
    const [tagInput, setTagInput] = useState('');

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [leadsData, statsData] = await Promise.all([
                getLeads(selectedBot?.id, { limit: 200 }),
                getLeadStats(selectedBot?.id),
            ]);
            setLeads(leadsData.leads || []);
            setStats(statsData);
        } catch (error) {
            console.error('Failed to load leads:', error);
            showToast('error', error.message || 'Failed to load leads');
        } finally {
            setIsLoading(false);
        }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchData(); }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Leads" description="Create a chatbot first to start capturing and qualifying leads." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const handleViewLead = async (sessionId) => {
        setSelectedLead(sessionId);
        setIsDetailLoading(true);
        // Optimistically clear unread for this row and decrement stats so the
        // sidebar badge feels instant. Server is the source of truth on next poll.
        const wasUnread = leads.find((l) => l.session_id === sessionId)?.unread === true;
        if (wasUnread) {
            setLeads((prev) => prev.map((l) => (l.session_id === sessionId ? { ...l, unread: false } : l)));
            setStats((prev) => (prev ? { ...prev, unread: Math.max((prev.unread || 0) - 1, 0) } : prev));
            // Fire-and-forget: idempotent endpoint, never blocks drawer open.
            markLeadViewed(sessionId).catch(() => { /* non-critical */ });
        }
        try {
            setLeadDetail(await getLeadDetail(sessionId));
        } catch (error) {
            console.error('Failed to load lead detail:', error);
            showToast('error', error.message || 'Failed to load lead details');
        } finally {
            setIsDetailLoading(false);
        }
    };

    const handleViewChat = async (sessionId) => {
        setChatLead(sessionId);
        setIsChatLoading(true);
        // Clear unread on chat-open too — operators reading the conversation
        // counts as "viewed" for badge purposes, same as opening the full lead.
        const wasUnread = leads.find((l) => l.session_id === sessionId)?.unread === true;
        if (wasUnread) {
            setLeads((prev) => prev.map((l) => (l.session_id === sessionId ? { ...l, unread: false } : l)));
            setStats((prev) => (prev ? { ...prev, unread: Math.max((prev.unread || 0) - 1, 0) } : prev));
            markLeadViewed(sessionId).catch(() => { /* non-critical */ });
        }
        try {
            setChatDetail(await getLeadDetail(sessionId));
        } catch (error) {
            console.error('Failed to load chat history:', error);
            showToast('error', error.message || 'Failed to load chat history');
        } finally {
            setIsChatLoading(false);
        }
    };

    const closeChatDrawer = () => { setChatLead(null); setChatDetail(null); };

    const hasUnreadLeads = leads.some((l) => l.unread === true);

    const handleMarkAllRead = async () => {
        if (!hasUnreadLeads) return;
        // Optimistic UI — snap to zero immediately. On failure we toast and
        // let the 60s sidebar poll reconcile; a full list refetch just to
        // undo optimism is an expensive round-trip for a rare error.
        const prevLeads = leads;
        const prevStats = stats;
        setLeads((current) => current.map((l) => ({ ...l, unread: false })));
        setStats((current) => (current ? { ...current, unread: 0 } : current));
        try {
            await markAllLeadsViewed(selectedBot?.id);
        } catch (error) {
            console.error('Failed to mark all leads read:', error);
            showToast('error', error.message || 'Failed to mark leads as read');
            // Roll back optimistic mutation so the UI matches server truth.
            setLeads(prevLeads);
            setStats(prevStats);
        }
    };

    const handleExport = async () => {
        setIsExporting(true);
        try {
            await exportLeadsCsv(selectedBot?.id);
        } catch (error) {
            console.error('Export failed:', error);
            showToast('error', error.message || 'Failed to export leads CSV');
        } finally {
            setIsExporting(false);
        }
    };

    const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    const saveNote = (sessionId) => {
        const updated = { ...notesByLead, [sessionId]: { text: noteInput, ts: new Date().toISOString() } };
        setNotesByLead(updated);
        localStorage.setItem('lead_notes', JSON.stringify(updated));
    };

    const saveTags = (sessionId, raw) => {
        const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
        const updated = { ...tagsByLead, [sessionId]: tags };
        setTagsByLead(updated);
        localStorage.setItem('lead_tags', JSON.stringify(updated));
    };

    const toggleSelect = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const exportSelected = async () => {
        const ids = Array.from(selectedIds);
        const selectedLeads = leads.filter(l => ids.includes(l.session_id));
        const csv = ['Session ID,Name,Email,Score,Status,Location,Last Active']
            .concat(selectedLeads.map(l => [
                l.session_id,
                l.contact?.name || '',
                l.contact?.email || '',
                l.score,
                l.status,
                (l.location || '').replace(/,/g, ''),
                formatDate(l.last_active_at),
            ].join(',')))
            .join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'selected-leads.csv'; a.click();
        URL.revokeObjectURL(url);
        setSelectedIds(new Set());
    };

    const filtered = leads.filter(l => {
        if (statusFilter) {
            // Handle both legacy (cold/warm/hot/qualified) and BANT (unqualified/mql/sal/sql) status names
            const LEGACY_TO_BANT = { cold: 'unqualified', warm: 'mql', hot: 'sal', qualified: 'sql' };
            const normalized = LEGACY_TO_BANT[statusFilter] || statusFilter;
            const leadNormalized = LEGACY_TO_BANT[l.status] || l.status;
            if (leadNormalized !== normalized) return false;
        }
        if (contactFilter === 'named' && !hasContactName(l)) return false;
        if (contactFilter === 'anonymous' && hasContactName(l)) return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const name = l.contact?.name?.toLowerCase() || '';
            const email = l.contact?.email?.toLowerCase() || '';
            const loc = l.location?.toLowerCase() || '';
            if (!name.includes(q) && !email.includes(q) && !loc.includes(q) && !l.session_id.toLowerCase().includes(q)) return false;
        }
        return true;
    });

    // Counts power the dropdown labels so operators see how many leads each
    // option will reveal without flipping through them. Status + search are
    // already applied; contact filter is the only thing we vary.
    const contactCounts = leads.reduce(
        (acc, l) => {
            const named = hasContactName(l);
            acc.all += 1;
            if (named) acc.named += 1; else acc.anonymous += 1;
            return acc;
        },
        { all: 0, named: 0, anonymous: 0 }
    );

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
                <PageHeader title="Leads" subtitle="Track and qualify your sales leads with BANT scoring" />
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleMarkAllRead}
                        disabled={!hasUnreadLeads}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-surface-700 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={hasUnreadLeads ? 'Mark every unread lead as read' : 'No unread leads'}
                    >
                        <CheckCheck className="w-4 h-4" />
                        Mark all as read
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={isExporting || leads.length === 0}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-surface-700 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors disabled:opacity-50"
                    >
                        {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        Export CSV
                    </button>
                </div>
            </div>

            {/* Stats Cards */}
            {stats && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                        { label: 'Total', value: stats.total, color: 'text-surface-900 dark:text-surface-100' },
                        { label: 'Cold', value: stats.cold, color: 'text-sky-600 dark:text-sky-400' },
                        { label: 'Warm', value: stats.warm, color: 'text-yellow-600 dark:text-yellow-400' },
                        { label: 'Hot', value: stats.hot, color: 'text-orange-600 dark:text-orange-400' },
                        { label: 'Qualified', value: stats.qualified, color: 'text-emerald-600 dark:text-emerald-400' },
                    ].map(s => (
                        <button
                            key={s.label}
                            onClick={() => setStatusFilter(s.label === 'Total' ? null : s.label.toLowerCase())}
                            className={cn(
                                'p-4 rounded-xl border transition-all',
                                (statusFilter === s.label.toLowerCase() || (!statusFilter && s.label === 'Total'))
                                    ? 'border-primary-300 dark:border-primary-500/40 bg-primary-50 dark:bg-primary-500/10 ring-1 ring-primary-200 dark:ring-primary-500/30'
                                    : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 hover:border-surface-300 dark:hover:border-surface-600'
                            )}
                        >
                            <p className="text-[12px] font-medium text-surface-500 dark:text-surface-400">{s.label}</p>
                            <p className={cn('text-2xl font-bold', s.color)}>{s.value}</p>
                        </button>
                    ))}
                </div>
            )}

            {/* Search + contact-type filter. The filter is wired to the same
                row so operators see "what am I searching across?" alongside
                the input rather than as a separate control. */}
            <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                    <input
                        type="text"
                        placeholder="Search by name, email, or location..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-2.5 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-xl focus:outline-none focus:border-primary-400 dark:focus:border-primary-500 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                    />
                </div>
                <div className="relative sm:w-56">
                    <select
                        value={contactFilter}
                        onChange={(e) => setContactFilter(e.target.value)}
                        aria-label="Filter by contact type"
                        className="w-full appearance-none pl-3 pr-9 py-2.5 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-xl focus:outline-none focus:border-primary-400 dark:focus:border-primary-500 cursor-pointer"
                    >
                        {CONTACT_FILTERS.map((opt) => {
                            const count = contactCounts[opt.value] ?? 0;
                            return (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label} ({count})
                                </option>
                            );
                        })}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                </div>
            </div>

            {/* Bulk action toolbar */}
            <AnimatePresence>
                {selectedIds.size > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="flex items-center gap-3 p-3.5 bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/30 rounded-xl"
                    >
                        <span className="text-sm font-medium text-primary-700 dark:text-primary-300">{selectedIds.size} selected</span>
                        <button
                            onClick={exportSelected}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-surface-900 border border-primary-300 dark:border-primary-500/40 text-primary-700 dark:text-primary-300 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors"
                        >
                            <Download size={13} /> Export selected
                        </button>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="ml-auto text-xs text-primary-500 dark:text-primary-400 hover:underline"
                        >
                            Clear
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Leads Table */}
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                {isLoading ? (
                    <SkeletonTable rows={8} cols={6} />
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-surface-500 dark:text-surface-400 space-y-3">
                        {leads.length === 0 ? (
                            <p>No leads yet. Leads are created when visitors chat with your bot.</p>
                        ) : contactFilter === 'named' && contactCounts.named === 0 && contactCounts.anonymous > 0 ? (
                            <>
                                <p>No named contacts yet — you have {contactCounts.anonymous} anonymous chat{contactCounts.anonymous === 1 ? '' : 's'}.</p>
                                <button
                                    type="button"
                                    onClick={() => setContactFilter('anonymous')}
                                    className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
                                >
                                    Show anonymous chats
                                </button>
                            </>
                        ) : (
                            <p>No leads match your filters.</p>
                        )}
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-surface-100 dark:border-surface-800">
                                <th className="px-4 py-3 w-10">
                                    <button onClick={() => setSelectedIds(selectedIds.size === filtered.length ? new Set() : new Set(filtered.map(l => l.session_id)))}>
                                        {selectedIds.size === filtered.length && filtered.length > 0
                                            ? <CheckSquare size={15} className="text-primary-500" />
                                            : <Square size={15} className="text-surface-400 dark:text-surface-500" />}
                                    </button>
                                </th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Contact</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Score</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Status</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">BANT</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Location</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Last Active</th>
                                <th className="px-4 py-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((lead) => {
                                const sc = STATUS_CONFIG[lead.status] || STATUS_CONFIG.cold;
                                return (
                                    <tr
                                        key={lead.session_id}
                                        className="border-b border-surface-50 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50 cursor-pointer transition-colors"
                                    >
                                        <td className="px-4 py-3" onClick={(e) => { e.stopPropagation(); toggleSelect(lead.session_id); }}>
                                            {selectedIds.has(lead.session_id)
                                                ? <CheckSquare size={15} className="text-primary-500" />
                                                : <Square size={15} className="text-surface-400 dark:text-surface-500" />}
                                        </td>
                                        <td className="px-4 py-3" onClick={() => handleViewLead(lead.session_id)}>
                                            <div className="flex items-start gap-2">
                                                {lead.unread && (
                                                    <span
                                                        className="mt-1.5 w-2 h-2 rounded-full bg-primary-500 shrink-0"
                                                        title="Unread lead"
                                                        aria-label="Unread lead"
                                                    />
                                                )}
                                                <div>
                                                    <p className={cn(
                                                        'text-surface-900 dark:text-surface-100',
                                                        lead.unread ? 'font-semibold' : 'font-medium'
                                                    )}>
                                                        {lead.contact?.name || 'Anonymous'}
                                                    </p>
                                                    {lead.contact?.email && (
                                                        <p className="text-[12px] text-surface-500 dark:text-surface-400">{lead.contact.email}</p>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3" onClick={() => handleViewLead(lead.session_id)}>
                                            <div className="flex items-center gap-2">
                                                <div className="w-12 h-2 bg-surface-100 dark:bg-surface-700 rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full transition-all"
                                                        style={{
                                                            width: `${lead.score}%`,
                                                            backgroundColor: lead.score >= 75 ? '#22c55e' : lead.score >= 50 ? '#f97316' : lead.score >= 25 ? '#eab308' : '#94a3b8',
                                                        }}
                                                    />
                                                </div>
                                                <span
                                                    className="text-[12px] font-bold text-surface-700 dark:text-surface-300"
                                                    title={`BANT: ${lead.bant_score ?? lead.score}${lead.behavioral_score ? ` + Behavioral: ${lead.behavioral_score}` : ''}`}
                                                >
                                                    {lead.score}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3" onClick={() => handleViewLead(lead.session_id)}>
                                            <span className={cn('px-2.5 py-1 rounded-full text-[11px] font-bold', sc.color)}>
                                                {sc.label}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3" onClick={() => handleViewLead(lead.session_id)}>
                                            <div className="flex gap-1">
                                                {Object.entries(BANT_LABELS).map(([key, label]) => (
                                                    <span
                                                        key={key}
                                                        className={cn(
                                                            'w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center',
                                                            (lead.bant?.[key]?.score || 0) > 0
                                                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                                                                : 'bg-surface-100 text-surface-400 dark:bg-surface-800 dark:text-surface-500'
                                                        )}
                                                        title={`${label}: ${lead.bant?.[key]?.value || 'Not captured'} (${lead.bant?.[key]?.score || 0}/25)`}
                                                    >
                                                        {label[0]}
                                                    </span>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-[12px] text-surface-600 dark:text-surface-400 max-w-[120px] truncate" onClick={() => handleViewLead(lead.session_id)}>
                                            {(lead.location || '').replace(/\s*\|.*$/, '') || '—'}
                                        </td>
                                        <td className="px-4 py-3 text-[12px] text-surface-500 dark:text-surface-400" onClick={() => handleViewLead(lead.session_id)}>
                                            {formatDate(lead.last_active_at)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center justify-end gap-1">
                                                <button
                                                    type="button"
                                                    onClick={(e) => { e.stopPropagation(); handleViewChat(lead.session_id); }}
                                                    title="View chat history"
                                                    aria-label="View chat history"
                                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10 border border-primary-200/60 dark:border-primary-500/30 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors"
                                                >
                                                    <MessageCircle size={12} />
                                                    View chat
                                                </button>
                                                <ChevronRight className="w-4 h-4 text-surface-400 dark:text-surface-500" />
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Lead Detail Drawer */}
            <AnimatePresence>
                {selectedLead && (
                    <div className="fixed inset-0 z-50 flex justify-end" onClick={() => { setSelectedLead(null); setLeadDetail(null); }}>
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="absolute inset-0 bg-black/30 dark:bg-black/50"
                        />
                        <motion.div
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                            className="relative w-full max-w-lg bg-white dark:bg-surface-900 shadow-2xl overflow-y-auto"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Drawer Header */}
                            <div className="sticky top-0 z-10 bg-white dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800 px-6 py-4 flex items-center justify-between">
                                <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100">Lead Detail</h2>
                                <button onClick={() => { setSelectedLead(null); setLeadDetail(null); }} className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            {isDetailLoading ? (
                                <div className="flex items-center justify-center p-12">
                                    <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
                                </div>
                            ) : leadDetail ? (
                                <div className="p-6 space-y-6">
                                    {/* Contact Info */}
                                    <div className="space-y-3">
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Contact</h3>
                                        <div className="bg-surface-50 dark:bg-surface-800 rounded-xl p-4 space-y-2">
                                            {leadDetail.contact?.name && <div className="flex items-center gap-2 text-sm text-surface-900 dark:text-surface-100"><User className="w-4 h-4 text-surface-400 dark:text-surface-500" /><span>{leadDetail.contact.name}</span></div>}
                                            {leadDetail.contact?.email && <div className="flex items-center gap-2 text-sm text-surface-900 dark:text-surface-100"><Mail className="w-4 h-4 text-surface-400 dark:text-surface-500" /><span>{leadDetail.contact.email}</span></div>}
                                            {leadDetail.contact?.phone && <div className="flex items-center gap-2 text-sm text-surface-900 dark:text-surface-100"><Phone className="w-4 h-4 text-surface-400 dark:text-surface-500" /><span>{leadDetail.contact.phone}</span></div>}
                                            {leadDetail.contact?.company && <div className="flex items-center gap-2 text-sm text-surface-900 dark:text-surface-100"><Building2 className="w-4 h-4 text-surface-400 dark:text-surface-500" /><span>{leadDetail.contact.company}</span></div>}
                                            {!leadDetail.contact && <p className="text-sm text-surface-400 dark:text-surface-500">No contact info captured</p>}
                                        </div>
                                    </div>

                                    {/* Score + Status with RadialBar gauge */}
                                    <div className="flex items-center gap-4">
                                        <div className="w-24 h-24 shrink-0">
                                            <ResponsiveContainer width="100%" height="100%">
                                                <RadialBarChart cx="50%" cy="50%" innerRadius="60%" outerRadius="100%" data={[{ value: leadDetail.score, fill: leadDetail.score >= 75 ? '#22c55e' : leadDetail.score >= 50 ? '#f97316' : leadDetail.score >= 25 ? '#eab308' : '#94a3b8' }]} startAngle={90} endAngle={-270}>
                                                    <RadialBar dataKey="value" cornerRadius={6} background={{ fill: 'rgba(148,163,184,0.15)' }} />
                                                </RadialBarChart>
                                            </ResponsiveContainer>
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-[12px] font-bold text-surface-500 dark:text-surface-400 mb-1">BANT Score</p>
                                            <p className="text-3xl font-bold text-surface-900 dark:text-surface-100 leading-none">{leadDetail.score}<span className="text-sm text-surface-400 font-normal">/100</span></p>
                                            <span className={cn('inline-block mt-2 px-3 py-1 rounded-full text-[12px] font-bold', STATUS_CONFIG[leadDetail.status]?.color)}>
                                                {STATUS_CONFIG[leadDetail.status]?.label}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Tags */}
                                    <div className="space-y-2">
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400 flex items-center gap-1.5">
                                            <Tag size={12} /> Tags
                                        </h3>
                                        <div className="flex flex-wrap gap-1.5 mb-2">
                                            {(tagsByLead[selectedLead] || []).map(tag => (
                                                <span key={tag} className="px-2.5 py-0.5 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300 text-[11px] font-medium rounded-full border border-primary-200 dark:border-primary-500/30">
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                        <input
                                            type="text"
                                            placeholder="Add tags (comma-separated)"
                                            value={tagInput}
                                            onChange={(e) => setTagInput(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { saveTags(selectedLead, tagInput); setTagInput(''); } }}
                                            className="w-full px-3 py-2 text-xs bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 focus:outline-none focus:border-primary-400"
                                        />
                                        <p className="text-[10px] text-surface-400">Press Enter to save</p>
                                    </div>

                                    {/* Notes */}
                                    <div className="space-y-2">
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400 flex items-center gap-1.5">
                                            <FileText size={12} /> Notes
                                        </h3>
                                        {notesByLead[selectedLead] && (
                                            <div className="p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg text-xs text-surface-700 dark:text-surface-300 mb-2">
                                                <p>{notesByLead[selectedLead].text}</p>
                                                <p className="text-[10px] text-surface-400 mt-1">{new Date(notesByLead[selectedLead].ts).toLocaleDateString()}</p>
                                            </div>
                                        )}
                                        <textarea
                                            rows={3}
                                            placeholder="Add a note about this lead..."
                                            value={noteInput}
                                            onChange={(e) => setNoteInput(e.target.value)}
                                            className="w-full px-3 py-2 text-xs bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 focus:outline-none focus:border-primary-400 resize-none"
                                        />
                                        <button
                                            onClick={() => { saveNote(selectedLead); setNoteInput(''); }}
                                            disabled={!noteInput.trim()}
                                            className="px-3 py-1.5 text-xs font-medium bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors disabled:opacity-40"
                                        >
                                            Save note
                                        </button>
                                    </div>

                                    {/* BANT Breakdown */}
                                    <div className="space-y-3">
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">BANT Qualification</h3>
                                        <div className="space-y-2">
                                            {Object.entries(BANT_LABELS).map(([key, label]) => {
                                                const dimScore = leadDetail.bant?.[key]?.score || 0;
                                                const dimValue = leadDetail.bant?.[key]?.value;
                                                return (
                                                    <div key={key} className="bg-surface-50 dark:bg-surface-800 rounded-lg px-4 py-3">
                                                        <div className="flex items-center justify-between mb-1">
                                                            <span className="text-[12px] font-bold text-surface-600 dark:text-surface-300">{label}</span>
                                                            <span className="text-[11px] font-bold text-surface-500 dark:text-surface-400">{dimScore}/25</span>
                                                        </div>
                                                        <div className="w-full bg-surface-200 dark:bg-surface-700 rounded-full h-1.5 mb-1.5">
                                                            <div
                                                                className={cn(
                                                                    'h-1.5 rounded-full transition-all',
                                                                    dimScore >= 20 ? 'bg-emerald-500' : dimScore >= 10 ? 'bg-sky-500' : dimScore > 0 ? 'bg-amber-400' : 'bg-surface-300 dark:bg-surface-600'
                                                                )}
                                                                style={{ width: `${(dimScore / 25) * 100}%` }}
                                                            />
                                                        </div>
                                                        {dimValue && (
                                                            <p className="text-sm text-surface-700 dark:text-surface-300">{dimValue}</p>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        {/* Signal evidence trail */}
                                        {leadDetail.signals?.length > 0 && (
                                            <div className="mt-4">
                                                <h4 className="text-[12px] font-bold text-surface-500 dark:text-surface-400 mb-2">Evidence Trail</h4>
                                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                                    {leadDetail.signals.map((s, i) => (
                                                        <div key={i} className="bg-white dark:bg-surface-900 border border-surface-100 dark:border-surface-700 rounded-lg px-3 py-2">
                                                            <div className="flex items-center gap-2 mb-1">
                                                                <span className="text-[10px] font-bold uppercase text-surface-400 dark:text-surface-500">{s.dimension}</span>
                                                                <span className={cn(
                                                                    'text-[9px] px-1.5 py-0.5 rounded-full font-bold',
                                                                    s.confidence === 'high'
                                                                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                                                                        : s.confidence === 'medium'
                                                                            ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400'
                                                                            : 'bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400'
                                                                )}>{s.confidence}</span>
                                                                <span className="text-[10px] text-surface-400 dark:text-surface-500 ml-auto">{s.score_before} → {s.score_after}</span>
                                                            </div>
                                                            <p className="text-[12px] text-surface-600 dark:text-surface-400 italic">&ldquo;{s.signal_text}&rdquo;</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {(leadDetail.behavioral_score > 0 || leadDetail.behavioral?.page_url) && (
                                        <div className="space-y-3">
                                            <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Behavioral Signals</h3>
                                            <div className="bg-surface-50 dark:bg-surface-800 rounded-xl p-4 space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[12px] font-medium text-surface-600 dark:text-surface-400">Engagement Score</span>
                                                    <span className="text-[12px] font-bold text-surface-900 dark:text-surface-100">{leadDetail.behavioral_score || 0}/20</span>
                                                </div>
                                                <div className="w-full bg-surface-200 dark:bg-surface-700 rounded-full h-1.5">
                                                    <div
                                                        className={cn(
                                                            'h-1.5 rounded-full transition-all',
                                                            (leadDetail.behavioral_score || 0) >= 15
                                                                ? 'bg-emerald-500'
                                                                : (leadDetail.behavioral_score || 0) >= 8
                                                                    ? 'bg-sky-500'
                                                                    : 'bg-amber-400'
                                                        )}
                                                        style={{ width: `${Math.min(((leadDetail.behavioral_score || 0) / 20) * 100, 100)}%` }}
                                                    />
                                                </div>
                                                {leadDetail.behavioral?.page_url && (
                                                    <div className="flex items-start gap-2 text-[12px]">
                                                        <span className="text-surface-400 dark:text-surface-500 shrink-0">Page:</span>
                                                        <span className="text-surface-700 dark:text-surface-300 break-all">
                                                            {leadDetail.behavioral.page_url.length > 80
                                                                ? leadDetail.behavioral.page_url.substring(0, 80) + '...'
                                                                : leadDetail.behavioral.page_url}
                                                        </span>
                                                    </div>
                                                )}
                                                {leadDetail.behavioral?.referrer && (
                                                    <div className="flex items-start gap-2 text-[12px]">
                                                        <span className="text-surface-400 dark:text-surface-500 shrink-0">Referrer:</span>
                                                        <span className="text-surface-700 dark:text-surface-300 break-all">
                                                            {leadDetail.behavioral.referrer.length > 80
                                                                ? leadDetail.behavioral.referrer.substring(0, 80) + '...'
                                                                : leadDetail.behavioral.referrer}
                                                        </span>
                                                    </div>
                                                )}
                                                {leadDetail.behavioral?.utm_params && Object.keys(leadDetail.behavioral.utm_params).length > 0 && (
                                                    <div className="text-[12px]">
                                                        <span className="text-surface-400 dark:text-surface-500">UTM:</span>
                                                        <div className="flex flex-wrap gap-1 mt-1">
                                                            {Object.entries(leadDetail.behavioral.utm_params).map(([k, v]) => (
                                                                <span key={k} className="px-2 py-0.5 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded text-[10px] text-surface-600 dark:text-surface-400">
                                                                    {k}: {v}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {(leadDetail.behavioral?.visit_count || 0) > 1 && (
                                                    <div className="flex items-center gap-2 text-[12px]">
                                                        <span className="text-surface-400 dark:text-surface-500">Return visitor:</span>
                                                        <span className="text-surface-700 dark:text-surface-300">{leadDetail.behavioral.visit_count} visits</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Meta */}
                                    <div className="flex gap-4 text-[12px] text-surface-500 dark:text-surface-400">
                                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{(leadDetail.location || '').replace(/\s*\|.*$/, '') || '—'}</span>
                                        <span className="flex items-center gap-1"><Monitor className="w-3 h-3" />{leadDetail.device || '—'}</span>
                                        <span className="flex items-center gap-1"><MessageCircle className="w-3 h-3" />{leadDetail.chats} msgs</span>
                                    </div>

                                    {/* Chat history lives in its own drawer
                                        (opened via the per-row "View chat"
                                        button) so the Lead Detail panel can
                                        stay focused on qualification — notes,
                                        BANT scores, behavioral signals. */}
                                </div>
                            ) : null}
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* Chat-only drawer — opened by the per-row "View chat" button.
                Renders only the conversation (no BANT/notes/tags editor) so
                operators can scan messages without the qualification UI in
                the way. Reuses ``getLeadDetail`` for messages + meta. */}
            <AnimatePresence>
                {chatLead && (
                    <div className="fixed inset-0 z-50 flex justify-end" onClick={closeChatDrawer}>
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="absolute inset-0 bg-black/30 dark:bg-black/60"
                        />
                        <motion.div
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={{ type: 'spring', damping: 32, stiffness: 320 }}
                            className="relative w-full max-w-md bg-white dark:bg-surface-900 shadow-2xl flex flex-col"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Header: contact + meta + close. Mirrors the
                                live-chat header so the two views feel like
                                one product. */}
                            <div className="sticky top-0 z-10 bg-white dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800 px-5 py-4">
                                <div className="flex items-start gap-3">
                                    <div className="w-9 h-9 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center shrink-0">
                                        <MessageCircle className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-semibold text-surface-900 dark:text-surface-100 truncate">
                                            {chatDetail?.contact?.name || 'Anonymous'}
                                        </p>
                                        <p className="text-[12px] text-surface-500 dark:text-surface-400 truncate">
                                            {(chatDetail?.location || '').replace(/\s*\|.*$/, '') || 'Unknown'}
                                            {chatDetail?.device ? ` · ${chatDetail.device}` : ''}
                                        </p>
                                        {(tagsByLead[chatLead] || []).length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 mt-2">
                                                {(tagsByLead[chatLead] || []).map((tag) => (
                                                    <span
                                                        key={tag}
                                                        className="px-2 py-0.5 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300 text-[10px] font-medium rounded-full border border-primary-200 dark:border-primary-500/30"
                                                    >
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        onClick={closeChatDrawer}
                                        aria-label="Close chat"
                                        className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>

                            {/* Messages — grouped by date with a sticky-feel
                                divider chip per day, matching the reference
                                conversation view. */}
                            <div className="flex-1 overflow-y-auto px-5 py-5 bg-surface-50/40 dark:bg-surface-950/30">
                                {isChatLoading ? (
                                    <div className="flex items-center justify-center py-16">
                                        <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
                                    </div>
                                ) : !chatDetail?.messages?.length ? (
                                    <div className="text-center py-16 text-sm text-surface-500 dark:text-surface-400">
                                        No messages in this conversation yet.
                                    </div>
                                ) : (
                                    (() => {
                                        // Group messages by calendar day on
                                        // the client. Fall back to the lead's
                                        // last_active_at when an individual
                                        // message lacks a timestamp so the
                                        // divider never renders as "Invalid".
                                        const groups = [];
                                        const fallbackTs = chatDetail.last_active_at || null;
                                        chatDetail.messages.forEach((m) => {
                                            const ts = m.timestamp || fallbackTs;
                                            const key = ts ? new Date(ts).toDateString() : 'unknown';
                                            const tail = groups[groups.length - 1];
                                            if (!tail || tail.key !== key) {
                                                groups.push({ key, ts, items: [m] });
                                            } else {
                                                tail.items.push(m);
                                            }
                                        });
                                        return groups.map((group) => (
                                            <div key={group.key} className="space-y-3">
                                                <div className="flex items-center justify-center my-2">
                                                    <span className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider bg-surface-200/60 dark:bg-surface-800 text-surface-600 dark:text-surface-400 rounded-full">
                                                        {group.ts
                                                            ? new Date(group.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                                            : 'Unknown date'}
                                                    </span>
                                                </div>
                                                {group.items.map((msg, i) => {
                                                    const isUser = msg.role === 'user';
                                                    const time = msg.timestamp
                                                        ? new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                                                        : null;
                                                    return (
                                                        <div key={i} className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
                                                            {!isUser && (
                                                                <div className="w-7 h-7 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center shrink-0 mt-0.5">
                                                                    <MessageCircle className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" />
                                                                </div>
                                                            )}
                                                            <div className={cn('max-w-[75%] flex flex-col', isUser ? 'items-end' : 'items-start')}>
                                                                <div
                                                                    className={cn(
                                                                        'px-3.5 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap break-words',
                                                                        isUser
                                                                            ? 'bg-primary-500 text-white rounded-br-sm'
                                                                            : 'bg-white dark:bg-surface-800 text-surface-800 dark:text-surface-200 border border-surface-200 dark:border-surface-700 rounded-bl-sm'
                                                                    )}
                                                                >
                                                                    {msg.content}
                                                                </div>
                                                                {time && (
                                                                    <span className="mt-1 text-[10px] text-surface-400 dark:text-surface-500 px-1">
                                                                        {time}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {isUser && (
                                                                <div className="w-7 h-7 rounded-full bg-surface-200 dark:bg-surface-700 flex items-center justify-center shrink-0 mt-0.5">
                                                                    <User className="w-3.5 h-3.5 text-surface-500 dark:text-surface-400" />
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ));
                                    })()
                                )}
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
}
