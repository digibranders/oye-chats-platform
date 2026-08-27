import { useEffect, useState, type ReactElement } from 'react';
import { Bell, BellOff, Loader2, ShieldAlert, X, type LucideIcon } from 'lucide-react';
import { Button, cn } from '../design-system';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { useNotifications } from '../context/NotificationContext';
import { useTranslation } from '../i18n/useTranslation';

/** Once dismissed, stay hidden for this long so we never nag. */
const DISMISS_KEY = 'oyechats:push_nudge_dismissed_at';
const DISMISS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function wasDismissedRecently(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_WINDOW_MS;
  } catch {
    return false;
  }
}

interface Variant {
  icon: LucideIcon;
  wrapClassName: string;
  title: string;
  body: string;
  actionLabel: string;
  /** Dictionary keys. This table is a module constant, evaluated at import
   *  before any locale exists, so the strings above are the inline fallbacks
   *  and the component resolves these keys at render time. */
  titleKey: string;
  bodyKey: string;
  actionLabelKey: string;
}

const VARIANTS: Record<'default' | 'denied' | 'error', Variant> = {
  default: {
    icon: Bell,
    wrapClassName: 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]',
    titleKey: 'shell.pushNudge.default.title',
    title: 'Stay reachable when this tab is closed',
    bodyKey: 'shell.pushNudge.default.body',
    body: 'Turn on browser notifications and we’ll alert you the moment a visitor wants to chat.',
    actionLabelKey: 'shell.pushNudge.default.action',
    actionLabel: 'Enable notifications',
  },
  denied: {
    icon: BellOff,
    wrapClassName: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]',
    titleKey: 'shell.pushNudge.denied.title',
    title: 'Notifications are blocked in your browser',
    bodyKey: 'shell.pushNudge.denied.body',
    body: 'Click the lock icon next to the address bar → Notifications → Allow, then re-check below.',
    actionLabelKey: 'shell.pushNudge.denied.action',
    actionLabel: 'Re-check permission',
  },
  error: {
    icon: ShieldAlert,
    wrapClassName: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]',
    titleKey: 'shell.pushNudge.error.title',
    title: 'Notifications couldn’t be turned on',
    bodyKey: 'shell.pushNudge.error.body',
    body: 'Something went wrong enabling push on this device.',
    actionLabelKey: 'shell.pushNudge.error.action',
    actionLabel: 'Try again',
  },
};

/**
 * PushPermissionNudge - app-wide floating card inviting the operator to enable
 * browser push, redesigned from the legacy console's `PushPermissionBanner` for
 * the 2.0 design system. Shares its state with the Settings ▸ Notifications
 * card via {@link usePushSubscription} so the two surfaces never disagree.
 *
 * Shown only for the genuinely actionable states - `default` (never asked),
 * `denied` (blocked, recoverable), and `error` (subscribe attempt failed).
 * Silent while `checking`/`unsupported`/`subscribed`, and silent for
 * `incomplete`/`disabled` too: those mean either the operator deliberately
 * turned push off (their call to revisit in Settings, not to be nagged about)
 * or the server hasn't configured push (nothing the operator can do about it).
 *
 * Suppressed while {@link IncomingChatBanner} occupies the same bottom-right
 * corner for a live handoff - that banner is time-critical and wins. Dismissal
 * persists for 3 days per device. Mounted once in `AppShell`.
 */
export function PushPermissionNudge(): ReactElement | null {
  const { t } = useTranslation();
  const { phase, busy, enable, recheck } = usePushSubscription();
  const { incomingHandoff } = useNotifications();
  const [dismissed, setDismissed] = useState<boolean>(wasDismissedRecently);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const dismiss = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* localStorage unavailable - it reappears next mount, which is acceptable. */
    }
  };

  const variantKey: keyof typeof VARIANTS | null =
    phase.status === 'default' || phase.status === 'denied' || phase.status === 'error'
      ? phase.status
      : null;

  if (!variantKey || dismissed || incomingHandoff) return null;

  const variant = VARIANTS[variantKey];
  // A provider message is server text and passes through untranslated; the
  // canned copy resolves through the dictionary.
  const body =
    phase.status === 'error' && phase.message
      ? phase.message
      : t(variant.bodyKey) || variant.body;
  const onAction = variantKey === 'default' ? enable : recheck;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-5 right-5 z-[55] w-[min(22rem,calc(100vw-2.5rem))] rounded-[var(--ds-radius-xl)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)] transition-all duration-300 ease-out',
        mounted ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            variant.wrapClassName,
          )}
        >
          <variant.icon size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[var(--ds-text)]">
            {t(variant.titleKey) || variant.title}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">{body}</p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              variant={variantKey === 'default' ? 'primary' : 'outline'}
              onClick={() => void onAction()}
              disabled={busy}
            >
              {busy ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : null}
              {t(variant.actionLabelKey) || variant.actionLabel}
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {t('shell.pushNudge.notNow') || 'Not now'}
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label={t('common.dismiss') || 'Dismiss'}
          onClick={dismiss}
          className="-mr-1 -mt-1 rounded-md p-1 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
