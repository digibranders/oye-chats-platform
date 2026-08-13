/**
 * Tests for cross-subdomain session persistence (storage-keys.js).
 *
 * Run with: `node --test src/services/storage-keys.test.js`
 *
 * A real cross-subdomain hop needs two origins under one registrable domain,
 * which a unit test can't spin up. Instead we model the two things the browser
 * actually guarantees and let the REAL module run against them:
 *   1. `localStorage` is partitioned per origin (a fresh store per "page").
 *   2. A cookie with `Domain=.example.com` is readable on the apex AND every
 *      subdomain; a host-only cookie is readable only on the host that set it.
 * The `CookieJar` below implements that domain-matching faithfully, so the
 * assertions exercise our logic (localStorage-first read, cookie mirror on
 * write, clear-expires-both) — not a mock of our own behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    readSessionId,
    writeSessionId,
    clearSessionId,
    getSessionKey,
    detectApexDomain,
    resolveShareDomain,
} from './storage-keys.js';

const BOT = 'bot-test';
const COOKIE_NAME = `oyechats_sid_${BOT}`;

// ── Minimal, domain-aware cookie jar shared across simulated pages ───────────
class CookieJar {
    constructor() {
        this.cookies = []; // { name, value, domain|null, host }
    }

    /** Normalize a Domain attribute to a leading-dot form for matching. */
    static _dot(domain) {
        return domain.startsWith('.') ? domain : `.${domain}`;
    }

    /** Does a cookie apply to a request from `host`? */
    static _matches(cookie, host) {
        if (!cookie.domain) return cookie.host === host; // host-only
        const d = CookieJar._dot(cookie.domain);
        return host === d.slice(1) || host.endsWith(d);
    }

    /** Emulate `document.cookie` read for a given host. */
    read(host) {
        return this.cookies
            .filter((c) => CookieJar._matches(c, host))
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
    }

    /** Emulate `document.cookie = ...` write from a given host. */
    write(host, raw) {
        const parts = raw.split(';').map((p) => p.trim());
        const [name, value = ''] = parts[0].split('=');
        let domain = null;
        let maxAge = null;
        for (const p of parts.slice(1)) {
            const [k, v = ''] = p.split('=');
            if (k.toLowerCase() === 'domain') domain = v.toLowerCase();
            if (k.toLowerCase() === 'max-age') maxAge = Number(v);
        }
        // Drop any existing cookie with the same identity first.
        this.cookies = this.cookies.filter(
            (c) => !(c.name === name && (c.domain || null) === domain && (domain ? true : c.host === host)),
        );
        if (maxAge === 0) return; // expiry — leave it removed
        this.cookies.push({ name, value: decodeURIComponent(value), domain, host });
    }
}

/** Point the global browser shims at a specific "page" (host + its localStorage). */
function visitPage(host, jar, store = new Map()) {
    globalThis.window = { OYECHATS_BOT_KEY: BOT };
    globalThis.location = { protocol: 'https:', hostname: host };
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        get() {
            return {
                get cookie() {
                    return jar.read(host);
                },
                set cookie(raw) {
                    jar.write(host, raw);
                },
            };
        },
    });
    return store;
}

// ── Same-origin behaviour is unchanged (localStorage is authoritative) ───────

test('writeSessionId persists to localStorage', () => {
    const store = visitPage('example.com', new CookieJar());
    writeSessionId('session_1', { botKey: BOT });
    assert.equal(store.get(getSessionKey(BOT)), 'session_1');
});

test('no shareDomain → no cookie is written (existing embeds untouched)', () => {
    const jar = new CookieJar();
    visitPage('example.com', jar);
    writeSessionId('session_1', { botKey: BOT });
    assert.equal(jar.read('example.com').includes(COOKIE_NAME), false);
});

test('readSessionId prefers localStorage over the cookie', () => {
    const jar = new CookieJar();
    const store = visitPage('example.com', jar);
    store.set(getSessionKey(BOT), 'local_wins');
    jar.write('example.com', `${COOKIE_NAME}=cookie_loses; Domain=.example.com`);
    assert.equal(readSessionId(BOT), 'local_wins');
});

// ── The headline scenario: apex → subdomain continuity ───────────────────────

test('shared session carries from apex to subdomain', () => {
    const jar = new CookieJar();

    // Page 1: visitor chats on the apex with sharing enabled.
    visitPage('example.com', jar);
    writeSessionId('session_shared', { botKey: BOT, shareDomain: 'example.com' });

    // Page 2: they navigate to a subdomain — a DIFFERENT origin, so its
    // localStorage is empty. The domain-scoped cookie is all it has to go on.
    visitPage('academy.example.com', jar, new Map());
    assert.equal(readSessionId(BOT), 'session_shared');
});

