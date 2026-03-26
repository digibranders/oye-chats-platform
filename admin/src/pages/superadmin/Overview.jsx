import React, { useState, useEffect } from 'react';
import { Bot, Users as UsersIcon, MessageSquare, Loader2, Link } from 'lucide-react';
import { getGlobalStats } from '../../services/api';

export default function SuperadminOverview() {
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const data = await getGlobalStats();
                setStats(data);
            } catch (err) {
                console.error("Failed to load global stats", err);
            } finally {
                setIsLoading(false);
            }
        };
        fetchStats();
    }, []);

    return (
        <div className="space-y-8 animate-slide-up">
            <div>
                <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Global Overview</h1>
                <p className="text-secondary-500 dark:text-secondary-400 mt-1">Monitor total platform usage and active clients.</p>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                
                {/* Total Clients Card */}
                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                    <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl group-hover:bg-indigo-500/10 transition-colors"></div>
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                        <UsersIcon className="w-4 h-4 text-indigo-500" />
                        Total Clients
                    </h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-4" size={24} />
                    ) : (
                        <div className="mt-4 flex items-baseline gap-2">
                            <p className="text-3xl font-bold text-secondary-900 dark:text-white">{stats?.total_clients || 0}</p>
                            <span className="text-xs font-medium text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">Active</span>
                        </div>
                    )}
                </div>

                {/* Total API Messages Card */}
                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                    <div className="absolute -right-4 -top-4 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl group-hover:bg-blue-500/10 transition-colors"></div>
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-blue-500" />
                        Global Messages (API)
                    </h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-4" size={24} />
                    ) : (
                        <div className="mt-4">
                            <p className="text-3xl font-bold text-secondary-900 dark:text-white">{stats?.total_messages?.toLocaleString() || 0}</p>
                        </div>
                    )}
                </div>

                {/* Total Sessions Card */}
                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                    <div className="absolute -right-4 -top-4 w-24 h-24 bg-orange-500/5 rounded-full blur-2xl group-hover:bg-orange-500/10 transition-colors"></div>
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                        <Link className="w-4 h-4 text-orange-500" />
                        Global Sessions
                    </h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-4" size={24} />
                    ) : (
                        <p className="text-3xl font-bold text-secondary-900 dark:text-white mt-4">{stats?.total_sessions?.toLocaleString() || 0}</p>
                    )}
                </div>

            </div>

             <div className="mt-8 p-6 bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800/50 flex flex-col items-center justify-center text-center">
                 <Bot size={40} className="text-indigo-400 mb-4" />
                 <h2 className="text-lg font-bold text-secondary-900 dark:text-white mb-2">Platform Health Optimal</h2>
                 <p className="text-secondary-600 dark:text-secondary-400 max-w-md">
                     Database vectors and chat pipelines are performing normally. API latency is stable.
                 </p>
             </div>
        </div>
    );
}
