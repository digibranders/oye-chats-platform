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
