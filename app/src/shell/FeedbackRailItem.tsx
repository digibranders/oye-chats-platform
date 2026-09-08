import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { RailItem } from '../ui';
import { FeedbackModal, type FeedbackTab } from './feedback/FeedbackModal';
import { navLabel } from './navCopy';
import { useTranslation } from '../i18n/useTranslation';

/**
 * The rail's "Feedback" row, directly above Billing. It opens the admin →
 * OyeChats product-feedback modal — the in-app one, with a "my feedback" tab
 * and status tracking. This used to be a fixed pill on the right edge of every
 * page; that surface was mounted globally in `AppShell` and read like it lived
 * outside the product it was reporting on, so it is a rail row like every
 * other destination now.
 */
export function FeedbackRailItem({ collapsed }: { collapsed: boolean }): ReactElement {
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
      <RailItem
        label={navLabel(t('shell.feedback.label') || 'Feedback')}
        collapsed={collapsed}
        onClick={openLauncher}
        glyph={<MessageCircle aria-hidden className="h-icon-md w-icon-md" />}
      />

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
