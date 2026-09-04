import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/api', () => ({
  getVapidPublicKey: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));

import { getVapidPublicKey, subscribePush } from '../services/api';

// A valid uncompressed P-256 point, base64url: 65 bytes, 0x04 prefix. What
// production serves; the failure under test is not about the key.
const PUBLIC_KEY =
  'BN2uw3V9Zm5FBb3r46Nxaj9xp8_24IV8b_3wvwH6Qze04tzWsqC3EZcr2GsUSUMTYsELT2WgAXLnQNMxOmhPRQ0';

/** What Chrome throws when it cannot register with its own push service. */
function chromeRegistrationFailure(): DOMException {
  return new DOMException('Registration failed - could not retrieve the public key', 'AbortError');
}

interface FakeBrowser {
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly getSubscription: ReturnType<typeof vi.fn>;
}

function installBrowser({ permission }: { permission: NotificationPermission }): FakeBrowser {
  const subscribe = vi.fn();
  const getSubscription = vi.fn().mockResolvedValue(null);
  const registration = { pushManager: { subscribe, getSubscription } };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { permission, requestPermission: vi.fn().mockResolvedValue(permission) },
  });
  return { subscribe, getSubscription };
}

describe('usePushSubscription, when the browser cannot register with its push service', () => {
  beforeEach(() => {
    vi.mocked(getVapidPublicKey).mockResolvedValue({ public_key: PUBLIC_KEY, enabled: true });
    vi.mocked(subscribePush).mockResolvedValue(undefined as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the honest copy, not the browser message, on the automatic subscribe at mount', async () => {
    // Permission already granted and no subscription on the device: the hook
    // mints one by itself. This is the account page's first render, and the
    // path that rendered Chrome's raw text into the banner in production.
    const browser = installBrowser({ permission: 'granted' });
    browser.subscribe.mockRejectedValue(chromeRegistrationFailure());

    const { usePushSubscription } = await import('./usePushSubscription');
    const { result } = renderHook(() => usePushSubscription());

    await waitFor(() => expect(result.current.phase.status).toBe('error'));
    const phase = result.current.phase;
    if (phase.status !== 'error') throw new Error('unreachable');
    expect(phase.message).not.toContain('could not retrieve the public key');
    expect(phase.message).toMatch(/could not reach its notification service/);
    // The original survives where someone can act on it.
    expect(console.warn).toHaveBeenCalledWith('[OyeChats] push subscribe failed', expect.any(DOMException));
  });

  it('shows the same copy from the Enable button', async () => {
    const browser = installBrowser({ permission: 'granted' });
    browser.subscribe.mockRejectedValue(chromeRegistrationFailure());

    const { usePushSubscription } = await import('./usePushSubscription');
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.phase.status).toBe('error'));
    const fromMount = result.current.phase.status === 'error' ? result.current.phase.message : '';

    await act(async () => {
      await result.current.enable();
    });
    expect(result.current.actionError).toBe(fromMount);
  });

  it('still reports a failed status check in its own words', async () => {
    // A failure before the mint (the service worker itself) is a different
    // thing and keeps the generic status-check message.
    installBrowser({ permission: 'granted' });
    (navigator.serviceWorker.register as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('The script has an unsupported MIME type'),
    );
    const { usePushSubscription } = await import('./usePushSubscription');
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.phase.status).toBe('error'));
    const phase = result.current.phase;
    if (phase.status !== 'error') throw new Error('unreachable');
    expect(phase.message).toBe('The script has an unsupported MIME type');
  });
});

describe('usePushSubscription, why push is unsupported', () => {
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1';
  const DESKTOP_UA_NO_PUSH =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.0.0 Safari/537.36';

  /**
   * `PUSH_SUPPORTED` and the reason it computes when false are both read once,
   * at module load, from `navigator`/`window` — so getting a fresh read under
   * a different fake environment means a fresh module instance. The other
   * describe block in this file never needs this: every test there runs with
   * `PushManager` present, which the very first import already captured.
   */
  async function loadHookWithout(
    capability: 'PushManager',
    env: { userAgent: string; standalone?: boolean; displayModeStandalone?: boolean },
  ) {
    vi.resetModules();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: env.userAgent });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: env.standalone ?? false });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn().mockResolvedValue({ pushManager: {} }), ready: Promise.resolve({ pushManager: {} }) },
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission: vi.fn() },
    });
    // The capability under test is absent - the whole point of this block.
    // ('PushManager' is the only one this hook currently branches its reason
    // on; the parameter exists so a future capability gap says which one.)
    void capability;
    delete (window as { PushManager?: unknown }).PushManager;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)' && !!env.displayModeStandalone,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const { usePushSubscription } = await import('./usePushSubscription');
    return renderHook(() => usePushSubscription());
  }

  it('tells an iOS visitor in a plain tab to add it to the Home Screen', async () => {
    const { result } = await loadHookWithout('PushManager', { userAgent: IPHONE_UA });
    expect(result.current.phase).toEqual({ status: 'unsupported', reason: 'ios-not-installed' });
  });

  it('tells an already-installed iOS visitor their iOS is too old, not to reinstall', async () => {
    const { result } = await loadHookWithout('PushManager', {
      userAgent: IPHONE_UA,
      displayModeStandalone: true,
    });
    expect(result.current.phase).toEqual({ status: 'unsupported', reason: 'ios-too-old' });
  });

  it('falls back to the same iOS reason via navigator.standalone, the pre-standard Safari signal', async () => {
    const { result } = await loadHookWithout('PushManager', {
      userAgent: IPHONE_UA,
      standalone: true,
    });
    expect(result.current.phase).toEqual({ status: 'unsupported', reason: 'ios-too-old' });
  });

  it('gives a non-iOS unsupported browser the generic reason, not the iOS one', async () => {
    const { result } = await loadHookWithout('PushManager', { userAgent: DESKTOP_UA_NO_PUSH });
    expect(result.current.phase).toEqual({ status: 'unsupported', reason: 'no-push-api' });
  });
});
