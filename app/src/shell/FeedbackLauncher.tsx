import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { FeedbackModal, type FeedbackTab } from './feedback/FeedbackModal';

/**
 * FeedbackLauncher — the right-edge "Feedback" tab (desktop-only) that opens
 * the admin → OyeChats product-feedback modal (`FeedbackModal`). Mounted once
 * in `AppShell`, so it appears on every authenticated page but never on
 * Launch Studio, a full-screen onboarding route rendered outside the shell.
 *
 * Reskinned from the legacy `layouts/AdminLayout.jsx` launcher: a restrained
 * `--ds-accent` tab with a hairline focus ring, not the old magenta
 * gradient/glow (the mandate forbids purple overload and giant gradients).
 */
export function FeedbackLauncher(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<FeedbackTab>('send');
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Deep-link from the "feedback resolved" push notification: `?feedback=<id>`
  // opens the modal on the My-feedback tab and highlights the row, then strips
  // the param so a refresh/back doesn't re-open it.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('feedback')) return;
    const raw = params.get('feedback');
    const id = Number(raw);
    setTab('mine');
    setHighlightId(Number.isInteger(id) && id > 0 ? id : null);
    setOpen(true);
    params.delete('feedback');
    const qs = params.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}`, { replace: true });
    // Re-running only on `location.search` changing is intentional: `navigate`
    // and `location.pathname` are stable/derived for the same navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const openLauncher = useCallback((): void => {
    setTab('send');
    setHighlightId(null);
    setOpen(true);
  }, []);

  const close = useCallback((): void => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={openLauncher}
        aria-label="Send feedback"
        title="Send feedback"
        className="fixed right-0 top-1/2 z-40 hidden w-11 -translate-y-1/2 flex-col items-center justify-center gap-3.5 rounded-l-[var(--ds-radius-lg)] bg-[var(--ds-accent)] py-6 text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-md)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] md:flex"
      >
        <MessageCircle size={18} aria-hidden="true" />
        <span
          className="select-none whitespace-nowrap text-[13px] font-semibold tracking-[0.08em]"
          style={{ writingMode: 'vertical-lr', transform: 'rotate(360deg)' }}
        >
          Feedback
        </span>
      </button>

      {/* Remounting on tab-change (via `key`) mirrors the legacy launcher: a
          fresh instance always opens with the requested tab pre-selected,
          instead of syncing `defaultTab` into already-mounted state. */}
      <FeedbackModal
        key={open ? `feedback-${tab}` : 'feedback-closed'}
        open={open}
        onClose={close}
        defaultTab={tab}
        highlightId={highlightId}
      />
    </>
  );
}
