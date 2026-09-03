import { describe, expect, it } from 'vitest';
import {
  installStampCaption,
  apiOrigin,
  demoPreviewState,
  domainNotice,
  embedSnippet,
  entriesForWebsite,
  installStatus,
  isOriginAllowed,
  normalizeDomain,
  originHost,
  ownSiteRisk,
  scriptOrigin,
  troubleshootItems,
  widgetHeartbeat,
} from './deployModel';
import { formatDateTime } from '../../../ui';
import { attributionAnchorHtml } from '../../../data/widgetEmbed';
import { developerEmail } from './developerEmail';

const BOT_KEY = 'bot-11a026a4b8b3';

/**
 * What is tested here is what breaks quietly and expensively.
 *
 * The install state machine, because "waiting" rendered as an error teaches
 * customers to ignore the one colour that matters. The two snippet variants,
 * because one of them is a contractual obligation and the other is a paid
 * feature. And the domain helpers, because they are a client-side mirror of
 * `api/app/core/origin_check.py` and the moment they drift from it this console
 * starts telling customers their widget is safe while the backend turns it away.
 */

describe('installStatus', () => {
  it('is neutral, not an error, before anyone has installed anything', () => {
    const status = installStatus({ installedAt: null, claimed: false, checking: false });
    expect(status.state).toBe('waiting');
    expect(status.tone).toBe('neutral');
    expect(status.label).toBe('Waiting to be installed');
  });

  it('only becomes a problem once the customer says it is installed', () => {
    const status = installStatus({ installedAt: null, claimed: true, checking: false });
    expect(status.state).toBe('not-detected');
    expect(status.tone).toBe('warning');
  });

  it('reports the search while it is running, above the claim', () => {
    const status = installStatus({ installedAt: null, claimed: true, checking: true });
    expect(status.state).toBe('checking');
    expect(status.tone).toBe('neutral');
  });

  it('stays live while the heartbeat is recent', () => {
    const now = Date.parse('2026-08-20T09:00:00Z');
    const status = installStatus({
      installedAt: '2026-01-01T09:00:00Z',
      lastSeenAt: '2026-08-19T09:00:00Z',
      claimed: false,
      checking: false,
      now,
    });
    expect(status.state).toBe('installed');
    expect(status.tone).toBe('success');
  });

  it('stops calling a chatbot live once its heartbeat is a week old', () => {
    // `widget_installed_at` is a first-seen stamp that nothing refreshes, so
    // reading it alone put a green "we have seen this load on a real page of
    // your site" above a "Last seen: 7 months ago".
    const now = Date.parse('2026-08-20T09:00:00Z');
    const status = installStatus({
      installedAt: '2026-01-01T09:00:00Z',
      lastSeenAt: '2026-01-14T09:00:00Z',
      claimed: false,
      checking: false,
      now,
    });
    expect(status.state).toBe('stale');
    expect(status.tone).toBe('warning');
    expect(status.label).toBe('Not seen recently');
    // The date it went quiet is the fact the customer needs, so it travels
    // with the state rather than only living in a property row.
    expect(status.detail).toContain(formatDateTime('2026-01-14T09:00:00Z'));
  });

  it('keeps a chatbot with no heartbeat at all live, never stale', () => {
    // There is no backfill: a chatbot installed before the heartbeat shipped
    // reads `null` until its widget next boots. Reporting that as an outage
    // would send a customer to debug a working site.
    const status = installStatus({
      installedAt: '2026-01-01T09:00:00Z',
      lastSeenAt: null,
      claimed: false,
      checking: false,
      now: Date.parse('2026-08-20T09:00:00Z'),
    });
    expect(status.state).toBe('installed');
  });

  it('lets the server stamp win over any local claim', () => {
    const status = installStatus({
      installedAt: '2026-08-01T09:00:00Z',
      claimed: true,
      checking: true,
    });
    expect(status.state).toBe('installed');
    expect(status.tone).toBe('success');
  });

  it('carries a word in every state, so colour is never the only signal', () => {
    const states = [
      installStatus({ installedAt: null, claimed: false, checking: false }),
      installStatus({ installedAt: null, claimed: true, checking: false }),
      installStatus({ installedAt: null, claimed: true, checking: true }),
      installStatus({ installedAt: '2026-08-01T09:00:00Z', claimed: false, checking: false }),
    ];
    for (const status of states) {
      expect(status.label.length).toBeGreaterThan(0);
      expect(status.detail.length).toBeGreaterThan(0);
    }
    expect(new Set(states.map((s) => s.label)).size).toBe(4);
  });

  it('captions the stamp as a start date, because nothing refreshes that column', () => {
    expect(installStampCaption()).toBe('First seen');
  });
});

