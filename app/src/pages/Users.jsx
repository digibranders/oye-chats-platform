import React, { useState, useEffect } from 'react';
import { MessageCircle, MapPin, Monitor, X, Loader2, Bot, User, Search } from 'lucide-react';
import { getVisitorsData, getChatHistory } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';

export default function Users({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [visitors, setVisitors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedSessionId, setSelectedSessionId] = useState(null);
    const [chatHistory, setChatHistory] = useState([]);
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => { fetchVisitors(); }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Conversations" description="Create a chatbot first to start tracking visitor sessions and conversations." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const fetchVisitors = async () => {
        setIsLoading(true);
        try { setVisitors(await getVisitorsData(selectedBot?.id)); }
        catch (error) { console.error('Failed to load visitors:', error); showToast('error', error.message || 'Failed to load visitors'); }
        finally { setIsLoading(false); }
    };

    const handleViewChat = async (sessionId) => {
        setSelectedSessionId(sessionId);
        setIsChatLoading(true);
        try { setChatHistory(await getChatHistory(sessionId)); }
        catch (error) { console.error('Failed to load chat history:', error); showToast('error', error.message || 'Failed to load chat history'); }
        finally { setIsChatLoading(false); }
    };

    const closeChatDrawer = () => { setSelectedSessionId(null); setChatHistory([]); };

    const formatDate = (dateString) => new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const filtered = visitors.filter(v =>
        !searchQuery || v.visitor.toLowerCase().includes(searchQuery.toLowerCase()) || v.location?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className={`space-y-6 ${embedded ? '' : 'animate-fade-in'}`}>
            {!embedded && <PageHeader title="Conversations" subtitle="See who's chatting and what they're asking" />}

            {/* Search */}
            <div className="relative max-w-sm">
                <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                <input
                    type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search visitors..."
                    className="w-full pl-10 pr-4 py-2 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                />
            </div>

            {/* Visitors Table */}
            {isLoading ? (
                <SkeletonTable rows={5} cols={5} />
            ) : (
                <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-secondary-50 border-b border-secondary-200">
                                    <th className="py-3.5 px-5 text-xs font-semibold text-secondary-500 uppercase tracking-wider">User</th>
                                    <th className="py-3.5 px-5 text-xs font-semibold text-secondary-500 uppercase tracking-wider">Location</th>
                                    <th className="py-3.5 px-5 text-xs font-semibold text-secondary-500 uppercase tracking-wider">Device</th>
                                    <th className="py-3.5 px-5 text-xs font-semibold text-secondary-500 uppercase tracking-wider">Last Active</th>
                                    <th className="py-3.5 px-5 text-xs font-semibold text-secondary-500 uppercase tracking-wider text-center">Chats</th>
                                    <th className="py-3.5 px-5 text-xs font-semibold text-secondary-500 uppercase tracking-wider text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-secondary-100">
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="6" className="py-12 text-center text-secondary-500 text-sm">No visitors found</td></tr>
                                ) : filtered.map((visitor) => (
                                    <tr key={visitor.session_id} className="hover:bg-secondary-50/50:bg-secondary-800/30 transition-colors group">
                                        <td className="py-3.5 px-5">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-600 font-bold text-xs">
                                                    {visitor.visitor.substring(0, 1).toUpperCase()}
                                                </div>
                                                <span className="font-medium text-sm text-secondary-900 group-hover:text-primary-600:text-primary-400 transition-colors">{visitor.visitor}</span>
                                            </div>
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <div className="flex items-center gap-2 text-sm text-secondary-500"><MapPin className="w-3.5 h-3.5" />{visitor.location || 'Unknown'}</div>
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <div className="flex items-center gap-2 text-sm text-secondary-500"><Monitor className="w-3.5 h-3.5" /><span className="truncate max-w-[120px]">{visitor.device || 'Unknown'}</span></div>
                                        </td>
                                        <td className="py-3.5 px-5 text-sm text-secondary-500">{formatDate(visitor.last_active_at)}</td>
                                        <td className="py-3.5 px-5 text-center">
                                            <span className="inline-flex items-center justify-center min-w-[1.75rem] px-2 py-0.5 rounded-full bg-secondary-100 text-xs font-bold text-secondary-600">{visitor.chats}</span>
                                        </td>
                                        <td className="py-3.5 px-5 text-right">
                                            <button onClick={() => handleViewChat(visitor.session_id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-secondary-200 text-xs font-semibold text-secondary-600 hover:border-primary-400 hover:text-primary-600:text-primary-400 transition-all bg-white">
                                                <MessageCircle className="w-3.5 h-3.5" /> View
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Chat History Drawer */}
            {selectedSessionId && (
                <>
                    <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm animate-fade-in" onClick={closeChatDrawer} />
                    <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-white shadow-2xl flex flex-col border-l border-secondary-200 animate-slide-in-right">
                        {/* Drawer Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-secondary-100 shrink-0">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center">
                                    <MessageCircle className="w-4 h-4 text-primary-600" />
                                </div>
                                <div>
                                    <h3 className="font-bold text-secondary-900 text-sm">Chat History</h3>
                                    <p className="text-[11px] text-secondary-400">Conversation transcript</p>
                                </div>
                            </div>
                            <button onClick={closeChatDrawer} className="p-2 rounded-lg hover:bg-secondary-100:bg-secondary-800 text-secondary-400 transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Chat Messages */}
                        <div className="flex-1 overflow-y-auto p-5 space-y-3">
                            {isChatLoading ? (
                                <div className="flex flex-col items-center justify-center h-full">
                                    <Loader2 className="w-6 h-6 animate-spin text-primary-500 mb-2" />
                                    <p className="text-sm text-secondary-400">Loading conversation...</p>
                                </div>
                            ) : chatHistory.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-secondary-400">
                                    <MessageCircle className="w-8 h-8 mb-2 opacity-40" />
                                    <p className="text-sm">No messages in this session</p>
                                </div>
                            ) : chatHistory.map((msg, index) => {
                                const isBot = msg.role === 'assistant' || msg.role === 'bot';
                                const msgDate = new Date(msg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                                const prevDate = index > 0 ? new Date(chatHistory[index - 1].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                                const showDivider = msgDate !== prevDate;
                                return (
                                    <React.Fragment key={index}>
                                        {showDivider && (
                                            <div className="flex justify-center my-4">
                                                <span className="px-3 py-1 bg-secondary-100 text-secondary-500 text-[10px] font-bold uppercase tracking-wider rounded-full">{msgDate}</span>
                                            </div>
                                        )}
                                        <div className={`flex ${isBot ? 'justify-start' : 'justify-end'}`}>
                                            <div className={`flex max-w-[85%] gap-2.5 ${isBot ? 'flex-row' : 'flex-row-reverse'}`}>
                                                <div className="flex-shrink-0 mt-1">
                                                    {isBot ? (
                                                        <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center">
                                                            <Bot className="w-3.5 h-3.5 text-primary-600" />
                                                        </div>
                                                    ) : (
                                                        <div className="w-7 h-7 rounded-full bg-secondary-200 flex items-center justify-center">
                                                            <User className="w-3.5 h-3.5 text-secondary-600" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className={`flex flex-col ${isBot ? 'items-start' : 'items-end'}`}>
                                                    <div className={`px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${isBot ? 'bg-secondary-100 text-secondary-800 rounded-tl-sm' : 'bg-primary-600 text-white rounded-tr-sm'}`}>
                                                        {msg.content}
                                                    </div>
                                                    <span className="text-[10px] text-secondary-400 mt-1 px-1">{formatDate(msg.timestamp)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </React.Fragment>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
