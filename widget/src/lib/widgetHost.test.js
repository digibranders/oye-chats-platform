import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTAINER_ID, ensureHost, ensureStylesheet, whenStylesheetReady } from './widgetHost.js';

// Minimal DOM: just what widgetHost.js touches. The browser behaviour (the
// page not shifting while the stylesheet loads) is covered by
// tests/e2e/launcher-load.spec.js.

class FakeElement {
    constructor(doc, tag) {
        this.ownerDocument = doc;
        this.tagName = tag.toUpperCase();
        this.attributes = new Map();
        this.children = [];
        this.listeners = new Map();
        this.shadowRoot = null;
        this.sheet = null;
        this.parent = null;
        const props = new Map();
        this.style = {
            props,
            setProperty: (name, value, priority) => props.set(name, { value, priority }),
        };
    }
    set id(value) { this.attributes.set('id', value); }
    get id() { return this.attributes.get('id'); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    attachShadow() { this.shadowRoot = new FakeShadow(this.ownerDocument); return this.shadowRoot; }
    addEventListener(type, cb) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(cb);
    }
    fire(type) {
        const cbs = this.listeners.get(type) || [];
        this.listeners.set(type, []);
        for (const cb of cbs) cb({ type });
    }
}

class FakeShadow {
    constructor(doc) { this.ownerDocument = doc; this.children = []; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    querySelector(selector) {
        return selector === 'link[data-oyechats-style="1"]'
            ? this.children.find((c) => c.getAttribute('data-oyechats-style') === '1') || null
            : null;
    }
}

const makeDocument = () => {
    const doc = {
        created: [],
        createElement(tag) { const el = new FakeElement(doc, tag); doc.created.push(el); return el; },
        getElementById(id) { return doc.body.children.find((c) => c.id === id) || null; },
    };
    doc.body = new FakeElement(doc, 'body');
    return doc;
};

test('the host is created once and pinned out of the page flow before any stylesheet', () => {
    const doc = makeDocument();
    const { host, shadow } = ensureHost(doc);

    assert.equal(host.id, CONTAINER_ID);
    assert.equal(doc.body.children.length, 1);
    for (const [prop, value] of [['position', 'fixed'], ['width', '0'], ['height', '0'], ['pointer-events', 'none']]) {
        assert.deepEqual(host.style.props.get(prop), { value, priority: 'important' }, prop);
    }
    assert.equal(host.getAttribute('data-lenis-prevent'), '');

    const again = ensureHost(doc);
    assert.equal(again.host, host);
    assert.equal(again.shadow, shadow);
    assert.equal(doc.body.children.length, 1, 'a second call must not add a second host');
});

test('an existing host, e.g. from an older build, is pinned too', () => {
    const doc = makeDocument();
    const legacy = doc.body.appendChild(doc.createElement('div'));
    legacy.id = CONTAINER_ID;
    const { host } = ensureHost(doc);
    assert.equal(host, legacy);
    assert.equal(host.style.props.get('position').value, 'fixed');
});

test('the stylesheet link is added once and reused', () => {
    const doc = makeDocument();
    const { shadow } = ensureHost(doc);
    const link = ensureStylesheet(shadow, 'https://cdn.example/app/x.css');
    assert.equal(link.rel, 'stylesheet');
    assert.equal(link.href, 'https://cdn.example/app/x.css');
    assert.equal(ensureStylesheet(shadow, 'https://cdn.example/app/x.css'), link);
    assert.equal(shadow.children.filter((c) => c.tagName === 'LINK').length, 1);
});

test('ready waits for the stylesheet load event', async () => {
    const doc = makeDocument();
    const link = ensureStylesheet(ensureHost(doc).shadow, 'x.css');
    let settled = false;
    const ready = whenStylesheetReady(link).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    link.fire('load');
    await ready;
    assert.equal(settled, true);
});

test('ready resolves at once if the stylesheet loaded before the app asked', async () => {
    const doc = makeDocument();
    const link = ensureStylesheet(ensureHost(doc).shadow, 'x.css');
    link.fire('load');
    await whenStylesheetReady(link);
    assert.equal(link.getAttribute('data-oyechats-style-state'), 'loaded');
});

test('ready rejects when the stylesheet failed, before or after the app asked', async () => {
    const doc = makeDocument();
    const early = ensureStylesheet(ensureHost(doc).shadow, 'early.css');
    early.fire('error');
    await assert.rejects(whenStylesheetReady(early), /failed to load: early\.css/);

    const doc2 = makeDocument();
    const late = ensureStylesheet(ensureHost(doc2).shadow, 'late.css');
    const pending = whenStylesheetReady(late);
    late.fire('error');
    await assert.rejects(pending, /failed to load: late\.css/);
});

test('a link without a recorded state counts as loaded once its sheet exists', async () => {
    const doc = makeDocument();
    const link = doc.createElement('link');
    link.sheet = {};
    await whenStylesheetReady(link);
});