describe('widgetHeartbeat', () => {
  it('does not read an absent heartbeat as an outage', () => {
    const beat = widgetHeartbeat({
      installedAt: '2026-01-04T09:00:00Z',
      lastSeenAt: null,
      lastOrigin: null,
    });
    expect(beat.seenAt).toBeNull();
    // The one sentence that matters: there is no backfill, so every install
    // that predates the heartbeat reads empty and must not be alarmed about.
    expect(beat.detail).toMatch(/does not mean the chatbot is down/i);
    expect(beat.detail).not.toMatch(/offline|outage|broken/i);
  });

  it('says something different when the widget has never been seen at all', () => {
    const beat = widgetHeartbeat({ installedAt: null, lastSeenAt: null, lastOrigin: null });
    expect(beat.detail).toBe('Nothing has loaded your chatbot yet.');
  });

  it('states the sampling rate, so a quiet reading is not read as low traffic', () => {
    const beat = widgetHeartbeat({
      installedAt: '2026-01-04T09:00:00Z',
      lastSeenAt: '2026-08-19T11:00:00Z',
      lastOrigin: 'www.acme.com',
    });
    expect(beat.seenAt).toBe('2026-08-19T11:00:00Z');
    expect(beat.detail).toMatch(/twice an hour/i);
    expect(beat.detail).toMatch(/not how busy/i);
  });

  it('passes the origin through as data and normalises nothing else about it', () => {
    expect(
      widgetHeartbeat({ installedAt: null, lastSeenAt: null, lastOrigin: '  shop.acme.com  ' })
        .origin,
    ).toBe('shop.acme.com');
    expect(
      widgetHeartbeat({ installedAt: null, lastSeenAt: null, lastOrigin: '   ' }).origin,
    ).toBeNull();
    expect(
      widgetHeartbeat({ installedAt: null, lastSeenAt: null, lastOrigin: undefined }).origin,
    ).toBeNull();
  });

  it('never turns the origin into a verdict — it carries no tone, state or flag', () => {
    const beat = widgetHeartbeat({
      installedAt: '2026-01-04T09:00:00Z',
      lastSeenAt: '2026-08-19T11:00:00Z',
      lastOrigin: 'attacker.example',
    });
    // A forged Origin header must not be able to change anything a caller can
    // branch on. The shape is deliberately three inert fields.
    expect(Object.keys(beat).sort()).toEqual(['detail', 'origin', 'seenAt']);
  });
});

describe('embedSnippet', () => {
  it('carries the script tag and the crawlable anchor by default', () => {
    const snippet = embedSnippet({ botKey: BOT_KEY, env: 'production', attribution: true });
    expect(snippet).toContain(`data-bot-key="${BOT_KEY}"`);
    expect(snippet).toContain('https://cdn.oyechats.com/oyechats-widget.js');
    expect(snippet).toContain(attributionAnchorHtml(BOT_KEY));
    expect(snippet).toContain('rel="nofollow"');
    expect(snippet.split('\n')).toHaveLength(2);
  });

  it('drops the anchor entirely for a plan that may remove branding', () => {
    const snippet = embedSnippet({ botKey: BOT_KEY, env: 'production', attribution: false });
    expect(snippet).not.toContain('nofollow');
    expect(snippet).not.toContain('oyechats.com/?');
    expect(snippet.split('\n')).toHaveLength(1);
  });

  it('points at the local preview bundle when the console talks to a local API', () => {
    expect(embedSnippet({ botKey: BOT_KEY, env: 'development', attribution: false })).toContain(
      'localhost:4173',
    );
  });
});

