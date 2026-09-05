import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_HOST, CONSENT_COOKIE, GTM_CONTAINER_ID, GTM_ORIGIN } from './consent';
import { consentBootstrapScript } from './consentBootstrap';

type ConsentDefault = ['consent', 'default', Record<string, string | number>];

interface AnalyticsWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
}

/**
 * Runs the generated head script against jsdom the way a browser would: as a
 * classic script with `window` and `document` in scope.
 */
function runBootstrap(hostname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname },
  });
  new Function('window', 'document', consentBootstrapScript())(window, document);
}

function consentDefault(): Record<string, string | number> {
  const layer = (window as AnalyticsWindow).dataLayer ?? [];
  const entry = layer.find(
    (item): item is IArguments => typeof item === 'object' && item !== null && 'length' in item,
  );
  if (!entry) throw new Error('no consent default was pushed');
  const [command, action, params] = Array.from(entry) as ConsentDefault;
  expect(command).toBe('consent');
  expect(action).toBe('default');
  return params;
}

function injectedContainer(): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(`script[src^="${GTM_ORIGIN}/gtm.js"]`);
}

const originalLocation = window.location;
const originalNavigator = window.navigator;

describe('consentBootstrapScript', () => {
  beforeEach(() => {
    delete (window as AnalyticsWindow).dataLayer;
    delete (window as AnalyticsWindow).gtag;
    document.cookie = `${CONSENT_COOKIE}=; Max-Age=0; Path=/`;
    document.head.innerHTML = '';
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    Object.defineProperty(window, 'navigator', { configurable: true, value: originalNavigator });
    vi.restoreAllMocks();
  });

  it('is plain ES5 that runs before the bundle and never throws', () => {
    const script = consentBootstrapScript();
    expect(script).not.toMatch(/\b(const|let|=>|class)\b/);
    expect(() => runBootstrap('localhost')).not.toThrow();
    expect(typeof (window as AnalyticsWindow).gtag).toBe('function');
  });

  it('denies analytics by default in a restricted zone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Europe/Berlin',
    } as Intl.ResolvedDateTimeFormatOptions);
    runBootstrap('localhost');
    expect(consentDefault()).toMatchObject({ analytics_storage: 'denied', ad_storage: 'denied' });
  });

  it('grants analytics by default outside the restricted zones', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Asia/Kolkata',
    } as Intl.ResolvedDateTimeFormatOptions);
    runBootstrap('localhost');
    expect(consentDefault()).toMatchObject({
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
  });

  it('lets a stored consent cookie override the zone default', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Asia/Kolkata',
    } as Intl.ResolvedDateTimeFormatOptions);
    document.cookie = `${CONSENT_COOKIE}=denied; Path=/`;
    runBootstrap('localhost');
    expect(consentDefault().analytics_storage).toBe('denied');
  });

  it('honours Global Privacy Control when no cookie is stored', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Asia/Kolkata',
    } as Intl.ResolvedDateTimeFormatOptions);
    Object.defineProperty(window, 'navigator', {
      configurable: true,
      value: { ...originalNavigator, globalPrivacyControl: true },
    });
    runBootstrap('localhost');
    expect(consentDefault().analytics_storage).toBe('denied');
  });

  it('never loads the container off the production host', () => {
    runBootstrap('localhost');
    window.dispatchEvent(new Event('pointermove'));
    expect(injectedContainer()).toBeNull();
  });

  it('loads the container once, on the first interaction, on the production host', () => {
    runBootstrap(ANALYTICS_HOST);
    expect(injectedContainer()).toBeNull();

    window.dispatchEvent(new Event('scroll'));
    const container = injectedContainer();
    expect(container).not.toBeNull();
    expect(container?.src).toBe(`${GTM_ORIGIN}/gtm.js?id=${GTM_CONTAINER_ID}`);
    expect(container?.async).toBe(true);

    const layer = (window as AnalyticsWindow).dataLayer ?? [];
    expect(layer.some((item) => (item as { event?: string }).event === 'gtm.js')).toBe(true);

    window.dispatchEvent(new Event('keydown'));
    expect(document.querySelectorAll(`script[src^="${GTM_ORIGIN}/gtm.js"]`)).toHaveLength(1);
  });

  it('pushes the consent default before the container can load', () => {
    runBootstrap(ANALYTICS_HOST);
    window.dispatchEvent(new Event('touchstart'));
    const layer = (window as AnalyticsWindow).dataLayer ?? [];
    const consentIndex = layer.findIndex((item) => Array.from(item as IArguments)[0] === 'consent');
    const startIndex = layer.findIndex((item) => (item as { event?: string }).event === 'gtm.js');
    expect(consentIndex).toBeGreaterThanOrEqual(0);
    expect(consentIndex).toBeLessThan(startIndex);
  });
});
