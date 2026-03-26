import { useState } from 'react';
import { Moon, Sun, Monitor, MessageSquareWarning } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';

export default function Settings() {
    const { theme, setTheme } = useTheme();
    const { showToast } = useToast();
    const [feedback, setFeedback] = useState('');

    const handleSendFeedback = (e) => {
        e.preventDefault();
        if (!feedback.trim()) return;
        showToast('success', 'Your feedback has been recorded!');
        setFeedback('');
    };

    const themes = [
        { id: 'light', name: 'Light', icon: Sun, desc: 'Clean and bright' },
        { id: 'dark', name: 'Dark', icon: Moon, desc: 'Easy on the eyes' },
        { id: 'system', name: 'System', icon: Monitor, desc: 'Match your device' },
    ];

    return (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <PageHeader title="Settings" subtitle="Preferences and account" />

            {/* Appearance */}
            <div className="bg-white dark:bg-secondary-900 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-800 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 dark:text-white mb-1">Appearance</h2>
                <p className="text-sm text-secondary-500 dark:text-secondary-400 mb-5">Choose how OyeChat looks for you</p>

                <div className="grid grid-cols-3 gap-3">
                    {themes.map((t) => {
                        const Icon = t.icon;
                        const isActive = theme === t.id;
                        return (
                            <button
                                key={t.id}
                                onClick={() => setTheme(t.id)}
                                className={`flex flex-col items-center gap-2 p-4 border rounded-xl transition-all ${
                                    isActive
                                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10 ring-1 ring-primary-500/20'
                                        : 'border-secondary-200 dark:border-secondary-800 hover:bg-secondary-50 dark:hover:bg-secondary-800'
                                }`}
                            >
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                                    isActive ? 'bg-primary-100 dark:bg-primary-500/20' : 'bg-secondary-100 dark:bg-secondary-800'
                                }`}>
                                    <Icon size={20} className={isActive ? 'text-primary-600 dark:text-primary-400' : 'text-secondary-500'} />
                                </div>
                                <div className="text-center">
                                    <p className={`text-sm font-medium ${isActive ? 'text-primary-700 dark:text-primary-400' : 'text-secondary-700 dark:text-secondary-300'}`}>{t.name}</p>
                                    <p className="text-[10px] text-secondary-400 mt-0.5">{t.desc}</p>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Account Info */}
            <div className="bg-white dark:bg-secondary-900 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-800 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 dark:text-white mb-1">Account</h2>
                <p className="text-sm text-secondary-500 dark:text-secondary-400 mb-4">Your account information</p>

                <div className="space-y-3">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-secondary-500">Name</span>
                        <span className="text-sm font-medium text-secondary-900 dark:text-white">{localStorage.getItem('admin_name') || '—'}</span>
                    </div>
                    <div className="border-t border-secondary-100 dark:border-secondary-800" />
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-secondary-500">Client ID</span>
                        <span className="text-sm font-mono text-secondary-400">{localStorage.getItem('admin_client_id') || '—'}</span>
                    </div>
                </div>
            </div>

            {/* Feedback */}
            <div className="bg-white dark:bg-secondary-900 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-800 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 dark:text-white mb-1 flex items-center gap-2">
                    <MessageSquareWarning size={16} className="text-primary-600 dark:text-primary-400" />
                    Send Feedback
                </h2>
                <p className="text-sm text-secondary-500 dark:text-secondary-400 mb-4">
                    Have a suggestion or found a bug? Let us know at{' '}
                    <a href="mailto:developer@oyechats.com" className="font-medium text-primary-600 dark:text-primary-400 hover:underline">developer@oyechats.com</a>
                </p>

                <form onSubmit={handleSendFeedback} className="space-y-4">
                    <textarea
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all resize-none h-28 text-sm"
                        placeholder="Describe your issue or feature request..."
                    />
                    <button
                        type="submit"
                        disabled={!feedback.trim()}
                        className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Send Feedback
                    </button>
                </form>
            </div>
        </div>
    );
}
