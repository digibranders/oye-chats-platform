import { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Bug,
  Lightbulb,
  HelpCircle,
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
  ImagePlus,
  ChevronDown,
  Check,
} from 'lucide-react';
import { uploadFeedbackAttachment, getMyFeedback } from '../services/api';
import useEntitlements from '../hooks/useEntitlements';
import { cn } from '../lib/utils';

const MAX_ATTACHMENTS = 5;
const MAX_SIZE = 10 * 1024 * 1024;

const TYPES = [
  { id: 'bug', label: 'Bug', icon: Bug },
  { id: 'feature_request', label: 'Feature', icon: Lightbulb },
  { id: 'question', label: 'Question', icon: HelpCircle },
  { id: 'other', label: 'Other', icon: MoreHorizontal },
];

const AREAS = [
  { id: 'billing', label: 'Billing' },
  { id: 'bots', label: 'Bots' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'live_chat', label: 'Live chat' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'widget', label: 'Widget' },
  { id: 'other', label: 'Other' },
];

const SEVERITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'critical', label: 'Critical' },
];

const TYPE_LABELS = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
const AREA_LABELS = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const SEVERITY_LABELS = Object.fromEntries(SEVERITIES.map((s) => [s.id, s.label]));

const STATUS_META = {
  open: { label: 'Open', icon: Clock, className: 'bg-amber-50 border-amber-200 text-amber-700' },
  in_progress: { label: 'In progress', icon: Loader2, className: 'bg-primary-50 border-primary-200 text-primary-700' },
  resolved: { label: 'Resolved', icon: CheckCircle2, className: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  closed: { label: 'Closed', icon: Archive, className: 'bg-surface-100 border-surface-200 text-surface-500' },
};

const SEVERITY_TONE = {
  low: 'bg-surface-100 border-surface-200 text-surface-600',
  medium: 'bg-primary-50 border-primary-200 text-primary-700',
  high: 'bg-amber-50 border-amber-200 text-amber-700',
  critical: 'bg-rose-50 border-rose-200 text-rose-700',
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

function MetaPill({ children }) {
  return (
    <span className="text-[11px] text-surface-500 px-2 py-0.5 rounded-full bg-surface-100 border border-surface-200">
      {children}
    </span>
  );
}

function AttachmentThumbs({ attachments }) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((att, i) => (
        <a
          key={att.url || i}
          href={att.url}
          target="_blank"
          rel="noopener noreferrer"
          title={att.name || 'Attachment'}
          className="group relative w-16 h-16 rounded-lg overflow-hidden border border-surface-200 bg-surface-100"
        >
          <img src={att.url} alt={att.name || 'attachment'} className="w-full h-full object-cover" loading="lazy" />
        </a>
      ))}
    </div>
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
      <div className="flex flex-col items-center justify-center py-16 text-surface-500">
        <Loader2 size={22} className="animate-spin text-primary-500" />
        <p className="mt-3 text-sm">Loading your feedback…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <AlertCircle size={22} className="text-rose-500" />
        <p className="mt-3 text-sm text-surface-600">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-surface-100 hover:bg-surface-200 border border-surface-200 text-[13px] text-surface-700 transition-colors"
        >
          <RefreshCw size={13} /> Try again
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-surface-100 border border-surface-200">
          <Inbox size={22} className="text-surface-400" />
        </div>
        <p className="mt-4 text-[15px] font-semibold text-surface-900">No feedback yet</p>
        <p className="mt-1.5 text-[13px] text-surface-500 max-w-[280px]">
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
            'rounded-xl border bg-[var(--bg-card)] p-4 transition-colors',
            highlightId === item.id ? 'border-primary-500 ring-1 ring-primary-500/30' : 'border-surface-200'
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <StatusBadge status={item.status} />
              {item.type && <MetaPill>{TYPE_LABELS[item.type] || item.type}</MetaPill>}
              {item.area && <MetaPill>{AREA_LABELS[item.area] || item.area}</MetaPill>}
              {item.severity && (
                <span
                  className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border',
                    SEVERITY_TONE[item.severity] || SEVERITY_TONE.low
                  )}
                >
                  {SEVERITY_LABELS[item.severity] || item.severity}
                </span>
              )}
            </div>
            <span className="text-[11px] text-surface-400 shrink-0 tabular-nums">{formatDate(item.created_at)}</span>
          </div>

          <p className="mt-3 text-[13px] text-surface-700 whitespace-pre-wrap leading-relaxed">{item.message}</p>

          <AttachmentThumbs attachments={item.attachments} />

          {item.admin_response && (
            <div className="mt-3 rounded-lg border border-primary-200 bg-primary-50 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary-600 mb-1.5 flex items-center gap-1.5">
                <MessageSquare size={11} /> Response from OyeChats
              </p>
              <p className="text-[13px] text-surface-700 whitespace-pre-wrap leading-relaxed">{item.admin_response}</p>
              {item.resolved_at && (
                <p className="mt-2 text-[11px] text-surface-400 tabular-nums">Resolved {formatDate(item.resolved_at)}</p>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// Custom dropdown (not the browser-native <select>) so the menu matches the
// modal's light theme. Controlled: `value` is the selected option id, `""` for
// the placeholder/none option.
function SelectMenu({ id, value, onChange, options, placeholder = 'Select…' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.id === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        id={id}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full h-10 flex items-center justify-between gap-2 rounded-xl bg-white border border-surface-200 px-3 text-[13px] text-left outline-none hover:border-surface-300 focus:border-[var(--focus)] focus:ring-1 focus:ring-[var(--focus-ring)] transition-colors cursor-pointer"
      >
        <span className={cn('truncate', selected && selected.id ? 'text-surface-900' : 'text-surface-400')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={15}
          className={cn('shrink-0 text-surface-400 transition-transform duration-150', open && 'rotate-180')}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1.5 w-full max-h-56 overflow-auto rounded-xl border border-surface-200 bg-white p-1 shadow-xl"
        >
          {options.map((o) => {
            const active = o.id === value;
            return (
              <li key={o.id || 'none'}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-[13px] text-left transition-colors cursor-pointer',
                    active ? 'bg-primary-50 text-surface-900' : 'text-surface-600 hover:bg-surface-100'
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {active && <Check size={14} className="shrink-0 text-primary-600" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const FeedbackModal = ({ isOpen, onClose, onSubmit, defaultTab = 'send', highlightId = null }) => {
  const [activeTab, setActiveTab] = useState(defaultTab);
  const [message, setMessage] = useState('');
  const [type, setType] = useState(null);
  const [area, setArea] = useState('');
  const [severity, setSeverity] = useState(null);
  const [attachments, setAttachments] = useState([]); // {id,name,content_type,previewUrl,url,status,error}
  const [attachmentError, setAttachmentError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef(null);
  const uidRef = useRef(0);
  const { entitlements } = useEntitlements();

  // Upload one File: optimistic entry with a local preview, then swap in the
  // hosted URL when the upload resolves (or flag the entry on failure).
  const addFiles = useCallback((files) => {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    setAttachmentError('');

    setAttachments((prev) => {
      const slots = MAX_ATTACHMENTS - prev.length;
      if (slots <= 0) {
        setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} screenshots.`);
        return prev;
      }
      const accepted = [];
      for (const file of incoming.slice(0, slots)) {
        if (file.size > MAX_SIZE) {
          setAttachmentError('Each file must be 10MB or smaller.');
          continue;
        }
        const id = ++uidRef.current;
        const entry = {
          id,
          name: file.name,
          content_type: file.type,
          previewUrl: URL.createObjectURL(file),
          url: null,
          status: 'uploading',
        };
        accepted.push(entry);
        uploadFeedbackAttachment(file)
          .then((res) => {
            setAttachments((cur) =>
              cur.map((a) => (a.id === id ? { ...a, url: res.url, status: 'done' } : a))
            );
          })
          .catch(() => {
            setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, status: 'error' } : a)));
          });
      }
      return [...prev, ...accepted];
    });
  }, []);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleFileChange = (e) => {
    addFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Paste-anywhere: a document-level listener active only while the modal is
  // open and on the compose tab catches screenshots regardless of focus.
  useEffect(() => {
    if (!isOpen || activeTab !== 'send') return undefined;
    const onPaste = (e) => {
      const imageFiles = Array.from(e.clipboardData?.items || [])
        .filter((it) => it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean)
        .map((f, i) => new File([f], f.name || `screenshot_${Date.now()}_${i}.png`, { type: f.type }));
      if (imageFiles.length) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [isOpen, activeTab, addFiles]);

  // Revoke any object URLs still held when the modal unmounts.
  useEffect(() => {
    return () => {
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isOpen) return null;

  const uploading = attachments.some((a) => a.status === 'uploading');
  const canSubmit = !!message.trim() && !!type && !isSubmitting && !uploading;

  const captureContext = () => ({
    page_url: `${window.location.pathname}${window.location.search}`,
    app_version: import.meta.env.VITE_APP_VERSION || 'unknown',
    plan_tier: entitlements?.planName || undefined,
    user_agent: navigator.userAgent,
  });

  const resetForm = () => {
    attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setMessage('');
    setType(null);
    setArea('');
    setSeverity(null);
    setAttachments([]);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setAttachmentError('');
    try {
      const payload = {
        message,
        type,
        area: area || null,
        severity: type === 'bug' ? severity : null,
        context: captureContext(),
        attachments: attachments
          .filter((a) => a.status === 'done' && a.url)
          .map((a) => ({ url: a.url, name: a.name, content_type: a.content_type })),
      };
      await onSubmit(payload);
      resetForm();
      setActiveTab('mine');
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      setAttachmentError('Failed to submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const tabs = [
    { id: 'send', label: 'Send Feedback' },
    { id: 'mine', label: 'My Feedback' },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-end sm:items-center sm:justify-center p-4 sm:p-0">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-surface-900/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-lg bg-[var(--bg-card)] border border-surface-200 text-surface-900 rounded-2xl shadow-xl transform transition-all overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
          <div className="flex gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-full bg-primary-50 border border-primary-200 shrink-0">
              <MessageSquare size={20} className="text-primary-600" />
            </div>
            <div>
              <h2 className="text-[17px] font-semibold text-surface-900 leading-tight">Feedback</h2>
              <p className="text-[13px] text-surface-500 mt-1">
                {activeTab === 'send'
                  ? "We'd love to hear your thoughts and help us improve OyeChats."
                  : 'Track the status of feedback you’ve sent and read our responses.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-surface-100 hover:bg-surface-200 border border-surface-200 transition-colors text-surface-500 hover:text-surface-900"
            aria-label="Close modal"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6">
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-xl bg-surface-100 border border-surface-200">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'px-3.5 h-8 rounded-lg text-[13px] font-medium transition-all cursor-pointer',
                  activeTab === t.id ? 'bg-white text-surface-900 shadow-sm' : 'text-surface-500 hover:text-surface-900'
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
              {/* Type (required) */}
              <div className="space-y-2.5">
                <label className="block text-[13px] font-semibold text-surface-900">
                  What type of feedback is this? <span className="text-surface-400 font-normal">(required)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {TYPES.map((t) => {
                    const Icon = t.icon;
                    const selected = type === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setType(t.id)}
                        className={cn(
                          'flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-xs font-medium border transition-all cursor-pointer',
                          selected
                            ? 'bg-primary-50 border-primary-500 text-surface-900 ring-1 ring-primary-500/30'
                            : 'bg-white hover:bg-surface-50 border-surface-200 text-surface-600'
                        )}
                      >
                        <Icon size={14} className={selected ? 'text-primary-600' : 'text-surface-400'} />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Area (optional) — custom dropdown */}
              <div className="space-y-2">
                <label htmlFor="fb-area" className="block text-[13px] font-semibold text-surface-900">
                  Area <span className="text-surface-400 font-normal">(optional)</span>
                </label>
                <SelectMenu
                  id="fb-area"
                  value={area}
                  onChange={setArea}
                  placeholder="Not sure / unspecified"
                  options={[{ id: '', label: 'Not sure / unspecified' }, ...AREAS]}
                />
              </div>

              {/* Severity (bug-only) — one line */}
              {type === 'bug' && (
                <div className="space-y-2">
                  <label className="block text-[13px] font-semibold text-surface-900">
                    Severity <span className="text-surface-400 font-normal">(optional)</span>
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {SEVERITIES.map((s) => {
                      const selected = severity === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setSeverity(selected ? null : s.id)}
                          className={cn(
                            'h-9 rounded-lg text-[12px] font-medium border transition-all cursor-pointer text-center',
                            selected
                              ? 'bg-primary-50 border-primary-500 text-surface-900 ring-1 ring-primary-500/30'
                              : 'bg-white hover:bg-surface-50 border-surface-200 text-surface-600'
                          )}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Message + attachments */}
              <div className="space-y-2">
                <label className="block text-[13px] font-semibold text-surface-900">
                  Describe your feedback <span className="text-surface-400 font-normal">(required)</span>
                </label>
                <div className="group bg-white border border-surface-200 rounded-xl focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500/20 transition-all duration-200 flex flex-col overflow-hidden">
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="What happened or what would you like to see? Paste a screenshot anywhere in this dialog to attach it."
                    className="w-full h-32 bg-transparent border-0 p-4 pb-2 text-surface-900 placeholder-surface-400 focus:outline-none resize-none text-sm leading-relaxed"
                    autoFocus
                  />

                  {/* Attachment toolbar + thumbnails */}
                  <div className="px-4 py-2.5 border-t border-surface-200 bg-surface-50 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept="image/*"
                        multiple
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={attachments.length >= MAX_ATTACHMENTS}
                        className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg hover:bg-surface-100 text-surface-600 hover:text-surface-900 transition-colors cursor-pointer text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Attach screenshots or paste from clipboard (max 5, 10MB each)"
                      >
                        <ImagePlus size={15} /> Add screenshot
                      </button>
                      <span className="text-[11px] text-surface-400">or paste from clipboard</span>
                    </div>

                    {attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {attachments.map((att) => (
                          <div
                            key={att.id}
                            className="group/att relative w-16 h-16 rounded-lg overflow-hidden border border-surface-200 bg-surface-100"
                          >
                            <img src={att.previewUrl} alt={att.name} className="w-full h-full object-cover" />
                            {att.status === 'uploading' && (
                              <div className="absolute inset-0 flex items-center justify-center bg-surface-900/40">
                                <Loader2 size={16} className="animate-spin text-white" />
                              </div>
                            )}
                            {att.status === 'error' && (
                              <div className="absolute inset-0 flex items-center justify-center bg-rose-50/90" title="Upload failed">
                                <AlertCircle size={16} className="text-rose-500" />
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => removeAttachment(att.id)}
                              className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-surface-900/60 text-white opacity-0 group-hover/att:opacity-100 transition-opacity hover:bg-rose-600"
                              title="Remove"
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {attachmentError && (
                <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 p-3 rounded-xl">
                  <AlertCircle size={14} className="flex-shrink-0" />
                  <span>{attachmentError}</span>
                </div>
              )}

              {/* Privacy/Info Disclaimer */}
              <div className="flex items-start gap-2.5 py-1 px-0.5">
                <Info size={16} className="text-surface-400 mt-0.5 shrink-0" />
                <p className="text-xs text-surface-500 leading-relaxed">
                  Don&apos;t include passwords, API keys, or any sensitive information.<br />
                  We attach your current page, app version, plan, and browser to help us triage.
                </p>
              </div>
            </>
          ) : (
            <MyFeedbackList highlightId={highlightId} />
          )}
        </div>

        {/* Footer — only on the compose tab */}
        {activeTab === 'send' && (
          <div className="px-6 py-5 border-t border-surface-200 flex items-center justify-end gap-4 bg-[var(--bg-card)]">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-surface-500 hover:text-surface-900 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="px-5 py-2.5 rounded-xl bg-primary-600 hover:bg-primary-700 disabled:bg-surface-200 disabled:text-surface-400 text-white text-sm font-semibold shadow-sm shadow-primary-500/20 hover:shadow-md hover:shadow-primary-500/30 disabled:shadow-none transition-all flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Sending...
                </>
              ) : uploading ? (
                <>Uploading…</>
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
