import test from 'node:test';
import assert from 'node:assert/strict';

// Storage doubles that can be switched into "blocked" mode, the way Safari
// with cookies blocked (and Chrome with site data blocked) throws from the
// accessor itself rather than returning null.
const makeStorage = () => {
    const map = new Map();
    return {
        blocked: false,
        getItem(k) {
            if (this.blocked) throw new Error('The operation is insecure.');
            return map.has(k) ? map.get(k) : null;
        },
        setItem(k, v) {
            if (this.blocked) throw new Error('The operation is insecure.');
            map.set(k, String(v));
        },
        removeItem(k) {
            if (this.blocked) throw new Error('The operation is insecure.');
            map.delete(k);
        },
    };
};

const local = makeStorage();
const session = makeStorage();
globalThis.localStorage = local;
globalThis.sessionStorage = session;

const listeners = new Map();
globalThis.document = { referrer: 'https://ref.example/', visibilityState: 'visible' };
globalThis.window = {
    OYECHATS_BOT_KEY: 'bot-test',
    location: { href: 'https://shop.example/pricing', search: '?utm_source=ads', pathname: '/pricing' },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
};

const { collectPageContext, sendTimeOnPage, sendJourneyUpdate } = await import('./api.js');

const withFetch = async (run) => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    const originalBeacon = globalThis.navigator?.sendBeacon;
    let beacons = 0;
    globalThis.fetch = (url, options) => {
        calls.push({ url, options });
        return Promise.resolve({ ok: true });
    };
    if (globalThis.navigator) globalThis.navigator.sendBeacon = () => { beacons += 1; return true; };
    try {
        await run();
    } finally {
        globalThis.fetch = originalFetch;
        if (globalThis.navigator) globalThis.navigator.sendBeacon = originalBeacon;
    }
    return { calls, beacons: () => beacons };
};

// ── W5: storage-blocked browsers must not break the chat ────────────────────

test('collectPageContext survives storage that throws, with first-visit defaults', () => {
    local.blocked = true;
    session.blocked = true;
    try {
        const ctx = collectPageContext();
        assert.equal(ctx.is_return_visit, false);
        assert.equal(ctx.pages_viewed, 1);
        assert.deepEqual(ctx.journey, []);
        assert.equal(ctx.page_url, 'https://shop.example/pricing');
        assert.deepEqual(ctx.utm_params, { utm_source: 'ads' });
    } finally {
        local.blocked = false;
        session.blocked = false;
    }
});

test('collectPageContext still tracks the visitor when storage works', () => {
    const first = collectPageContext();
    assert.equal(first.is_return_visit, false);
    assert.equal(first.pages_viewed, 1);

    const second = collectPageContext();
    assert.equal(second.is_return_visit, true, 'the localStorage fingerprint must be read back');
    assert.equal(second.pages_viewed, 2);
});

test('sendTimeOnPage does not throw when storage is blocked', async () => {
    session.blocked = true;
    const { calls } = await withFetch(async () => {
        sendTimeOnPage('sess-1', performance.now() - 5000);
    });
    session.blocked = false;
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).pages_viewed, 1);
});

// ── W14: unload flushes must authenticate ───────────────────────────────────

test('sendTimeOnPage posts with the bot key and keepalive, never a beacon', async () => {
    const { calls, beacons } = await withFetch(async () => {
        sendTimeOnPage('sess-1', performance.now() - 5000);
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/chat\/behavioral-signals$/);
    assert.equal(calls[0].options.headers['X-Bot-Key'], 'bot-test');
    assert.equal(calls[0].options.keepalive, true);
    assert.equal(beacons(), 0, 'sendBeacon cannot carry X-Bot-Key, so it is always a 401');
});

test('the pagehide journey flush posts with the bot key, not sendBeacon', async () => {
    collectPageContext(); // seed a journey entry so the flush has something to send
    const { calls, beacons } = await withFetch(async () => {
        sendJourneyUpdate('sess-1');
        const pagehide = listeners.get('pagehide');
        assert.equal(typeof pagehide, 'function', 'the pagehide hook must be installed');
        pagehide();
    });

    assert.ok(calls.length >= 1);
    const last = calls[calls.length - 1];
    assert.equal(last.options.headers['X-Bot-Key'], 'bot-test');
    assert.equal(last.options.keepalive, true);
    assert.equal(beacons(), 0);
});
