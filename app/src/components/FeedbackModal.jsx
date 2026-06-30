import { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Bug,
  Lightbulb,
  Monitor,
  Gauge,
  MoreHorizontal,
  Paperclip,
  AlertCircle,
  Info,
  ArrowRight,
  MessageSquare,
  Clock,
  Loader2,
  CheckCircle2,
  Archive,
  Inbox,
  RefreshCw,
} from 'lucide-react';
import { uploadFeedbackAttachment, getMyFeedback } from '../services/api';
import { cn } from '../lib/utils';

const STATUS_META = {
  open: { label: 'Open', icon: Clock, className: 'bg-amber-500/10 border-amber-500/30 text-amber-300' },
  in_progress: { label: 'In progress', icon: Loader2, className: 'bg-sky-500/10 border-sky-500/30 text-sky-300' },
  resolved: { label: 'Resolved', icon: CheckCircle2, className: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' },
  closed: { label: 'Closed', icon: Archive, className: 'bg-zinc-500/10 border-zinc-500/30 text-zinc-400' },
};

const CATEGORY_LABELS = {
  bug: 'Bug',
  feature: 'Feature Request',
  ui_ux: 'UI / UX',
  performance: 'Performance',
  other: 'Other',
};

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.open;
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border', meta.className)}>
      <Icon size={11} className={status === 'in_progress' ? 'animate-spin' : ''} />
      {meta.label}
    </span>
  );
}

function MyFeedbackList({ highlightId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getMyFeedback();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.message || 'Failed to load your feedback.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[#8f8f9e]">
        <Loader2 size={22} className="animate-spin text-[#817bfb]" />
        <p className="mt-3 text-sm">Loading your feedback…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <AlertCircle size={22} className="text-red-400" />
        <p className="mt-3 text-sm text-[#c0c0cc]">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1b1b29] hover:bg-[#252538] border border-[#27273b] text-[13px] text-white transition-colors"
        >
          <RefreshCw size={13} /> Try again
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[#1b1b2d] border border-[#2b2b42]">
          <Inbox size={22} className="text-[#707080]" />
        </div>
        <p className="mt-4 text-[15px] font-semibold text-white">No feedback yet</p>
        <p className="mt-1.5 text-[13px] text-[#8f8f9e] max-w-[280px]">
          Once you send feedback, you&apos;ll see its status and our response here.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li
          key={item.id}
          className={cn(
            'rounded-xl border bg-[#13131c] p-4 transition-colors',
            highlightId === item.id ? 'border-[#6366f1] ring-1 ring-[#6366f1]/30' : 'border-[#232335]'
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <StatusBadge status={item.status} />
              {item.category && (
                <span className="text-[11px] text-[#8f8f9e] px-2 py-0.5 rounded-full bg-[#1b1b29] border border-[#27273b]">
                  {CATEGORY_LABELS[item.category] || item.category}
                </span>
              )}
            </div>
            <span className="text-[11px] text-[#707080] shrink-0">{formatDate(item.created_at)}</span>
          </div>

          <p className="mt-3 text-[13px] text-[#d6d6de] whitespace-pre-wrap leading-relaxed">{item.message}</p>

          {item.attachment_url && (
            <a
              href={item.attachment_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] text-[#817bfb] hover:text-[#9a94ff] transition-colors"
            >
              <Paperclip size={12} /> View attachment
            </a>
          )}

          {item.admin_response && (
            <div className="mt-3 rounded-lg border border-[#6366f1]/25 bg-[#6366f1]/[0.07] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#817bfb] mb-1.5 flex items-center gap-1.5">
                <MessageSquare size={11} /> Response from OyeChats
              </p>
              <p className="text-[13px] text-[#d6d6de] whitespace-pre-wrap leading-relaxed">{item.admin_response}</p>
              {item.resolved_at && (
                <p className="mt-2 text-[11px] text-[#707080]">Resolved {formatDate(item.resolved_at)}</p>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const FeedbackModal = ({ isOpen, onClose, onSubmit, defaultTab = 'send', highlightId = null }) => {
  const [activeTab, setActiveTab] = useState(defaultTab);
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
      // Drop the user on their history so they can see the submission landed.
      setActiveTab('mine');
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

  const tabs = [
    { id: 'send', label: 'Send Feedback' },
    { id: 'mine', label: 'My Feedback' },
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
              <h2 className="text-[17px] font-semibold text-white leading-tight">Feedback</h2>
              <p className="text-[13px] text-[#8f8f9e] mt-1">
                {activeTab === 'send'
                  ? "We'd love to hear your thoughts and help us improve OyeChats."
                  : 'Track the status of feedback you’ve sent and read our responses.'}
              </p>
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

        {/* Tabs */}
        <div className="px-6">
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-xl bg-[#13131c] border border-[#232335]">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'px-3.5 h-8 rounded-lg text-[13px] font-medium transition-all cursor-pointer',
                  activeTab === t.id
                    ? 'bg-[#1f1f2e] text-white shadow-sm'
                    : 'text-[#8f8f9e] hover:text-white'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 px-6 py-4 space-y-5 overflow-y-auto">
          {activeTab === 'send' ? (
            <>
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
            </>
          ) : (
            <MyFeedbackList highlightId={highlightId} />
          )}
        </div>

        {/* Footer — only on the compose tab */}
        {activeTab === 'send' && (
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
        )}
      </div>
    </div>
  );
};

export default FeedbackModal;
