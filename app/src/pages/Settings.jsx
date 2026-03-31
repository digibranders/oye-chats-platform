import { useState } from 'react';
import { MessageSquareWarning } from 'lucide-react';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import { getAuthState } from '../utils/auth';

export default function Settings() {
    const { showToast } = useToast();
    const { isOperator, operatorRole } = getAuthState();
    const [feedback, setFeedback] = useState('');

    const handleSendFeedback = (e) => {
        e.preventDefault();
        if (!feedback.trim()) return;
        showToast('success', 'Your feedback has been recorded!');
        setFeedback('');
    };

    return (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <PageHeader title="Settings" subtitle="Preferences and account" />

            {/* Account Info */}
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 mb-1">Account</h2>
                <p className="text-sm text-secondary-500 mb-4">Your account information</p>

                <div className="space-y-3">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-secondary-500">Name</span>
                        <span className="text-sm font-medium text-secondary-900">{localStorage.getItem('admin_name') || '—'}</span>
                    </div>
                    <div className="border-t border-secondary-100" />
                    {isOperator ? (
                        <>
                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-secondary-500">Operator ID</span>
                                <span className="text-sm font-mono text-secondary-400">{localStorage.getItem('operator_id') || '—'}</span>
                            </div>
                            <div className="border-t border-secondary-100" />
                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-secondary-500">Role</span>
                                <span className="text-sm font-medium text-secondary-900 capitalize">{operatorRole || '—'}</span>
                            </div>
                        </>
                    ) : (
                        <div className="flex items-center justify-between py-2">
                            <span className="text-sm text-secondary-500">Client ID</span>
                            <span className="text-sm font-mono text-secondary-400">{localStorage.getItem('admin_client_id') || '—'}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Feedback */}
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 mb-1 flex items-center gap-2">
                    <MessageSquareWarning size={16} className="text-primary-600" />
                    Send Feedback
                </h2>
                <p className="text-sm text-secondary-500 mb-4">
                    Have a suggestion or found a bug? Let us know at{' '}
                    <a href="mailto:developer@oyechats.com" className="font-medium text-primary-600 hover:underline">developer@oyechats.com</a>
                </p>

                <form onSubmit={handleSendFeedback} className="space-y-4">
                    <textarea
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all resize-none h-28 text-sm"
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
