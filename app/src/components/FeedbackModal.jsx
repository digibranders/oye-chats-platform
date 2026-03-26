import React, { useState } from 'react';
import { X, Info } from 'lucide-react';

const FeedbackModal = ({ isOpen, onClose, onSubmit }) => {
    const [feedback, setFeedback] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!isOpen) return null;

    const handleSubmit = async () => {
        if (!feedback.trim()) return;
        setIsSubmitting(true);
        try {
            await onSubmit(feedback);
            setFeedback('');
            onClose();
        } catch (error) {
            console.error("Failed to submit feedback:", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-end justify-end sm:items-center sm:justify-center p-4 sm:p-0">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />

            {/* Modal Content */}
            <div className="relative w-full max-w-lg bg-[#1e1e1e] text-white rounded-2xl shadow-2xl border border-[#333] transform transition-all animate-slide-in-right overflow-hidden flex flex-col h-[500px]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-[#333]">
                    <h2 className="text-xl font-semibold">Send feedback</h2>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-full hover:bg-[#333] transition-colors text-secondary-400 hover:text-white"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 p-6 space-y-4 overflow-y-auto">
                    <div>
                        <label className="block text-sm font-medium text-secondary-300 mb-2">
                            Describe your feedback (required)
                        </label>
                        <div className="relative group">
                            <textarea
                                value={feedback}
                                onChange={(e) => setFeedback(e.target.value)}
                                placeholder="Tell us what prompted this feedback..."
                                className="w-full h-48 bg-[#2d2d2d] border border-[#444] rounded-lg p-4 text-white placeholder-secondary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all resize-none text-sm"
                                autoFocus
                            />
                        </div>
                    </div>

                    <div className="flex items-start gap-3 p-3 rounded-lg bg-[#2d2d2d]/50 border border-[#333]">
                        <Info size={18} className="text-secondary-400 mt-0.5" />
                        <p className="text-xs text-secondary-400 leading-relaxed">
                            Please don't include any sensitive information. We use this feedback to improve our services and features.
                        </p>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 bg-[#252525] border-t border-[#333] flex items-center justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-secondary-400 hover:text-white transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!feedback.trim() || isSubmitting}
                        className={`px-6 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold shadow-lg transition-all transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center gap-2`}
                    >
                        {isSubmitting ? (
                            <>
                                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                                Sending...
                            </>
                        ) : 'Send'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default FeedbackModal;
