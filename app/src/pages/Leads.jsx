import React, { useState, useEffect } from 'react';
import { Target, Download, X, Loader2, User, Mail, Phone, Building2, MapPin, Monitor, MessageCircle, Search, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getLeads, getLeadDetail, getLeadStats, exportLeadsCsv } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';

const STATUS_CONFIG = {
    unqualified: { label: 'Unqualified', color: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400' },
    mql: { label: 'MQL', color: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400' },
    sal: { label: 'SAL', color: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400' },
    sql: { label: 'SQL', color: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400' },
    // backward-compat aliases
    cold: { label: 'Unqualified', color: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400' },
    warm: { label: 'MQL', color: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400' },
    hot: { label: 'SAL', color: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400' },
    qualified: { label: 'SQL', color: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400' },
};

const BANT_LABELS = { need: 'Need', budget: 'Budget', authority: 'Authority', timeline: 'Timeline' };

export default function Leads() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [leads, setLeads] = useState([]);
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedLead, setSelectedLead] = useState(null);
    const [leadDetail, setLeadDetail] = useState(null);
    const [isDetailLoading, setIsDetailLoading] = useState(false);
    const [isExporting, setIsExporting] = useState(false);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchData(); }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Leads" description="Create a chatbot first to start capturing and qualifying leads." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

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

    const handleViewLead = async (sessionId) => {
        setSelectedLead(sessionId);
        setIsDetailLoading(true);
        try {
            setLeadDetail(await getLeadDetail(sessionId));
        } catch (error) {
            console.error('Failed to load lead detail:', error);
            showToast('error', error.message || 'Failed to load lead details');
        } finally {
            setIsDetailLoading(false);
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

    const filtered = leads.filter(l => {
        if (statusFilter && l.status !== statusFilter) return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const name = l.contact?.name?.toLowerCase() || '';
            const email = l.contact?.email?.toLowerCase() || '';
            const loc = l.location?.toLowerCase() || '';
            if (!name.includes(q) && !email.includes(q) && !loc.includes(q) && !l.session_id.toLowerCase().includes(q)) return false;
        }
        return true;
    });

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
                <PageHeader title="Leads" subtitle="Track and qualify your sales leads with BANT scoring" />
                <button
                    onClick={handleExport}
                    disabled={isExporting || leads.length === 0}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-surface-700 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors disabled:opacity-50"
                >
                    {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Export CSV
                </button>
            </div>

            {/* Stats Cards */}
            {stats && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                        { label: 'Total', value: stats.total, color: 'text-surface-900 dark:text-surface-100' },
                        { label: 'Cold', value: stats.cold, color: 'text-blue-600 dark:text-blue-400' },
                        { label: 'Warm', value: stats.warm, color: 'text-yellow-600 dark:text-yellow-400' },
                        { label: 'Hot', value: stats.hot, color: 'text-orange-600 dark:text-orange-400' },
                        { label: 'Qualified', value: stats.qualified, color: 'text-green-600 dark:text-green-400' },
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

            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                <input
                    type="text"
                    placeholder="Search by name, email, or location..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-xl focus:outline-none focus:border-primary-400 dark:focus:border-primary-500 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                />
            </div>

            {/* Leads Table */}
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                {isLoading ? (
                    <SkeletonTable rows={8} cols={6} />
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-surface-500 dark:text-surface-400">
                        {leads.length === 0 ? 'No leads yet. Leads are created when visitors chat with your bot.' : 'No leads match your filters.'}
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-surface-100 dark:border-surface-800">
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
                                        onClick={() => handleViewLead(lead.session_id)}
                                    >
                                        <td className="px-4 py-3">
                                            <div>
                                                <p className="font-medium text-surface-900 dark:text-surface-100">
                                                    {lead.contact?.name || 'Anonymous'}
                                                </p>
                                                {lead.contact?.email && (
                                                    <p className="text-[12px] text-surface-500 dark:text-surface-400">{lead.contact.email}</p>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
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
                                        <td className="px-4 py-3">
                                            <span className={cn('px-2.5 py-1 rounded-full text-[11px] font-bold', sc.color)}>
                                                {sc.label}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex gap-1">
                                                {Object.entries(BANT_LABELS).map(([key, label]) => (
                                                    <span
                                                        key={key}
                                                        className={cn(
                                                            'w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center',
                                                            (lead.bant?.[key]?.score || 0) > 0
                                                                ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                                                                : 'bg-surface-100 text-surface-400 dark:bg-surface-800 dark:text-surface-500'
                                                        )}
                                                        title={`${label}: ${lead.bant?.[key]?.value || 'Not captured'} (${lead.bant?.[key]?.score || 0}/25)`}
                                                    >
                                                        {label[0]}
                                                    </span>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-[12px] text-surface-600 dark:text-surface-400 max-w-[120px] truncate">
                                            {(lead.location || '').replace(/\s*\|.*$/, '') || '—'}
                                        </td>
                                        <td className="px-4 py-3 text-[12px] text-surface-500 dark:text-surface-400">
                                            {formatDate(lead.last_active_at)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <ChevronRight className="w-4 h-4 text-surface-400 dark:text-surface-500" />
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

                                    {/* Score + Status */}
                                    <div className="flex items-center gap-4">
                                        <div className="flex-1">
                                            <p className="text-[12px] font-bold text-surface-500 dark:text-surface-400 mb-1">Lead Score</p>
                                            <div className="flex items-center gap-3">
                                                <div className="flex-1 h-3 bg-surface-100 dark:bg-surface-700 rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full transition-all"
                                                        style={{
                                                            width: `${leadDetail.score}%`,
                                                            backgroundColor: leadDetail.score >= 75 ? '#22c55e' : leadDetail.score >= 50 ? '#f97316' : leadDetail.score >= 25 ? '#eab308' : '#94a3b8',
                                                        }}
                                                    />
                                                </div>
                                                <span className="text-lg font-bold text-surface-900 dark:text-surface-100">{leadDetail.score}</span>
                                            </div>
                                        </div>
                                        <span className={cn('px-3 py-1.5 rounded-full text-[12px] font-bold', STATUS_CONFIG[leadDetail.status]?.color)}>
                                            {STATUS_CONFIG[leadDetail.status]?.label}
                                        </span>
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
                                                                    dimScore >= 20 ? 'bg-green-500' : dimScore >= 10 ? 'bg-blue-500' : dimScore > 0 ? 'bg-amber-400' : 'bg-surface-300 dark:bg-surface-600'
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
                                                                        ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                                                                        : s.confidence === 'medium'
                                                                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400'
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
                                                                ? 'bg-green-500'
                                                                : (leadDetail.behavioral_score || 0) >= 8
                                                                    ? 'bg-blue-500'
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

                                    {/* Chat History */}
                                    {leadDetail.messages && leadDetail.messages.length > 0 && (
                                        <div className="space-y-3">
                                            <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Chat History</h3>
                                            <div className="space-y-2 max-h-[400px] overflow-y-auto">
                                                {leadDetail.messages.map((msg, i) => (
                                                    <div
                                                        key={i}
                                                        className={cn(
                                                            'px-3 py-2 rounded-lg text-sm',
                                                            msg.role === 'user'
                                                                ? 'bg-primary-50 dark:bg-primary-500/10 text-surface-800 dark:text-surface-200 ml-8'
                                                                : 'bg-surface-50 dark:bg-surface-800 text-surface-700 dark:text-surface-300 mr-8'
                                                        )}
                                                    >
                                                        <p className="text-[10px] font-bold text-surface-400 dark:text-surface-500 mb-0.5">{msg.role === 'user' ? 'Visitor' : 'Bot'}</p>
                                                        <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{msg.content.length > 300 ? msg.content.substring(0, 300) + '...' : msg.content}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : null}
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
}
