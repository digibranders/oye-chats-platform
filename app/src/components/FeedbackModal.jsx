import { useState } from 'react';
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
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div className="relative w-full max-w-lg bg-surface-900 text-white rounded-2xl shadow-2xl border border-surface-800 transform transition-all overflow-hidden flex flex-col h-[500px]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-800">
          <h2 className="text-xl font-semibold">Send feedback</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-surface-800 transition-colors text-surface-400 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 p-6 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-2">
              Describe your feedback (required)
            </label>
            <div className="relative group">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Tell us what prompted this feedback..."
                className="w-full h-48 bg-surface-800 border border-surface-700 rounded-lg p-4 text-white placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all resize-none text-sm"
                autoFocus
              />
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-800/50 border border-surface-700">
            <Info size={18} className="text-surface-400 mt-0.5" />
            <p className="text-xs text-surface-400 leading-relaxed">
              Please don&apos;t include any sensitive information. We use this feedback to improve our services and features.
            </p>
          </div>
        </div>

        <div className="px-6 py-4 bg-surface-800/50 border-t border-surface-800 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-surface-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!feedback.trim() || isSubmitting}
            className="px-6 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold shadow-lg transition-all transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center gap-2"
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
