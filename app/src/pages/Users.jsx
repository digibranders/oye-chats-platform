import React, { useState, useEffect } from 'react';
import { Users as UsersIcon, MapPin, Monitor, MessageSquare, ExternalLink, X, Loader2, Bot, User } from 'lucide-react';
import { getVisitorsData, getChatHistory } from '../services/api';
import { useBotContext } from '../context/BotContext';
import NoBotState from '../components/NoBotState';

export default function Users() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const [visitors, setVisitors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedSessionId, setSelectedSessionId] = useState(null);
    const [chatHistory, setChatHistory] = useState([]);
    const [isChatLoading, setIsChatLoading] = useState(false);

    useEffect(() => {
        fetchVisitors();
    }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <NoBotState title="Visitors" subtitle="Create a chatbot first to start tracking visitor sessions and conversations." />;
    }

    const fetchVisitors = async () => {
        setIsLoading(true);
        try {
            const data = await getVisitorsData(selectedBot?.id);
            setVisitors(data);
        } catch (error) {
            console.error("Failed to load visitors:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleViewChat = async (sessionId) => {
        setSelectedSessionId(sessionId);
        setIsChatLoading(true);
        try {
            const data = await getChatHistory(sessionId);
            setChatHistory(data);
        } catch (error) {
            console.error("Failed to load chat history:", error);
        } finally {
            setIsChatLoading(false);
        }
    };

    const closeChatModal = () => {
        setSelectedSessionId(null);
        setChatHistory([]);
    };

    const formatDate = (dateString) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="space-y-6 animate-slide-up pb-10">
            <div>
                <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Visitors Activity</h1>
                <p className="text-secondary-500 dark:text-secondary-400 mt-1">Monitor real-time interactions, locations, and chat history of your visitors.</p>
            </div>

            {/* Visitors Table */}
            <div className="bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm overflow-hidden transition-colors">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-secondary-50 dark:bg-secondary-800/50 border-b border-secondary-200 dark:border-secondary-700">
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider">User</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider">Location</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider">Device</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider">Last Active</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider text-center">Chats</th>
                                <th className="py-4 px-6 text-xs font-semibold text-secondary-500 dark:text-secondary-400 uppercase tracking-wider text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-secondary-100 dark:divide-secondary-700/50">
                            {isLoading ? (
                                <tr>
                                    <td colSpan="6" className="py-8 text-center">
                                        <Loader2 className="w-6 h-6 animate-spin text-primary-500 mx-auto" />
                                        <p className="text-sm text-secondary-500 mt-2">Loading visitors data...</p>
                                    </td>
                                </tr>
                            ) : visitors.length === 0 ? (
                                <tr>
                                    <td colSpan="6" className="py-12 text-center">
                                        <div className="w-12 h-12 bg-secondary-50 dark:bg-secondary-800 rounded-full flex items-center justify-center mx-auto mb-3">
                                            <UsersIcon className="w-6 h-6 text-secondary-400" />
                                        </div>
                                        <h3 className="text-sm font-semibold text-secondary-900 dark:text-white">No visitors found</h3>
                                        <p className="text-xs text-secondary-500 mt-1">Visitor chat sessions will appear here.</p>
                                    </td>
                                </tr>
                            ) : (
                                visitors.map((visitor) => (
                                    <tr key={visitor.session_id} className="hover:bg-secondary-50/50 dark:hover:bg-secondary-800/50 transition-colors group">
                                        <td className="py-4 px-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center text-primary-600 dark:text-primary-400 font-bold text-xs ring-2 ring-white dark:ring-secondary-800">
                                                    {visitor.visitor.substring(0, 1).toUpperCase()}
                                                </div>
                                                <span className="font-semibold text-sm text-secondary-900 dark:text-white group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors">
                                                    {visitor.visitor}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="py-4 px-6">
                                            <div className="flex items-center gap-2 text-sm text-secondary-600 dark:text-secondary-300">
                                                <MapPin className="w-4 h-4 text-secondary-400" />
                                                {visitor.location || 'Unknown'}
                                            </div>
                                        </td>
                                        <td className="py-4 px-6">
                                            <div className="flex items-center gap-2 text-sm text-secondary-600 dark:text-secondary-300">
                                                <Monitor className="w-4 h-4 text-secondary-400" />
                                                <span className="truncate max-w-[150px]" title={visitor.device}>{visitor.device || 'Unknown'}</span>
                                            </div>
                                        </td>
                                        <td className="py-4 px-6 text-sm text-secondary-600 dark:text-secondary-300">
                                            {formatDate(visitor.last_active_at)}
                                        </td>
                                        <td className="py-4 px-6 text-center">
                                            <span className="inline-flex items-center justify-center min-w-[2rem] px-2 py-1 rounded-full bg-secondary-100 dark:bg-secondary-700 text-xs font-bold text-secondary-700 dark:text-secondary-300">
                                                {visitor.chats}
                                            </span>
                                        </td>
                                        <td className="py-4 px-6 text-right">
                                            <button
                                                onClick={() => handleViewChat(visitor.session_id)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-secondary-700 border border-secondary-200 dark:border-secondary-600 text-xs font-semibold text-secondary-700 dark:text-secondary-200 hover:border-primary-400 hover:text-primary-600 dark:hover:text-primary-400 transition-all shadow-sm"
                                            >
                                                <MessageSquare className="w-3.5 h-3.5" />
                                                View Chat
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Chat History Modal Overlay */}
            {selectedSessionId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-secondary-900/40 dark:bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-secondary-900 w-full max-w-2xl h-[80vh] rounded-2xl shadow-2xl flex flex-col border border-secondary-200 dark:border-secondary-700 overflow-hidden transform transition-all animate-in zoom-in-95 duration-200">
                        
                        {/* Modal Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-secondary-100 dark:border-secondary-800 bg-secondary-50/50 dark:bg-secondary-900/50">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                                    <MessageSquare className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h3 className="font-bold text-secondary-900 dark:text-white">Chat History</h3>
                                    {/* <p className="text-xs text-secondary-500 dark:text-secondary-400">
                                        Session: <span className="font-mono">{selectedSessionId.split('-')[0]}...</span>
                                    </p> */}
                                </div>
                            </div>
                            <button
                                onClick={closeChatModal}
                                className="p-2 rounded-xl hover:bg-secondary-200 dark:hover:bg-secondary-800 text-secondary-500 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Modal Body (Chat Messages) */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-secondary-50/30 dark:bg-secondary-900/30 custom-scrollbar">
                            {isChatLoading ? (
                                <div className="flex flex-col items-center justify-center h-full space-y-3">
                                    <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
                                    <p className="text-sm text-secondary-500">Loading conversation...</p>
                                </div>
                            ) : chatHistory.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full space-y-2 text-secondary-400">
                                    <MessageSquare className="w-10 h-10 mb-2 opacity-50" />
                                    <p>No messages in this session.</p>
                                </div>
                            ) : (
                                chatHistory.map((msg, index) => {
                                    const isBot = msg.role === 'assistant' || msg.role === 'bot';
                                    const msgDate = new Date(msg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                                    const prevDate = index > 0 ? new Date(chatHistory[index - 1].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                                    const showDivider = msgDate !== prevDate;

                                    return (
                                        <React.Fragment key={index}>
                                            {showDivider && (
                                                <div className="flex justify-center my-6">
                                                    <span className="px-3 py-1 bg-secondary-200/50 dark:bg-secondary-800 text-secondary-600 dark:text-secondary-400 text-[11px] font-bold tracking-wider uppercase rounded-full shadow-sm border border-secondary-200 dark:border-secondary-700">
                                                        {msgDate}
                                                    </span>
                                                </div>
                                            )}
                                            <div className={`flex w-full ${isBot ? 'justify-start' : 'justify-end'}`}>
                                                <div className={`flex max-w-[80%] gap-3 ${isBot ? 'flex-row' : 'flex-row-reverse'}`}>
                                                    
                                                    {/* Avatar */}
                                                    <div className="flex-shrink-0 mt-1">
                                                        {isBot ? (
                                                            <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/50 flex items-center justify-center border border-primary-200 dark:border-primary-800">
                                                                <Bot className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                                                            </div>
                                                        ) : (
                                                            <div className="w-8 h-8 rounded-full bg-secondary-200 dark:bg-secondary-700 flex items-center justify-center border border-secondary-300 dark:border-secondary-600">
                                                                <User className="w-4 h-4 text-secondary-600 dark:text-secondary-300" />
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Message Bubble */}
                                                    <div className={`flex flex-col ${isBot ? 'items-start' : 'items-end'}`}>
                                                        <div
                                                            className={`px-4 py-2.5 rounded-2xl text-[14px] shadow-sm leading-relaxed ${
                                                                isBot 
                                                                ? 'bg-white dark:bg-secondary-800 text-secondary-800 dark:text-secondary-200 border border-secondary-100 dark:border-secondary-700 rounded-tl-sm' 
                                                                : 'bg-primary-600 text-white rounded-tr-sm'
                                                            }`}
                                                        >
                                                            {msg.content}
                                                        </div>
                                                        <span className="text-[10px] text-secondary-400 mt-1 px-1 font-medium">
                                                            {formatDate(msg.timestamp)}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        </React.Fragment>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