test('WITHOUT sharing, the subdomain does NOT see the apex session', () => {
    const jar = new CookieJar();

    visitPage('example.com', jar);
    writeSessionId('session_local', { botKey: BOT }); // no shareDomain

    visitPage('academy.example.com', jar, new Map());
    assert.equal(readSessionId(BOT), null);
});

test('an unrelated domain never sees the shared cookie', () => {
    const jar = new CookieJar();

    visitPage('example.com', jar);
    writeSessionId('session_shared', { botKey: BOT, shareDomain: 'example.com' });

    visitPage('acme.org', jar, new Map());
    assert.equal(readSessionId(BOT), null);
});

// ── clearSessionId wipes both stores, across origins ─────────────────────────

test('clearSessionId removes localStorage and expires the shared cookie', () => {
    const jar = new CookieJar();

    const store = visitPage('example.com', jar);
    writeSessionId('session_shared', { botKey: BOT, shareDomain: 'example.com' });
    assert.equal(store.get(getSessionKey(BOT)), 'session_shared');

    clearSessionId({ botKey: BOT, shareDomain: 'example.com' });
    assert.equal(store.has(getSessionKey(BOT)), false);

    // The subdomain, which relied purely on the cookie, now finds nothing.
    visitPage('academy.example.com', jar, new Map());
    assert.equal(readSessionId(BOT), null);
});

// ── Local testing: two localhost origins (different ports) share a host-only
// cookie, because cookies ignore port. This is the standard local embed-test
// setup, modelled here as the same host with a fresh (per-origin) localStorage.

test('localhost sharing bridges two origins via a host-only cookie', () => {
    const jar = new CookieJar();

    // Page on localhost:PORT_A — "main" test page.
    visitPage('localhost', jar);
    writeSessionId('session_local', { botKey: BOT, shareDomain: 'localhost' });
    // A host-only cookie must actually be written (no Domain attribute).
    assert.equal(jar.read('localhost').includes(`${COOKIE_NAME}=session_local`), true);

    // Page on localhost:PORT_B — different origin (fresh localStorage), same host.
    visitPage('localhost', jar, new Map());
    assert.equal(readSessionId(BOT), 'session_local');
});

test('a 127.0.0.1 share domain also falls back to a host-only cookie', () => {
    const jar = new CookieJar();
    visitPage('127.0.0.1', jar);
    writeSessionId('session_ip', { botKey: BOT, shareDomain: '127.0.0.1' });
    visitPage('127.0.0.1', jar, new Map());
    assert.equal(readSessionId(BOT), 'session_ip');
});

test('bare and dotted share domains both scope the cookie to the parent', () => {
    for (const shareDomain of ['example.com', '.example.com']) {
        const jar = new CookieJar();
        visitPage('example.com', jar);
        writeSessionId('session_x', { botKey: BOT, shareDomain });
        visitPage('shop.example.com', jar, new Map());
        assert.equal(readSessionId(BOT), 'session_x', `shareDomain=${shareDomain}`);
    }
});

// NOTE: The widget's open/closed PANEL state is intentionally not persisted —
// it always starts closed on every page load (see ChatWidget's initial state),
// so there is no storage-level open-flag behaviour to cover here. The
// conversation (session id) continuity is covered by the tests above.

// ── Zero-config apex auto-detection ──────────────────────────────────────────
// With no ``session_share_domain`` set, the widget derives the registrable apex
// from the current host by probing cookies (broadest that sticks). The jar here
// accepts any Domain (it can't model a public-suffix list), so these cover the
// common single/two-level cases; ccTLD rejection is a browser guarantee.

test('detectApexDomain: a subdomain host resolves to the registrable apex', () => {
    const jar = new CookieJar();
    visitPage('academy.example.com', jar);
    assert.equal(detectApexDomain(), 'example.com');
});

test('detectApexDomain: an apex host resolves to itself', () => {
    const jar = new CookieJar();
    visitPage('example.com', jar);
    assert.equal(detectApexDomain(), 'example.com');
});

test('detectApexDomain: localhost has no apex → host-only fallback', () => {
    const jar = new CookieJar();
    visitPage('localhost', jar);
    assert.equal(detectApexDomain(), 'localhost');
});

test('resolveShareDomain: an explicit config always wins over auto-detect', () => {
    const jar = new CookieJar();
    visitPage('academy.example.com', jar);
    assert.equal(resolveShareDomain('deliberate.example.com'), 'deliberate.example.com');
});

test('auto-detect: session carries apex → subdomain with NO configured domain', () => {
    const jar = new CookieJar();

    // Apex page, sharing left unconfigured — resolver auto-detects the apex.
    visitPage('example.com', jar);
    const shareDomain = resolveShareDomain(undefined);
    assert.equal(shareDomain, 'example.com');
    writeSessionId('session_auto', { botKey: BOT, shareDomain });

    // Subdomain: fresh localStorage, so only the auto-scoped cookie can bridge.
    visitPage('academy.example.com', jar, new Map());
    assert.equal(readSessionId(BOT), 'session_auto');
});
