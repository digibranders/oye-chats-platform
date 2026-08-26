import { type ReactElement, useEffect, useState } from 'react';
import {
  Bell,
  BellOff,
  Check,
  Download,
  Info,
  Loader2,
  MonitorSmartphone,
  ShieldAlert,
} from 'lucide-react';
import { Button, Card, SectionHeader, StatusBadge } from '../../design-system';
import { usePushSubscription } from '../../hooks/usePushSubscription';
import { useTranslation } from '../../i18n/useTranslation';

// ── Notifications card ───────────────────────────────────────────────────────

function NotificationsCard(): ReactElement {
  const { t } = useTranslation();
  const { phase, busy, actionError, enable, disable, recheck } = usePushSubscription();

  const badge = ((): { tone: 'neutral' | 'success' | 'warning'; label: string } => {
    switch (phase.status) {
      case 'subscribed':
        return { tone: 'success', label: t('settings.enabled') || 'Enabled' };
      case 'denied':
        return { tone: 'warning', label: t('settings.blocked') || 'Blocked' };
      case 'unsupported':
        return { tone: 'neutral', label: t('settings.unavailable') || 'Unavailable' };
      default:
        return { tone: 'neutral', label: t('settings.off') || 'Off' };
    }
  })();

  return (
    <Card>
      <div className="p-5 sm:p-6">
        <SectionHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Bell size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              {t('settings.notifications.title') || 'Browser notifications'}
            </span>
          }
          description={
            t('settings.notifications.description') ||
            'Get alerted the moment a visitor wants to chat, even when this tab is in the background.'
          }
          actions={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
        />

        <div aria-live="polite" className="mt-4 empty:hidden">
          {actionError && (
            <div
              role="alert"
              className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
            >
              {actionError}
            </div>
          )}
        </div>

        <div className="mt-4">
          {phase.status === 'checking' && (
            <p className="flex items-center gap-2 py-1 text-[13px] text-[var(--ds-text-muted)]">
              <Loader2 size={15} aria-hidden="true" className="animate-spin" />
              {t('settings.notifications.checking') || 'Checking notification status…'}
            </p>
          )}

          {phase.status === 'unsupported' && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <ShieldAlert
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {t('settings.notifications.unsupported') ||
                  'This browser doesn’t support web push notifications. Try a recent version of Chrome, Edge, or Firefox on desktop.'}
              </p>
            </div>
          )}

          {phase.status === 'denied' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-4 py-3">
                <BellOff
                  size={16}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-[var(--ds-warning)]"
                />
                <div className="text-[13px] text-[var(--ds-warning)]">
                  <p className="font-medium">
                    {t('settings.notifications.blockedTitle') || 'Notifications are blocked in your browser'}
                  </p>
                  <p className="mt-1 leading-relaxed">
                    {t('settings.notifications.blockedBody') ||
                      'Click the lock icon next to the address bar → Notifications → Allow, then re-check below.'}
                  </p>
                </div>
              </div>
              <Button variant="outline" onClick={recheck}>
                <Bell size={16} aria-hidden="true" />
                {t('settings.notifications.recheck') || 'Re-check permission'}
              </Button>
            </div>
          )}

          {phase.status === 'subscribed' && (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
                <Check size={15} aria-hidden="true" />
                {t('settings.notifications.subscribed') || 'You’re subscribed on this device.'}
              </p>
              <Button variant="outline" onClick={() => void disable()} disabled={busy}>
                {busy ? (
                  <Loader2 size={16} aria-hidden="true" className="animate-spin" />
                ) : (
                  <BellOff size={16} aria-hidden="true" />
                )}
                {t('settings.notifications.turnOff') || 'Turn off'}
              </Button>
            </div>
          )}

          {phase.status === 'default' && (
            <Button onClick={() => void enable()} disabled={busy}>
              {busy ? (
                <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              ) : (
                <Bell size={16} aria-hidden="true" />
              )}
              {t('settings.notifications.enable') || 'Enable notifications'}
            </Button>
          )}

          {phase.status === 'incomplete' && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <div className="text-[13px] text-[var(--ds-text-muted)]">
                <p className="font-medium text-[var(--ds-text)]">
                  {t('settings.notifications.allowedTitle') || 'Notifications are allowed in your browser'}
                </p>
                <p className="mt-1 leading-relaxed">
                  {t('settings.notifications.allowedBody') ||
                    'But web push isn’t fully set up for this dashboard yet - delivering alerts needs the push service key enabled on the server, which isn’t available to the app here. There’s nothing more to do on this device until that’s switched on.'}
                </p>
              </div>
            </div>
          )}

          {phase.status === 'disabled' && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <div className="text-[13px] text-[var(--ds-text-muted)]">
                <p className="font-medium text-[var(--ds-text)]">
                  {t('settings.notifications.disabledTitle') || 'Push notifications aren’t enabled yet'}
                </p>
                <p className="mt-1 leading-relaxed">
                  {t('settings.notifications.disabledBody') ||
                    'Your browser is ready, but web push is currently turned off on the server, so alerts can’t be delivered. It’ll start working here automatically once it’s switched on - nothing more to do on this device.'}
                </p>
              </div>
            </div>
          )}

          {phase.status === 'error' && (
            <div className="space-y-4">
              <div
                role="alert"
                className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
              >
                {phase.message}
              </div>
              <Button variant="outline" onClick={recheck}>
                {t('settings.page.tryAgain') || 'Try again'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Install-as-app (PWA) ─────────────────────────────────────────────────────

/** The `beforeinstallprompt` event isn't in the standard DOM lib - model just what we use. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** True when the app is already running as an installed PWA (standalone display). */
function readInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * InstallAsAppCard - a PWA install affordance for Settings.
 *
 * Honest by construction: we only render a real "Install" button when the
 * browser has actually fired `beforeinstallprompt` (so a click leads to a real
 * native prompt). When that event isn't available - iOS Safari, or a browser
 * that never offers programmatic install - we show platform-appropriate manual
 * guidance instead of a dead button.
 */
function InstallAsAppCard(): ReactElement {
  const { t } = useTranslation();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(readInstalled);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (event: Event): void => {
      // Stop Chrome's mini-infobar so this card owns the install moment.
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setInstalled(true);
      setDeferredPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleInstall = async (): Promise<void> => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // The prompt can only be used once - drop it either way.
      setDeferredPrompt(null);
      if (choice.outcome === 'accepted') setInstalled(true);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Card>
      <div className="p-5 sm:p-6">
        <SectionHeader
          title={
            <span className="inline-flex items-center gap-2">
              <MonitorSmartphone size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              {t('settings.install.title') || 'Install as app'}
            </span>
          }
          description={
            t('settings.install.description') ||
            'Add OyeChats to your dock or home screen so incoming chats reach you even when the browser is closed.'
          }
        />

        <div className="mt-4">
          {installed ? (
            <p className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
              <Check size={15} aria-hidden="true" />
              {t('settings.install.installed') || 'You’re running OyeChats as an installed app on this device.'}
            </p>
          ) : deferredPrompt ? (
            <Button onClick={() => void handleInstall()} disabled={installing}>
              {installing ? (
                <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              ) : (
                <Download size={16} aria-hidden="true" />
              )}
              {installing
                ? t('settings.install.installing') || 'Installing…'
                : t('settings.install.install') || 'Install OyeChats'}
            </Button>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {isIOS() ? (
                  <>
                    {t('settings.install.iosHint') ||
                      'To install, tap the Share icon in Safari, then choose Add to Home Screen.'}
                  </>
                ) : (
                  <>
                    {t('settings.install.genericHint') ||
                      'Your browser doesn’t offer a one-click install here. Open the browser menu and look for Install app or Add to Home Screen.'}
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

/**
 * NotificationsSection - the Settings ▸ Notifications surface: manage browser
 * web-push honestly (real permission state, subscribe/unsubscribe when the
 * platform genuinely allows it) plus a PWA "Install as app" affordance.
 */
export function NotificationsSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="notifications-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="notifications-heading">{t('settings.notifications.sectionTitle') || 'Notifications'}</span>
        }
        description={
          t('settings.notifications.sectionDescription') ||
          'Choose how OyeChats reaches you on this device.'
        }
      />
      <div className="space-y-4">
        <NotificationsCard />
        <InstallAsAppCard />
      </div>
    </section>
  );
}
