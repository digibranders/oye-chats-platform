import { useEffect, useState, type ReactElement } from 'react';
import { Download, Share, X } from 'lucide-react';
import { Button } from '../design-system';

/** Once dismissed, stay hidden for this long so we never nag. */
const DISMISS_KEY = 'oyechats:install_banner_dismissed_at';
const DISMISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

function wasDismissedRecently(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_WINDOW_MS;
  } catch {
    return false;
  }
}

export interface InstallAppBannerProps {
  /** Only rendered on mobile viewports - the shell owns the breakpoint state. */
  isMobile: boolean;
}

/**
 * InstallAppBanner - a floating "Install OyeChats" prompt pinned to the bottom
 * of the mobile viewport. Shown on EVERY page to EVERY signed-in user - no role
 * or route gate; the only conditions are "mobile viewport" and "an install path
 * actually exists".
 *
 * Honest by construction: a real Install button only appears where the browser
 * can genuinely install (a captured `beforeinstallprompt`, i.e. Android/Chromium).
 * iOS Safari has no programmatic install, so there the button reveals the manual
 * "Share -> Add to Home Screen" steps instead of a dead action. Already-installed
 * (standalone) sessions and browsers that never offer install show nothing.
 * Dismissal persists for 7 days. Mounted once in {@link AppShell}.
 */
export function InstallAppBanner({ isMobile }: InstallAppBannerProps): ReactElement | null {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(readInstalled);
  const [dismissed, setDismissed] = useState<boolean>(wasDismissedRecently);
  const [installing, setInstalling] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (event: Event): void => {
      // Stop Chrome's mini-infobar so this banner owns the install moment.
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

  const dismiss = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* localStorage unavailable - it reappears next mount, which is acceptable. */
    }
  };

  const handleInstall = async (): Promise<void> => {
    // iOS Safari has no programmatic install - reveal the manual steps instead
    // of firing a dead action.
    if (!deferredPrompt) {
      setShowIosHint(true);
      return;
    }
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // The prompt can only be used once - drop it either way.
      setDeferredPrompt(null);
      if (choice.outcome === 'accepted') setInstalled(true);
      // Told the browser "no" - treat as a dismissal so we don't nag again.
      else dismiss();
    } finally {
      setInstalling(false);
    }
  };

  const ios = isIOS();
  // Only surface where an install path genuinely exists: a captured prompt
  // (Android/Chromium) or iOS Safari's manual route.
  const canOffer = deferredPrompt !== null || ios;
  if (!isMobile || installed || dismissed || !canOffer) return null;

  // The bottom offset clears the bottom-right chat launcher (a shadow-DOM widget
  // mounted by app/App.tsx) so the Install/dismiss controls are never covered.
  return (
    <div
      role="region"
      aria-label="Install OyeChats"
      className="fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[55] rounded-[var(--ds-radius-xl)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)] md:hidden"
    >
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
          <Download size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[var(--ds-text)]">Install OyeChats</p>
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--ds-text-subtle)]">
            Add to your home screen for quick access.
          </p>
        </div>
        <Button size="sm" onClick={() => void handleInstall()} disabled={installing}>
          {installing ? 'Installing…' : 'Install'}
        </Button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="-mr-0.5 shrink-0 rounded-md p-1 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {showIosHint && ios && (
        <p className="flex items-center gap-1.5 border-t border-[var(--ds-border)] px-3 py-2 text-[12px] text-[var(--ds-text-muted)]">
          <Share size={13} aria-hidden="true" className="shrink-0" />
          <span>
            Tap the Share icon, then choose{' '}
            <strong className="font-medium text-[var(--ds-text)]">Add to Home Screen</strong>.
          </span>
        </p>
      )}
    </div>
  );
}
