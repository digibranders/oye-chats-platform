import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { FeedbackModal, type FeedbackTab } from './feedback/FeedbackModal';
import { useTranslation } from '../i18n/useTranslation';

/**
 * The right-edge "Feedback" tab (desktop-only) that opens the admin →
 * OyeChats product-feedback modal. Mounted once in `AppShell`, so it appears
 * on every authenticated page.
 *
 * `md:flex` rather than a JS viewport check: a fixed vertical tab at 375px
 * would sit over live content with nowhere to go, so it is a CSS-only
 * breakpoint rather than a component that mounts and unmounts.
 */
export function FeedbackLauncher(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<FeedbackTab>('send');
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Deep-link from a "feedback resolved" notification: `?feedback=<id>` opens
  // the modal on the My-feedback tab and highlights the row, then strips the
  // param so a refresh or back navigation does not re-open it.
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
        aria-label={t('shell.feedback.send') || 'Send feedback'}
        title={t('shell.feedback.send') || 'Send feedback'}
        // `--z-topbar`, not `--z-overlay`: this button is permanent chrome, not
        // a transient surface, and it must sit under the scrim the moment any
        // dialog opens — including its own.
        className="fixed end-0 top-1/2 z-[var(--z-topbar)] hidden w-11 -translate-y-1/2 flex-col items-center justify-center gap-3.5 rounded-s-lg bg-accent-500 py-6 text-text-inverse shadow-md transition-colors hover:bg-accent-600 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent-700)] md:flex"
      >
        <MessageCircle aria-hidden className="h-icon-sm w-icon-sm" />
        <span
          className="select-none whitespace-nowrap text-sm font-semibold tracking-eyebrow"
          style={{ writingMode: 'vertical-lr', transform: 'rotate(360deg)' }}
        >
          {t('shell.feedback.label') || 'Feedback'}
        </span>
      </button>

      {/* Remounting on tab-change (via `key`) means a fresh instance always
          opens with the requested tab pre-selected, instead of syncing
          `defaultTab` into already-mounted state. */}
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
