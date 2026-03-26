import { useState, useRef, useEffect } from 'react';
import { Moon, Sun, Monitor, MessageSquareWarning, CheckCircle2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export default function Settings() {
    const { theme, setTheme } = useTheme();
    const [feedback, setFeedback] = useState('');

    // Toast notification state
    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);

    const showToast = (message) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(message);
        toastTimer.current = setTimeout(() => setToast(null), 3500);
    };

    useEffect(() => {
        return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
    }, []);

    const handleSendFeedback = (e) => {
        e.preventDefault();
        if (!feedback.trim()) return;

        showToast('Your feedback has been successfully recorded!');
        setFeedback('');
    };

    return (
        <div className="space-y-6 animate-slide-up pb-10">
            {/* Pill Toast */}
            <div
                style={{
                    position: 'fixed',
                    top: 24,
                    left: '50%',
                    transform: toast ? 'translateX(-50%) translateY(0)' : 'translateX(-50%) translateY(-20px)',
                    zIndex: 99999,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 22px',
                    borderRadius: 999,
                    background: '#f0fdf4',
                    border: '1px solid #bbf7d0',
                    color: '#15803d',
                    boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)',
                    opacity: toast ? 1 : 0,
                    pointerEvents: toast ? 'auto' : 'none',
                    transition: 'opacity 0.4s, transform 0.4s',
                }}
            >
                <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>{toast}</span>
            </div>

            <div>
                <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Settings</h1>
                <p className="text-secondary-500 dark:text-secondary-400 mt-1">Manage your admin preferences and provide feedback.</p>
            </div>

            <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm max-w-3xl transition-colors">
                <h2 className="text-lg font-semibold text-secondary-900 dark:text-white mb-4 border-b border-secondary-100 dark:border-secondary-700 pb-2">Appearance</h2>

                <div className="mt-4">
                    <p className="text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-3">Theme Preference</p>
                    <div className="flex flex-wrap gap-4">
                        {[
                            { id: 'light', name: 'Light', icon: Sun },
                            { id: 'dark', name: 'Dark', icon: Moon },
                            { id: 'system', name: 'System', icon: Monitor },
                        ].map((t) => {
                            const Icon = t.icon;
                            const isActive = theme === t.id;
                            return (
                                <button
                                    key={t.id}
                                    onClick={() => setTheme(t.id)}
                                    className={`flex items-center gap-2 px-4 py-2 border rounded-xl transition-all ${isActive
                                        ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-400 dark:border-primary-600'
                                        : 'border-secondary-200 text-secondary-600 hover:bg-secondary-50 dark:border-secondary-600 dark:text-secondary-400 dark:hover:bg-secondary-700/50'
                                        }`}
                                >
                                    <Icon size={18} /> {t.name} Mode
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm max-w-3xl mt-6 transition-colors">
                <h2 className="text-lg font-semibold text-secondary-900 dark:text-white mb-4 border-b border-secondary-100 dark:border-secondary-700 pb-2 flex items-center gap-2">
                    <MessageSquareWarning size={18} className="text-primary-600 dark:text-primary-400" /> Provider Feedback
                </h2>

                <form onSubmit={handleSendFeedback} className="mt-4 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1">
                            Have a suggestion or found a bug? Let us know.
                        </label>
                        <p className="text-xs text-secondary-500 dark:text-secondary-400 mb-3">
                            Your feedback will be sent to <a href="mailto:developer@oyechat.com" className="font-semibold text-primary-600 dark:text-primary-400 hover:underline">developer@oyechat.com</a>
                        </p>
                        <textarea
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-secondary-300 dark:border-secondary-600 dark:bg-secondary-700 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none transition-all resize-none h-32 text-sm"
                            placeholder="Describe your issue or feature request here..."
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={!feedback.trim()}
                        className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Send Feedback
                    </button>
                </form>
            </div>

        </div>
    );
}
