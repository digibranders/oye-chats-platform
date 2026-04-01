import React, { useState, useEffect } from 'react';
import { Target, Download, X, Loader2, User, Mail, Phone, Building2, MapPin, Monitor, MessageCircle, Search, ChevronRight } from 'lucide-react';
import { getLeads, getLeadDetail, getLeadStats, exportLeadsCsv } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';

const STATUS_CONFIG = {
    cold: { label: 'Cold', color: 'bg-blue-100 text-blue-700' },
    warm: { label: 'Warm', color: 'bg-yellow-100 text-yellow-700' },
    hot: { label: 'Hot', color: 'bg-orange-100 text-orange-700' },
    qualified: { label: 'Qualified', color: 'bg-green-100 text-green-700' },
};

const BANT_LABELS = { need: 'Need', budget: 'Budget', authority: 'Authority', timeline: 'Timeline' };
const BANT_WEIGHTS = { need: 30, budget: 25, authority: 25, timeline: 20 };

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
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-secondary-700 bg-white border border-secondary-200 rounded-xl hover:bg-secondary-50:bg-secondary-700 transition-colors disabled:opacity-50"
                >
                    {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Export CSV
                </button>
            </div>

            {/* Stats Cards */}
            {stats && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                        { label: 'Total', value: stats.total, color: 'text-secondary-900' },
                        { label: 'Cold', value: stats.cold, color: 'text-blue-600' },
                        { label: 'Warm', value: stats.warm, color: 'text-yellow-600' },
                        { label: 'Hot', value: stats.hot, color: 'text-orange-600' },
                        { label: 'Qualified', value: stats.qualified, color: 'text-green-600' },
                    ].map(s => (
                        <button
                            key={s.label}
                            onClick={() => setStatusFilter(s.label === 'Total' ? null : s.label.toLowerCase())}
                            className={`p-4 rounded-xl border transition-all ${
                                (statusFilter === s.label.toLowerCase() || (!statusFilter && s.label === 'Total'))
                                    ? 'border-primary-300 bg-primary-50 ring-1 ring-primary-200'
                                    : 'border-secondary-200 bg-white hover:border-secondary-300'
                            }`}
                        >
                            <p className="text-[12px] font-medium text-secondary-500">{s.label}</p>
                            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                        </button>
                    ))}
                </div>
            )}

            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-secondary-400" />
                <input
                    type="text"
                    placeholder="Search by name, email, or location..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-secondary-200 rounded-xl focus:outline-none focus:border-primary-400"
                />
            </div>

            {/* Leads Table */}
            <div className="bg-white rounded-2xl border border-secondary-200 overflow-hidden">
                {isLoading ? (
                    <SkeletonTable rows={8} cols={6} />
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-secondary-500">
                        {leads.length === 0 ? 'No leads yet. Leads are created when visitors chat with your bot.' : 'No leads match your filters.'}
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-secondary-100">
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-secondary-500">Contact</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-secondary-500">Score</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-secondary-500">Status</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-secondary-500">BANT</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-secondary-500">Location</th>
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-secondary-500">Last Active</th>
                                <th className="px-4 py-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((lead) => {
                                const sc = STATUS_CONFIG[lead.status] || STATUS_CONFIG.cold;
                                return (
                                    <tr
                                        key={lead.session_id}
                                        className="border-b border-secondary-50 hover:bg-secondary-50:bg-secondary-700/30 cursor-pointer transition-colors"
                                        onClick={() => handleViewLead(lead.session_id)}
                                    >
                                        <td className="px-4 py-3">
                                            <div>
                                                <p className="font-medium text-secondary-900">
                                                    {lead.contact?.name || 'Anonymous'}
                                                </p>
                                                {lead.contact?.email && (
                                                    <p className="text-[12px] text-secondary-500">{lead.contact.email}</p>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2">
                                                <div className="w-12 h-2 bg-secondary-100 rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full transition-all"
                                                        style={{
                                                            width: `${lead.score}%`,
                                                            backgroundColor: lead.score >= 75 ? '#22c55e' : lead.score >= 50 ? '#f97316' : lead.score >= 25 ? '#eab308' : '#94a3b8',
                                                        }}
                                                    />
                                                </div>
                                                <span className="text-[12px] font-bold text-secondary-700">{lead.score}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${sc.color}`}>
                                                {sc.label}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex gap-1">
                                                {Object.entries(BANT_LABELS).map(([key, label]) => (
                                                    <span
                                                        key={key}
                                                        className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center ${
                                                            lead.bant?.[key]
                                                                ? 'bg-green-100 text-green-700'
                                                                : 'bg-secondary-100 text-secondary-400'
                                                        }`}
                                                        title={`${label}: ${lead.bant?.[key] || 'Not captured'}`}
                                                    >
                                                        {label[0]}
                                                    </span>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-[12px] text-secondary-600 max-w-[120px] truncate">
                                            {(lead.location || '').replace(/\s*\|.*$/, '') || '—'}
                                        </td>
                                        <td className="px-4 py-3 text-[12px] text-secondary-500">
                                            {formatDate(lead.last_active_at)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <ChevronRight className="w-4 h-4 text-secondary-400" />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Lead Detail Drawer */}
            {selectedLead && (
                <div className="fixed inset-0 z-50 flex justify-end" onClick={() => { setSelectedLead(null); setLeadDetail(null); }}>
                    <div className="absolute inset-0 bg-black/30" />
                    <div
                        className="relative w-full max-w-lg bg-white shadow-2xl overflow-y-auto animate-slide-in-right"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Drawer Header */}
                        <div className="sticky top-0 z-10 bg-white border-b border-secondary-200 px-6 py-4 flex items-center justify-between">
                            <h2 className="text-lg font-bold text-secondary-900">Lead Detail</h2>
                            <button onClick={() => { setSelectedLead(null); setLeadDetail(null); }} className="text-secondary-400 hover:text-secondary-600">
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
                                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-secondary-500">Contact</h3>
                                    <div className="bg-secondary-50 rounded-xl p-4 space-y-2">
                                        {leadDetail.contact?.name && <div className="flex items-center gap-2 text-sm"><User className="w-4 h-4 text-secondary-400" /><span>{leadDetail.contact.name}</span></div>}
                                        {leadDetail.contact?.email && <div className="flex items-center gap-2 text-sm"><Mail className="w-4 h-4 text-secondary-400" /><span>{leadDetail.contact.email}</span></div>}
                                        {leadDetail.contact?.phone && <div className="flex items-center gap-2 text-sm"><Phone className="w-4 h-4 text-secondary-400" /><span>{leadDetail.contact.phone}</span></div>}
                                        {leadDetail.contact?.company && <div className="flex items-center gap-2 text-sm"><Building2 className="w-4 h-4 text-secondary-400" /><span>{leadDetail.contact.company}</span></div>}
                                        {!leadDetail.contact && <p className="text-sm text-secondary-400">No contact info captured</p>}
                                    </div>
                                </div>

                                {/* Score + Status */}
                                <div className="flex items-center gap-4">
                                    <div className="flex-1">
                                        <p className="text-[12px] font-bold text-secondary-500 mb-1">Lead Score</p>
                                        <div className="flex items-center gap-3">
                                            <div className="flex-1 h-3 bg-secondary-100 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full rounded-full transition-all"
                                                    style={{
                                                        width: `${leadDetail.score}%`,
                                                        backgroundColor: leadDetail.score >= 75 ? '#22c55e' : leadDetail.score >= 50 ? '#f97316' : leadDetail.score >= 25 ? '#eab308' : '#94a3b8',
                                                    }}
                                                />
                                            </div>
                                            <span className="text-lg font-bold text-secondary-900">{leadDetail.score}</span>
                                        </div>
                                    </div>
                                    <span className={`px-3 py-1.5 rounded-full text-[12px] font-bold ${STATUS_CONFIG[leadDetail.status]?.color}`}>
                                        {STATUS_CONFIG[leadDetail.status]?.label}
                                    </span>
                                </div>

                                {/* BANT Breakdown */}
                                <div className="space-y-3">
                                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-secondary-500">BANT Qualification</h3>
                                    <div className="space-y-2">
                                        {Object.entries(BANT_LABELS).map(([key, label]) => (
                                            <div key={key} className="bg-secondary-50 rounded-lg px-4 py-3">
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className="text-[12px] font-bold text-secondary-600">{label} (+{BANT_WEIGHTS[key]})</span>
                                                    {leadDetail.bant?.[key] ? (
                                                        <span className="text-[10px] font-bold text-green-600 bg-green-100 px-2 py-0.5 rounded-full">Captured</span>
                                                    ) : (
                                                        <span className="text-[10px] font-bold text-secondary-400 bg-secondary-100 px-2 py-0.5 rounded-full">Missing</span>
                                                    )}
                                                </div>
                                                {leadDetail.bant?.[key] && (
                                                    <p className="text-sm text-secondary-700">{leadDetail.bant[key]}</p>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Meta */}
                                <div className="flex gap-4 text-[12px] text-secondary-500">
                                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{(leadDetail.location || '').replace(/\s*\|.*$/, '') || '—'}</span>
                                    <span className="flex items-center gap-1"><Monitor className="w-3 h-3" />{leadDetail.device || '—'}</span>
                                    <span className="flex items-center gap-1"><MessageCircle className="w-3 h-3" />{leadDetail.chats} msgs</span>
                                </div>

                                {/* Chat History */}
                                {leadDetail.messages && leadDetail.messages.length > 0 && (
                                    <div className="space-y-3">
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-secondary-500">Chat History</h3>
                                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                                            {leadDetail.messages.map((msg, i) => (
                                                <div
                                                    key={i}
                                                    className={`px-3 py-2 rounded-lg text-sm ${
                                                        msg.role === 'user'
                                                            ? 'bg-primary-50 text-secondary-800 ml-8'
                                                            : 'bg-secondary-50 text-secondary-700 mr-8'
                                                    }`}
                                                >
                                                    <p className="text-[10px] font-bold text-secondary-400 mb-0.5">{msg.role === 'user' ? 'Visitor' : 'Bot'}</p>
                                                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{msg.content.length > 300 ? msg.content.substring(0, 300) + '...' : msg.content}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </div>
                </div>
            )}

            <style>{`
                @keyframes slide-in-right {
                    from { transform: translateX(100%); }
                    to { transform: translateX(0); }
                }
                .animate-slide-in-right { animation: slide-in-right 0.25s ease-out; }
            `}</style>
        </div>
    );
}
