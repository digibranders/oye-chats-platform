import { useState, useRef } from 'react';
import { X, Bug, Lightbulb, Monitor, Gauge, MoreHorizontal, Paperclip, AlertCircle, Info, ArrowRight, MessageSquare } from 'lucide-react';
import { uploadFeedbackAttachment } from '../services/api';
import { cn } from '../lib/utils';

const FeedbackModal = ({ isOpen, onClose, onSubmit }) => {
  const [feedback, setFeedback] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [attachment, setAttachment] = useState(null);
  const [attachmentError, setAttachmentError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setAttachmentError('File size exceeds the 10MB limit.');
      setAttachment(null);
    } else {
      setAttachmentError('');
      setAttachment(file);
    }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const pastedFile = new File([file], `screenshot_${Date.now()}.png`, { type: file.type });
          if (pastedFile.size > 10 * 1024 * 1024) {
            setAttachmentError('Pasted screenshot size exceeds 10MB.');
          } else {
            setAttachment(pastedFile);
            setAttachmentError('');
          }
          e.preventDefault();
        }
      }
    }
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    setAttachmentError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleSubmit = async () => {
    if (!feedback.trim()) return;
    setIsSubmitting(true);
    setAttachmentError('');
    try {
      let attachmentUrl = null;
      if (attachment) {
        const uploadRes = await uploadFeedbackAttachment(attachment);
        attachmentUrl = uploadRes.url;
      }
      await onSubmit(feedback, selectedCategory || 'other', attachmentUrl);
      setFeedback('');
      setAttachment(null);
      setSelectedCategory(null);
      onClose();
    } catch (error) {
      console.error("Failed to submit feedback:", error);
      setAttachmentError('Failed to upload attachment or submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const categories = [
    { id: 'bug', label: 'Bug', icon: Bug },
    { id: 'feature', label: 'Feature Request', icon: Lightbulb },
    { id: 'ui_ux', label: 'UI / UX', icon: Monitor },
    { id: 'performance', label: 'Performance', icon: Gauge },
    { id: 'other', label: 'Other', icon: MoreHorizontal },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-end sm:items-center sm:justify-center p-4 sm:p-0">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-lg bg-[#0e0e14] border border-[#232335] text-white rounded-[20px] shadow-2xl transform transition-all overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
          <div className="flex gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-full bg-[#1b1b2d] border border-[#2b2b42] shrink-0">
              <MessageSquare size={20} className="text-[#817bfb]" />
            </div>
            <div>
              <h2 className="text-[17px] font-semibold text-white leading-tight">Send Feedback</h2>
              <p className="text-[13px] text-[#8f8f9e] mt-1">We&apos;d love to hear your thoughts and help us improve OyeChats.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-[#1b1b29] hover:bg-[#252538] border border-[#27273b] transition-colors text-[#a0a0b0] hover:text-white"
            aria-label="Close modal"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 px-6 py-4 space-y-5 overflow-y-auto">
          {/* Category Selector */}
          <div className="space-y-2.5">
            <label className="block text-[13px] font-semibold text-[#efeff1]">
              What type of feedback is this?
            </label>
            <div className="flex flex-wrap gap-2">
              {categories.map((cat) => {
                const Icon = cat.icon;
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={cn(
                      "flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-xs font-medium border transition-all cursor-pointer",
                      isSelected
                        ? "bg-[#6366f1]/10 border-[#6366f1] text-white ring-1 ring-[#6366f1]/30"
                        : "bg-[#13131c]/50 hover:bg-[#181826] border-[#232335] text-[#a0a0b0]"
                    )}
                  >
                    <Icon size={14} className={isSelected ? "text-[#817bfb]" : "text-[#707080]"} />
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Feedback Input Card */}
          <div className="space-y-2">
            <label className="block text-[13px] font-semibold text-[#efeff1]">
              Describe your feedback <span className="text-[#8f8f9e] font-normal">(required)</span>
            </label>
            <div className="group bg-[#13131c] border border-[#232335] rounded-xl focus-within:border-[#6366f1] focus-within:ring-1 focus-within:ring-[#6366f1]/20 transition-all duration-200 flex flex-col overflow-hidden">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onPaste={handlePaste}
                placeholder="What could we improve? Tell us what happened or what you'd like to see..."
                className="w-full h-36 bg-transparent border-0 p-4 pb-2 text-white placeholder-[#585868] focus:outline-none resize-none text-sm leading-relaxed"
                autoFocus
              />
              
              {/* Attachment bar */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-[#1f1f2e]/60 bg-[#161622]/40">
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  
                  {!attachment ? (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="p-1.5 rounded-lg hover:bg-[#20202e] text-[#707080] hover:text-white transition-colors cursor-pointer"
                      title="Attach file or paste screenshot (max 10MB)"
                    >
                      <Paperclip size={18} />
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 px-3 py-1 bg-[#6366f1]/10 border border-[#6366f1]/30 rounded-full text-xs text-[#817bfb] max-w-[320px]">
                      <Paperclip size={12} className="flex-shrink-0" />
                      <span className="truncate max-w-[160px] font-medium">{attachment.name}</span>
                      <span className="text-[10px] text-[#707080] flex-shrink-0">({formatBytes(attachment.size)})</span>
                      <button
                        type="button"
                        onClick={handleRemoveAttachment}
                        className="p-0.5 rounded-full hover:bg-[#6366f1]/20 text-[#707080] hover:text-[#ff6b6b] transition-colors cursor-pointer flex-shrink-0"
                        title="Remove attachment"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {attachmentError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-950/10 border border-red-900/30 p-3 rounded-xl">
              <AlertCircle size={14} className="flex-shrink-0" />
              <span>{attachmentError}</span>
            </div>
          )}

          {/* Privacy/Info Disclaimer */}
          <div className="flex items-start gap-2.5 py-1 px-0.5">
            <Info size={16} className="text-[#707080] mt-0.5 shrink-0" />
            <p className="text-xs text-[#8f8f9e] leading-relaxed">
              Don&apos;t include passwords, API keys, or any sensitive information.<br />
              Your feedback is private and helps us improve.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-5 border-t border-[#1f1f2e] flex items-center justify-end gap-4 bg-[#0e0e14]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-[#8f8f9e] hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!feedback.trim() || isSubmitting}
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#594fe2] to-[#4036cb] hover:from-[#6b62eb] hover:to-[#4e43dc] disabled:from-[#1b1b26] disabled:to-[#1b1b26] disabled:text-[#585868] text-white text-sm font-semibold shadow-lg hover:shadow-[#4f46e5]/10 disabled:shadow-none transition-all flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                Sending...
              </>
            ) : (
              <>
                Send Feedback
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FeedbackModal;