describe('normalizeDomain', () => {
  it('strips everything the backend strips', () => {
    expect(normalizeDomain('  HTTPS://WWW.Acme.com:8443/pricing?x=1 ')).toBe('acme.com');
    expect(normalizeDomain('acme.com/')).toBe('acme.com');
  });

  it('keeps a deliberate wildcard', () => {
    expect(normalizeDomain('*.acme.com')).toBe('*.acme.com');
    expect(normalizeDomain('*.www.acme.com')).toBe('*.acme.com');
  });

  it('allows the local hosts the backend allows, but never as a wildcard', () => {
    expect(normalizeDomain('localhost')).toBe('localhost');
    expect(normalizeDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeDomain('*.localhost')).toBeNull();
  });

  it('rejects anything that could not be a hostname', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('acme')).toBeNull();
    expect(normalizeDomain('https://')).toBeNull();
  });
});

describe('originHost', () => {
  it('keeps www, because the browser does', () => {
    expect(originHost('https://www.acme.com/pricing')).toBe('www.acme.com');
    expect(originHost('acme.com')).toBe('acme.com');
    expect(originHost('https://Shop.Acme.com:443')).toBe('shop.acme.com');
  });

  it('returns null rather than guessing', () => {
    expect(originHost(null)).toBeNull();
    expect(originHost('')).toBeNull();
    expect(originHost('   ')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('matches an exact hostname', () => {
    expect(isOriginAllowed('acme.com', ['acme.com'])).toBe(true);
    expect(isOriginAllowed('other.com', ['acme.com'])).toBe(false);
  });

  it('matches a wildcard against a subdomain but never against the apex', () => {
    expect(isOriginAllowed('shop.acme.com', ['*.acme.com'])).toBe(true);
    expect(isOriginAllowed('a.b.acme.com', ['*.acme.com'])).toBe(true);
    expect(isOriginAllowed('acme.com', ['*.acme.com'])).toBe(false);
  });

  it('does not admit www for an apex-only entry — the trap this page exists to catch', () => {
    expect(isOriginAllowed('www.acme.com', ['acme.com'])).toBe(false);
    expect(isOriginAllowed('www.acme.com', ['acme.com', '*.acme.com'])).toBe(true);
  });

  it('never matches a missing origin', () => {
    expect(isOriginAllowed(null, ['acme.com'])).toBe(false);
    expect(isOriginAllowed('', ['acme.com'])).toBe(false);
  });

  it('is not fooled by a suffix that merely ends the same way', () => {
    expect(isOriginAllowed('notacme.com', ['*.acme.com'])).toBe(false);
    expect(isOriginAllowed('evil-acme.com', ['acme.com'])).toBe(false);
  });
});

describe('entriesForWebsite', () => {
  it('always offers both the apex and the wildcard, because www is a subdomain', () => {
    // `localhost` rides along so a customer can try the widget on a dev
    // server; turning the allow-list on is otherwise what silently breaks
    // local testing.
    expect(entriesForWebsite('https://www.acme.com')).toEqual([
      'acme.com',
      '*.acme.com',
      'localhost',
    ]);
  });

  it('offers a single entry for a local host, where a wildcard is meaningless', () => {
    expect(entriesForWebsite('http://localhost:5173')).toEqual(['localhost']);
  });

  it('offers nothing when there is no website to derive from', () => {
    expect(entriesForWebsite(null)).toEqual([]);
    expect(entriesForWebsite('nonsense')).toEqual([]);
  });
});

describe('ownSiteRisk', () => {
  it('is null while enforcement is off, however wrong the list is', () => {
    expect(ownSiteRisk({ website: 'https://acme.com', domains: ['other.com'], enabled: false })).toBeNull();
  });

  it('is null for an empty list, because the backend fails open on one', () => {
    expect(ownSiteRisk({ website: 'https://acme.com', domains: [], enabled: true })).toBeNull();
  });

  it('catches the www case and names the entry that fixes it', () => {
    const risk = ownSiteRisk({
      website: 'https://www.acme.com',
      domains: ['acme.com'],
      enabled: true,
    });
    expect(risk).not.toBeNull();
    expect(risk!.host).toBe('www.acme.com');
    expect(risk!.suggestions).toEqual(['acme.com', '*.acme.com']);
  });

  it('is null once the wildcard is present', () => {
    expect(
      ownSiteRisk({ website: 'https://www.acme.com', domains: ['acme.com', '*.acme.com'], enabled: true }),
    ).toBeNull();
  });

  it('catches a list that simply does not mention the customer at all', () => {
    const risk = ownSiteRisk({ website: 'https://acme.com', domains: ['example.org'], enabled: true });
    expect(risk!.host).toBe('acme.com');
    expect(risk!.suggestions).toEqual(['acme.com']);
  });
});

describe('domainNotice', () => {
  it('warns that anyone can embed while the check is off', () => {
    const notice = domainNotice({ website: 'https://acme.com', domains: [], enabled: false });
    expect(notice.id).toBe('off');
    expect(notice.tone).toBe('warning');
  });

  it('says an enabled-but-empty list is enforcing nothing, rather than implying safety', () => {
    const notice = domainNotice({ website: 'https://acme.com', domains: [], enabled: true });
    expect(notice.id).toBe('empty');
    expect(notice.tone).toBe('warning');
  });

  it('escalates to danger when the customer is about to lock themselves out', () => {
    const notice = domainNotice({
      website: 'https://www.acme.com',
      domains: ['acme.com'],
      enabled: true,
    });
    expect(notice.id).toBe('locked-out');
    expect(notice.tone).toBe('danger');
    expect(notice.body).toContain('*.acme.com');
  });

  it('is quiet and neutral once the configuration is right', () => {
    const notice = domainNotice({
      website: 'https://www.acme.com',
      domains: ['acme.com', '*.acme.com'],
      enabled: true,
    });
    expect(notice.id).toBe('ok');
    expect(notice.tone).toBe('neutral');
    expect(notice.title).toContain('2');
  });
});

describe('scriptOrigin / apiOrigin', () => {
  it('reduces both to the origin a CSP directive takes', () => {
    expect(scriptOrigin('production')).toBe('https://cdn.oyechats.com');
    expect(apiOrigin('https://api.oyechats.com/')).toBe('https://api.oyechats.com');
  });

  it('degrades to the raw value rather than throwing on junk', () => {
    expect(apiOrigin('not-a-url/')).toBe('not-a-url');
  });
});

describe('troubleshootItems', () => {
  const base = {
    botKey: BOT_KEY,
    env: 'production' as const,
    apiBaseUrl: 'https://api.oyechats.com',
    website: 'https://www.acme.com',
    domains: [] as string[],
    domainsConfigured: 0,
    domainCheckEnabled: false,
  };

  it('leads with the allow-list when the allow-list is the cause', () => {
    const items = troubleshootItems({
      ...base,
      domains: ['acme.com'],
      domainsConfigured: 1,
      domainCheckEnabled: true,
    });
    expect(items[0].id).toBe('allow-list');
    expect(items[0].title).toContain('www.acme.com');
  });

  it('still warns about subdomain mismatches when the list happens to be correct', () => {
    const items = troubleshootItems({
      ...base,
      domains: ['acme.com', '*.acme.com'],
      domainsConfigured: 2,
      domainCheckEnabled: true,
    });
    expect(items[0].id).toBe('allow-list-subdomain');
  });

  it('says nothing about the allow-list when it is not switched on', () => {
    const items = troubleshootItems(base);
    expect(items.map((item) => item.id)).not.toContain('allow-list');
    expect(items.map((item) => item.id)).not.toContain('allow-list-subdomain');
  });

  it('always covers the failure modes a customer cannot guess', () => {
    const ids = troubleshootItems(base).map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining(['external', 'body', 'bot-key', 'csp', 'cache', 'blockers']),
    );
  });

  it('quotes the real key and the real CSP origins, not a placeholder', () => {
    const items = troubleshootItems(base);
    expect(items.find((item) => item.id === 'bot-key')?.code).toBe(BOT_KEY);
    const csp = items.find((item) => item.id === 'csp')?.code ?? '';
    expect(csp).toContain('script-src https://cdn.oyechats.com');
    expect(csp).toContain('connect-src https://api.oyechats.com');
  });
});

describe('developerEmail', () => {
  const base = {
    botName: 'Acme Support',
    env: 'production' as const,
    apiBaseUrl: 'https://api.oyechats.com',
  };

  it('carries the exact snippet, the placement and both CSP origins', () => {
    const snippet = embedSnippet({ botKey: BOT_KEY, env: 'production', attribution: true });
    const mail = developerEmail({ ...base, snippet, platformName: 'WordPress', attribution: true });
    expect(mail.subject).toContain('Acme Support');
    expect(mail.body).toContain(snippet);
    expect(mail.body).toContain('</body>');
    expect(mail.body).toContain('script-src https://cdn.oyechats.com');
    expect(mail.body).toContain('connect-src https://api.oyechats.com');
    expect(mail.body).toContain('WordPress');
    expect(mail.href.startsWith('mailto:?subject=')).toBe(true);
    expect(decodeURIComponent(mail.href)).toContain(snippet);
  });

  it('does not ask a developer to preserve a credit link the plan does not include', () => {
    const snippet = embedSnippet({ botKey: BOT_KEY, env: 'production', attribution: false });
    const mail = developerEmail({ ...base, snippet, attribution: false });
    expect(mail.body).not.toContain('Powered by OyeChats');
    expect(mail.body).not.toContain('do not hide it with CSS');
  });
});

describe('demoPreviewState', () => {
  const NOW = new Date('2026-08-27T12:00:00Z');
  const fresh = '2026-08-20T12:00:00Z';
  const ancient = '2025-01-01T12:00:00Z';

  it('reports a usable capture as ready', () => {
    expect(
      demoPreviewState({ website: 'https://acme.com', status: 'ready', capturedAt: fresh, now: NOW }),
    ).toEqual({ kind: 'ready' });
  });

  it('calls a capture older than the TTL stale, not ready', () => {
    // The link still works; it just shows a design the customer may have
    // replaced, which is the thing they need told before they share it.
    expect(
      demoPreviewState({ website: 'https://acme.com', status: 'ready', capturedAt: ancient, now: NOW }),
    ).toEqual({ kind: 'stale', capturedAt: ancient });
  });

  it('distinguishes a chatbot with no website from a failed capture', () => {
    expect(demoPreviewState({ website: '', status: 'ready', capturedAt: fresh, now: NOW })).toEqual({
      kind: 'no-website',
    });
    expect(
      demoPreviewState({ website: 'https://acme.com', status: 'failed', capturedAt: null, now: NOW }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('reports a queued capture as pending', () => {
    expect(
      demoPreviewState({ website: 'https://acme.com', status: 'pending', capturedAt: null, now: NOW }),
    ).toEqual({ kind: 'pending' });
  });

  it('treats a never-attempted capture as unavailable', () => {
    expect(
      demoPreviewState({ website: 'https://acme.com', status: null, capturedAt: null, now: NOW }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('does not claim freshness it cannot verify', () => {
    // An unparseable timestamp is not evidence the capture is current, but it
    // is also not evidence it is stale. Ready, without a staleness claim.
    expect(
      demoPreviewState({ website: 'https://acme.com', status: 'ready', capturedAt: 'not a date', now: NOW }),
    ).toEqual({ kind: 'ready' });
  });

  it('needs a timestamp before it will call a capture ready', () => {
    expect(
      demoPreviewState({ website: 'https://acme.com', status: 'ready', capturedAt: null, now: NOW }),
    ).toEqual({ kind: 'unavailable' });
  });
});
