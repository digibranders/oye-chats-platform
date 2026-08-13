# Crawlable Attribution & Backlinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OyeChats attribution visible to search engines and AI crawlers by emitting a server-rendered `<a>` in the customer's install snippet, and fix the widget's dead `branding_url` / `branding_text` fields while adding `?ref=` attribution to the badge.

**Architecture:** Two independently shippable phases. **Phase A** (widget) makes the in-widget badge honour the per-bot `branding_text` / `branding_url` the API already serves, and appends `?ref=<bot_key>` + UTMs so referral clicks become measurable — pure client change, no API work. **Phase B** (dashboard) adds an attribution `<a>` alongside the `<script>` in every install snippet the dashboard generates, so the link exists in the customer's HTML **before JavaScript runs** — the only thing that produces a real backlink. Both phases route their URL-building through one pure helper per app so behaviour is unit-testable and cannot drift between surfaces.

**Tech Stack:** React 19 · Vite · Tailwind v4 (widget, `node:test`) · React 19 · TypeScript · Vitest (dashboard) · no backend or DB changes

---

## Spec

### Problem

Verified live on 2026-08-11 against production. The "Powered by OyeChats" badge exists and renders, but **no crawler can ever see it**, so the entire customer base produces zero backlinks and zero AI-citable brand mentions.

Evidence:

| Test | Result |
|---|---|
| `oyechats.com` raw HTML, Googlebot UA | 0 × "Powered by" |
| `oyechats.com` raw HTML, ClaudeBot UA | 0 × "Powered by" |
| `oyechats.com` rendered, before launcher click | widget root present, **0 anchors** |
| `fynix.digital` raw HTML (customer) | **0** occurrences of the string `oyechats` — anything |
| `iamgaurav.online` raw HTML (customer) | 1 match, but it is a URL inside the Next.js RSC JSON payload (`<Script strategy="lazyOnload">`), not an anchor |
| Both customers, widget open | badge appears, shadow-DOM only, `poweredByInLightDom: false` |

Root cause is structural, not configuration: the badge is created by JS, after a user interaction, inside a shadow root. Non-rendering crawlers (Ahrefs, Majestic, Moz, Common Crawl, GPTBot, ClaudeBot, PerplexityBot) execute no JS at all, and even Google — which does flatten open shadow roots — never clicks the launcher, so the node does not exist during its render pass.

Secondary defects found while investigating:

1. `Bot.branding_text` and `Bot.branding_url` are stored ([`api/app/db/models.py:439-440`](../../../api/app/db/models.py)) and served ([`api/app/api/bot_routes.py:699-700`](../../../api/app/api/bot_routes.py)) — but the widget **hardcodes both** ([`widget/src/components/ChatInput.jsx:730,735-736`](../../../widget/src/components/ChatInput.jsx)). White-label customers still ship our text and our link. `grep -rn brandingUrl widget/src` returns nothing.

   **Correction (found by the Phase A review, 2026-08-11):** an earlier draft of this spec claimed these fields are "editable in the admin UI". They are not. `grep -rn branding_url app/src` returns nothing — the Admin 2.0 rebuild's [`BrandingSection.tsx`](../../../app/src/features/agents/experience/BrandingSection.tsx) exposes only the `show_branding` toggle. The API accepts both fields ([`bot_routes.py:266-267`](../../../api/app/api/bot_routes.py)), so today only a direct API or DB write can set them. Phase A is still correct and shippable — it removes the hardcoding and wires the plumbing — but its white-label benefit stays **dormant** until a follow-up adds the two fields to the admin. See follow-ups 5 and 6.
2. The badge href is bare `https://www.oyechats.com` with no `?ref=` or UTM, so referral clicks land in analytics as untagged direct traffic. The channel is currently unmeasurable.

### Decisions

- **D1 — Visible, not hidden.** The attribution line is rendered and readable. Hidden text (`display:none`, off-screen, zero-opacity) is out of scope and explicitly rejected: it violates Google's hidden-text and link-scheme policies, the penalty lands on the *customer's* domain, and — since the injected node would be equally invisible to non-rendering crawlers — it would produce the same zero result while adding the risk.

  **This constrains the styling, not just the markup.** The anchor uses `color:inherit;opacity:0.7`, not a fixed grey. A hardcoded `#9ca3af` at 11px is legible on the light backgrounds that are the common case but approaches invisible on a dark-themed host footer — and an attribution link that renders invisible *is* the penalised pattern, regardless of intent. Inheriting the host's text colour keeps the line subordinate on any background while guaranteeing it stays readable, which is what makes D1 defensible rather than merely stated.
- **D2 — `rel="nofollow"` on the snippet anchor.** Google's link spam policy names widget-distributed links as a link scheme. A sitewide, identical-anchor, self-placed link across every customer is exactly that footprint. We keep the brand mention (what AI search cites) and the referral click, and forgo nominal PageRank. Dofollow equity comes from the customer-showcase reciprocal links, which are out of scope here.
- **D3 — `?ref=<bot_key>` for attribution.** `bot_key` is already public (it ships in `data-bot-key`), already available client-side as `window.OYECHATS_BOT_KEY`, and already available at snippet-generation time. Using it needs no new API surface and no new identifier.
- **D4 — White-label URLs are never rewritten.** If `branding_url` points anywhere other than an `oyechats.com` host, the helper returns it untouched — no `ref`, no UTM. Stamping our tracking onto a customer's own white-label link would be wrong.
- **D5 — Snippet attribution is gated on the `branding_removable` entitlement.** Plans that can remove branding get a snippet with no anchor. Tradeoff accepted: a paid customer who *chooses* to keep branding will not get the anchor either, because `WebsiteInstall` does not currently load the bot's `showBranding` value. Revisit only if that combination proves common.
- **D6 — Per-platform attribution mode.** Not every install target can host a server-rendered anchor. Three modes:
  - `html` — anchor pasted as raw HTML into a served template.
  - `jsx` — anchor rendered in a server-rendered React tree (Next.js).
  - `manual` — the anchor **cannot** be made crawlable through this install path; the step tells the user plainly and points them at their site template instead.

  GTM is `manual` and must say so explicitly: a tag manager injects client-side, so an anchor added via GTM has exactly the crawlability problem this plan exists to fix. Shipping a GTM step that implies otherwise would be worse than shipping nothing.

### Non-goals

- Backend, DB, or migration changes. The API already serves everything needed.
- Customer showcase / reciprocal-link pages (`oyechats.com/customers/<slug>`). Separate project, higher leverage, tracked separately.
- Retrofitting the anchor onto sites already installed. This changes what new installs copy; existing customers need an outreach motion, out of scope.
- Any change to `oyechats.com` marketing site.

### Success criteria

1. `curl -A Googlebot <customer-site>` on a site installed from a post-change `html`-mode snippet returns ≥1 `Powered by OyeChats` anchor.
2. Widget badge href on a default bot contains `ref=<bot_key>&utm_source=widget&utm_medium=referral`.
3. A bot with a custom `branding_text` / `branding_url` renders that text, linking to that URL, with no `ref` or UTM appended.
4. A bot on a `branding_removable` plan gets an install snippet with no anchor.
5. `widget`: lint ✓ build ✓ `npm test` ✓ · `app`: lint ✓ typecheck ✓ build ✓ test ✓

---

## File Structure

**Phase A — widget**

| File | Responsibility |
|---|---|
| `widget/src/services/brandingLink.js` | **Create.** Pure helpers: build the badge href (ref/UTM stamping, white-label passthrough, URL validation) and normalise/split the badge text. No DOM, no React — lives in `services/` so the existing `node --test src/services/*.test.js` runner picks it up. |
| `widget/src/services/brandingLink.test.js` | **Create.** Unit tests for the above. |
| `widget/src/components/ChatInput.jsx` | **Modify.** Replace the hardcoded href and text with helper output driven by `settings.branding_url` / `settings.branding_text`. |

**Phase B — dashboard**

| File | Responsibility |
|---|---|
| `app/src/data/widgetEmbed.ts` | **Create.** Single source of truth for embed markup: attribution href, the HTML anchor string and the JSX anchor string. Every platform step and the AI install prompt render from here so they cannot drift. Written in TypeScript per the `app/CLAUDE.md` mandate ("migrate toward TS where the mandate touches new code") — the sibling `platformIntegrations.js` + `.d.ts` split exists only because that file is pre-existing JS, and is not a pattern to copy for new files. |
| `app/src/data/widgetEmbed.test.ts` | **Create.** Unit tests for the above. |
| `app/src/data/platformIntegrations.js` | **Modify.** Thread an `opts` argument through every platform's `getSteps` and render the attribution step via `widgetEmbed`. |
| `app/src/data/platformIntegrations.d.ts` | **Modify.** Update `Platform` / `getSteps` types. |
| `app/src/features/agents/channels/installPrompt.ts` | **Modify.** Pass `opts` through and document the attribution line for the user's coding agent. |
| `app/src/features/agents/channels/installPrompt.test.ts` | **Modify.** Cover attribution on/off. |
| `app/src/features/agents/channels/WebsiteInstall.tsx` | **Modify.** Resolve the entitlement and pass `{ attribution }` into both `getSteps` and `buildInstallPrompt`. |

---

# Phase A — Widget branding wiring

## Task 1: Branding link helper

**Files:**
- Create: `widget/src/services/brandingLink.js`
- Test: `widget/src/services/brandingLink.test.js`

- [ ] **Step 1: Write the failing test**

Create `widget/src/services/brandingLink.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_BRANDING_TEXT,
    DEFAULT_BRANDING_URL,
    buildBrandingHref,
    resolveBrandingText,
    splitBrandingText,
} from './brandingLink.js';

test('stamps ref and utm on the default oyechats url', () => {
    const url = new URL(buildBrandingHref(DEFAULT_BRANDING_URL, 'bot-11a026a4b8b3'));
    assert.equal(url.origin + url.pathname, 'https://www.oyechats.com/');
    assert.equal(url.searchParams.get('ref'), 'bot-11a026a4b8b3');
    assert.equal(url.searchParams.get('utm_source'), 'widget');
    assert.equal(url.searchParams.get('utm_medium'), 'referral');
});

test('stamps the apex oyechats host too', () => {
    const url = new URL(buildBrandingHref('https://oyechats.com/', 'bot-abc'));
    assert.equal(url.searchParams.get('ref'), 'bot-abc');
});

test('falls back to the default url when branding url is missing or blank', () => {
    for (const input of [undefined, null, '', '   ']) {
        const url = new URL(buildBrandingHref(input, 'bot-abc'));
        assert.equal(url.origin, 'https://www.oyechats.com');
        assert.equal(url.searchParams.get('ref'), 'bot-abc');
    }
});

test('leaves a white-label url completely untouched', () => {
    const href = buildBrandingHref('https://acme.example/support', 'bot-abc');
    assert.equal(href, 'https://acme.example/support');
});

test('omits ref when the bot key is missing or malformed', () => {
    for (const key of [undefined, '', 'bad key!', 'x'.repeat(65)]) {
        const url = new URL(buildBrandingHref(DEFAULT_BRANDING_URL, key));
        assert.equal(url.searchParams.get('ref'), null);
        assert.equal(url.searchParams.get('utm_source'), 'widget');
    }
});

test('rejects non-http protocols and unparseable urls', () => {
    for (const bad of ['javascript:alert(1)', 'not a url', 'ftp://x.example']) {
        const url = new URL(buildBrandingHref(bad, 'bot-abc'));
        assert.equal(url.origin, 'https://www.oyechats.com');
    }
});

test('preserves existing query params on a custom oyechats url', () => {
    const url = new URL(buildBrandingHref('https://www.oyechats.com/pricing?plan=pro', 'bot-abc'));
    assert.equal(url.pathname, '/pricing');
    assert.equal(url.searchParams.get('plan'), 'pro');
    assert.equal(url.searchParams.get('ref'), 'bot-abc');
});

test('resolveBrandingText trims, falls back, and caps length', () => {
    assert.equal(resolveBrandingText(undefined), DEFAULT_BRANDING_TEXT);
    assert.equal(resolveBrandingText('   '), DEFAULT_BRANDING_TEXT);
    assert.equal(resolveBrandingText('  Powered by Acme  '), 'Powered by Acme');
    assert.equal(resolveBrandingText('x'.repeat(80)).length, 60);
});

test('splitBrandingText separates the trailing brand word', () => {
    assert.deepEqual(splitBrandingText('Powered by OyeChats'), { lead: 'Powered by', brand: 'OyeChats' });
    assert.deepEqual(splitBrandingText('Acme'), { lead: '', brand: 'Acme' });
    assert.deepEqual(splitBrandingText('Built with love by Acme'), { lead: 'Built with love by', brand: 'Acme' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd widget && node --test --test-reporter=spec src/services/brandingLink.test.js
```

Expected: FAIL — `Cannot find module './brandingLink.js'`

- [ ] **Step 3: Write the implementation**

Create `widget/src/services/brandingLink.js`:

```js
/**
 * brandingLink - resolves the widget footer badge's href and label.
 *
 * Two jobs the component must not do inline:
 *
 *  1. Attribution. Links to our own site get `?ref=<bot_key>` plus UTMs so the
 *     badge becomes a measurable acquisition channel instead of untagged direct
 *     traffic. A white-label `branding_url` pointing anywhere else is returned
 *     verbatim - stamping our tracking onto a customer's own link would be wrong.
 *  2. Safety. `branding_url` is customer-editable, so anything unparseable or
 *     non-http (`javascript:` above all) falls back to the default rather than
 *     reaching an anchor's href.
 */

export const DEFAULT_BRANDING_TEXT = 'Powered by OyeChats';
export const DEFAULT_BRANDING_URL = 'https://www.oyechats.com';

/** Hosts we own, and therefore may append our own tracking params to. */
const OYECHATS_HOSTS = new Set(['oyechats.com', 'www.oyechats.com']);

/** Bot keys are public ids like `bot-11a026a4b8b3`; anything else is not ours. */
const BOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Longest label we render before the single-line footer starts to break. */
const MAX_BRANDING_TEXT_LENGTH = 60;

/**
 * Build the badge href.
 *
 * @param {string | null | undefined} brandingUrl - `settings.branding_url`.
 * @param {string | null | undefined} botKey - `window.OYECHATS_BOT_KEY`.
 * @returns {string} An absolute http(s) URL, always safe to place in an href.
 */
export function buildBrandingHref(brandingUrl, botKey) {
    const raw =
        typeof brandingUrl === 'string' && brandingUrl.trim()
            ? brandingUrl.trim()
            : DEFAULT_BRANDING_URL;

    let url;
    try {
        url = new URL(raw);
    } catch {
        url = new URL(DEFAULT_BRANDING_URL);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        url = new URL(DEFAULT_BRANDING_URL);
    }

    // White-label destination - hand it back exactly as the customer set it.
    if (!OYECHATS_HOSTS.has(url.hostname.toLowerCase())) {
        return url.toString();
    }

    if (typeof botKey === 'string' && BOT_KEY_PATTERN.test(botKey)) {
        url.searchParams.set('ref', botKey);
    }
    url.searchParams.set('utm_source', 'widget');
    url.searchParams.set('utm_medium', 'referral');
    return url.toString();
}

/**
 * Normalise the badge label: trim, fall back to the default, and cap the length
 * so a long custom string can't blow out the footer's single-line grid.
 *
 * @param {string | null | undefined} brandingText - `settings.branding_text`.
 * @returns {string}
 */
export function resolveBrandingText(brandingText) {
    const trimmed = typeof brandingText === 'string' ? brandingText.trim() : '';
    if (!trimmed) return DEFAULT_BRANDING_TEXT;
    return trimmed.slice(0, MAX_BRANDING_TEXT_LENGTH);
}

/**
 * Split the label into a muted lead and a coloured trailing brand word, so
 * "Powered by Acme" gets the same two-tone treatment "Powered by OyeChats" has
 * always had, without the component hardcoding either.
 *
 * @param {string} text
 * @returns {{ lead: string, brand: string }}
 */
export function splitBrandingText(text) {
    const cleaned = String(text ?? '').trim();
    const lastSpace = cleaned.lastIndexOf(' ');
    if (lastSpace === -1) return { lead: '', brand: cleaned };
    return {
        lead: cleaned.slice(0, lastSpace).trim(),
        brand: cleaned.slice(lastSpace + 1),
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd widget && node --test --test-reporter=spec src/services/brandingLink.test.js
```

Expected: PASS — 9 tests passing.

- [ ] **Step 5: Run the full widget suite and lint**

```bash
cd widget && npm test && npm run lint
```

Expected: all `src/services/*.test.js` pass; eslint reports no errors.

- [ ] **Step 6: Commit**

```bash
git add widget/src/services/brandingLink.js widget/src/services/brandingLink.test.js
git commit -m "feat(widget): add brandingLink helper for badge href and label"
```

---

## Task 2: Wire the badge to per-bot branding

**Files:**
- Modify: `widget/src/components/ChatInput.jsx` (import block; badge block at lines 728-740)

- [ ] **Step 1: Add the import**

Open `widget/src/components/ChatInput.jsx`. Find the existing import block at the top of the file and add:

```jsx
import {
    buildBrandingHref,
    resolveBrandingText,
    splitBrandingText,
} from '../services/brandingLink';
```

- [ ] **Step 2: Compute the badge values**

Inside the `ChatInput` component body, after the props destructuring that ends at line 61 area and before the returned JSX, add:

```jsx
    // Badge href/label come from the bot's own branding settings. Memoised on
    // the two inputs that can change; the bot key is a page-lifetime global set
    // by the loader, so it is read directly rather than threaded as a prop.
    const branding = useMemo(() => {
        const text = resolveBrandingText(settings?.branding_text);
        return {
            href: buildBrandingHref(
                settings?.branding_url,
                typeof window !== 'undefined' ? window.OYECHATS_BOT_KEY : undefined,
            ),
            ...splitBrandingText(text),
        };
    }, [settings?.branding_text, settings?.branding_url]);
```

If `useMemo` is not already imported from `react` in this file, add it to the existing React import.

- [ ] **Step 3: Replace the hardcoded badge**

Replace lines 728-740 — the block that currently reads `href="https://www.oyechats.com"` and `Powered by{' '}<span …>OyeChats</span>` — with:

```jsx
                    {showBranding ? (
                        <a
                            href={branding.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="whitespace-nowrap text-[10px] font-semibold text-gray-300 hover:text-gray-400 transition-colors justify-self-end"
                        >
                            {branding.lead ? `${branding.lead} ` : ''}
                            <span style={{ color: 'rgb(49% 23% 93%)' }}>{branding.brand}</span>
                        </a>
                    ) : (
                        <span className="justify-self-end" />
                    )}
```

- [ ] **Step 4: Lint and build**

```bash
cd widget && npm run lint && npm run build
```

Expected: eslint clean; build emits `dist/oyechats-widget.js`.

- [ ] **Step 5: Verify in a browser**

```bash
cd widget && npx vite preview --port 4173
```

The build copies `dev/host.html` → `dist/index.html`, so the fixture serves at <http://localhost:4173/>. Open it, click the launcher to open the chat, and confirm in DevTools:

```js
document.getElementById('oyechats-widget-root').shadowRoot
  .querySelectorAll('a')[1].href
```

Expected: contains `ref=`, `utm_source=widget`, `utm_medium=referral`.

- [ ] **Step 6: Commit**

```bash
git add widget/src/components/ChatInput.jsx
git commit -m "fix(widget): honour per-bot branding_text/branding_url and tag badge with ref"
```

---

# Phase B — Crawlable install snippet

## Task 3: Embed markup helper

**Files:**
- Create: `app/src/data/widgetEmbed.ts`
- Test: `app/src/data/widgetEmbed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/data/widgetEmbed.test.ts`:

```js
import { describe, it, expect } from 'vitest';
import {
  attributionHref,
  attributionAnchorHtml,
  attributionAnchorJsx,
  MANUAL_ATTRIBUTION_NOTE,
} from './widgetEmbed';

const KEY = 'bot-11a026a4b8b3';

describe('attributionHref', () => {
  it('tags the link with the bot key and utm params', () => {
    const url = new URL(attributionHref(KEY));
    expect(url.origin + url.pathname).toBe('https://www.oyechats.com/');
    expect(url.searchParams.get('ref')).toBe(KEY);
    expect(url.searchParams.get('utm_source')).toBe('widget');
    expect(url.searchParams.get('utm_medium')).toBe('referral');
  });

  it('omits ref for a malformed key', () => {
    expect(new URL(attributionHref('bad key!')).searchParams.get('ref')).toBeNull();
  });
});

describe('attributionAnchorHtml', () => {
  it('is a visible nofollow anchor carrying the brand name', () => {
    const html = attributionAnchorHtml(KEY);
    expect(html).toContain('rel="nofollow"');
    expect(html).toContain('>Powered by OyeChats</a>');
    expect(html).toContain(`ref=${KEY}`);
    expect(html).not.toContain('display:none');
  });
});

describe('attributionAnchorJsx', () => {
  it('emits JSX-shaped style and rel attributes', () => {
    const jsx = attributionAnchorJsx(KEY);
    expect(jsx).toContain('rel="nofollow"');
    expect(jsx).toContain('style={{');
    expect(jsx).toContain('Powered by OyeChats');
  });
});

describe('MANUAL_ATTRIBUTION_NOTE', () => {
  it('warns that tag-manager injection is not crawlable', () => {
    expect(MANUAL_ATTRIBUTION_NOTE).toMatch(/crawler/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd app && npx vitest run src/data/widgetEmbed.test.ts
```

Expected: FAIL — cannot resolve `./widgetEmbed`.

- [ ] **Step 3: Write the implementation**

Create `app/src/data/widgetEmbed.ts`. Types are declared inline — no separate `.d.ts` shim:

```ts
/**
 * widgetEmbed - single source of truth for the markup a customer pastes.
 *
 * The widget mounts into a shadow root from JavaScript, after the visitor
 * clicks the launcher. That means nothing it renders - including the "Powered
 * by OyeChats" badge - is ever visible to a crawler: non-rendering crawlers run
 * no JS at all, and rendering ones never click. The only attribution that can
 * be indexed is an anchor that sits in the customer's served HTML next to the
 * script tag, which is what these helpers produce.
 *
 * The anchor is deliberately visible (hidden text is a Google policy violation
 * that would penalise the customer's domain) and deliberately `nofollow`
 * (a self-placed, sitewide, identical-anchor link is a named link scheme).
 * The value we want is the brand mention and the referral click, both of which
 * survive nofollow.
 */

/** Where the attribution anchor points, before per-bot tagging. */
const ATTRIBUTION_BASE_URL = 'https://www.oyechats.com/';

/** The anchor's visible text. */
export const ATTRIBUTION_TEXT = 'Powered by OyeChats';

/** Bot keys are public ids like `bot-11a026a4b8b3`. */
const BOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Inline style keeps the line unobtrusive without depending on host CSS.
 *
 * `color:inherit` rather than a fixed grey is deliberate: a hardcoded
 * `#9ca3af` at 11px approaches invisible on a dark-themed host footer, and an
 * attribution link that renders invisible is precisely the pattern Google
 * penalises - it would hand us the policy exposure this whole design exists to
 * avoid. Inheriting the host's own text colour and dimming it keeps the line
 * subordinate on any background while guaranteeing it is genuinely readable.
 *
 * Must stay hand-synced with the JSX style object in `attributionAnchorJsx`.
 */
const ANCHOR_CSS = 'font-size:11px;color:inherit;opacity:0.7;text-decoration:none';

/**
 * Shown for install paths that cannot produce a crawlable anchor.
 *
 * States only the problem. The caller supplies the action and the location, so
 * the two sentences chain instead of overlapping - an earlier draft had this
 * note prescribing "paste into your site template" and the caller appending
 * "Paste it into <location>", which rendered as visibly redundant install copy.
 */
export const MANUAL_ATTRIBUTION_NOTE =
  'This install path injects the widget from JavaScript, so anything it adds is invisible to crawlers.';

/** The attribution URL for one bot. */
export function attributionHref(botKey: string): string {
  const url = new URL(ATTRIBUTION_BASE_URL);
  if (BOT_KEY_PATTERN.test(botKey)) {
    url.searchParams.set('ref', botKey);
  }
  url.searchParams.set('utm_source', 'widget');
  url.searchParams.set('utm_medium', 'referral');
  return url.toString();
}

/** The attribution anchor as raw HTML, for templates the customer serves. */
export function attributionAnchorHtml(botKey: string): string {
  return `<a href="${attributionHref(botKey)}" rel="nofollow" style="${ANCHOR_CSS}">${ATTRIBUTION_TEXT}</a>`;
}

/** The attribution anchor as JSX source, for server-rendered React trees. */
export function attributionAnchorJsx(botKey: string): string {
  return `<a
  href="${attributionHref(botKey)}"
  rel="nofollow"
  style={{ fontSize: 11, color: 'inherit', opacity: 0.7, textDecoration: 'none' }}
>
  ${ATTRIBUTION_TEXT}
</a>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd app && npx vitest run src/data/widgetEmbed.test.ts
```

Expected: PASS — 5 tests passing.

- [ ] **Step 5: Typecheck and lint**

```bash
cd app && npm run typecheck && npm run lint
```

Expected: both clean. `widgetEmbed.ts` is new TypeScript, so `tsc --noEmit` must pass with no `any` and explicit return types on every export.

- [ ] **Step 6: Commit**

```bash
git add app/src/data/widgetEmbed.ts app/src/data/widgetEmbed.test.ts
git commit -m "feat(app): add widgetEmbed helper for crawlable attribution markup"
```

---

## Task 4: Thread attribution through platform steps

**Files:**
- Modify: `app/src/data/platformIntegrations.js`
- Modify: `app/src/data/platformIntegrations.d.ts`

Every platform's `getSteps` gains a third argument, and passes its attribution mode to the shared step builder. Mode assignment per D6:

**Revised during implementation:** an earlier draft of this task also declared `attributionMode` as a field on each platform object. The Task 4 quality review found nothing anywhere reads it — it was dead data, *and* it stated each platform's mode a second time, creating a drift hazard with no guard (this file is excluded from typechecking and has no test). The field was dropped; the argument passed to `attributionStep` is the single source of truth. The table below is the specification for that argument.

| Mode | Platforms | Where the anchor goes |
|---|---|---|
| `html` | `html`, `react`, `vue`, `angular`, `svelte`, `astro`, `wordpress`, `shopify`, `squarespace`, `webflow` | The served HTML template / footer code injection |
| `jsx` | `nextjs` | The root layout, server-rendered |
| `manual` | `gtm`, `wix`, `framer`, `bubble` | Cannot be crawlable via this path — instruct pasting into the site template |

`react` is `html` rather than a `useEffect` append: a Vite/CRA SPA serves `index.html`, so that is the only place an anchor is actually in the served document. Appending it from an effect would reproduce the exact bug this plan fixes.

- [ ] **Step 1: Add the import and the shared step builder**

At the top of `app/src/data/platformIntegrations.js`, below the existing `widgetScriptUrl` export, add:

```js
import {
    attributionAnchorHtml,
    attributionAnchorJsx,
    MANUAL_ATTRIBUTION_NOTE,
} from './widgetEmbed';

/**
 * The attribution step appended to a platform's install steps.
 *
 * Returns an empty array when attribution is off (plans entitled to remove
 * branding), so callers can spread it unconditionally.
 *
 * @param {string} botKey
 * @param {'html' | 'jsx' | 'manual'} mode
 * @param {string} location - where the user should paste it, in their words
 * @param {boolean} attribution
 * @returns {Array<{title: string, description: string, code: string | null, language?: string}>}
 */
const attributionStep = (botKey, mode, location, attribution) => {
    if (!attribution) return [];
    if (mode === 'manual') {
        return [
            {
                title: 'Add the attribution link to your site template',
                description: `${MANUAL_ATTRIBUTION_NOTE} For attribution a crawler can read, paste the link below into ${location}.`,
                code: attributionAnchorHtml(botKey),
                language: 'html',
            },
        ];
    }
    return [
        {
            title: 'Add the attribution link',
            description: `Paste this next to the widget snippet in ${location}. It is a normal visible link, so search engines and AI crawlers can read it - unlike the in-widget badge, which only exists after a visitor opens the chat.`,
            code: mode === 'jsx' ? attributionAnchorJsx(botKey) : attributionAnchorHtml(botKey),
            language: mode === 'jsx' ? 'jsx' : 'html',
        },
    ];
};
```

- [ ] **Step 2: Update the `html` platform as the reference case**

Replace the `html` platform definition (starting line 30) with:

```js
const html = {
    id: 'html',
    name: 'HTML',
    category: 'generic',
    description: 'Any static HTML website',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Add the script tag to your HTML',
            description:
                'Paste this snippet just before the closing </body> tag in your HTML file.',
            code: `<script src="${cdnUrl(env)}" data-bot-key="${botKey}"></script>`,
            language: 'html',
        },
        ...attributionStep(botKey, 'html', 'the same place, just before </body>', attribution),
        {
            title: 'Deploy your website',
            description:
                'Upload the updated HTML file to your hosting provider. The chat widget will appear automatically in the bottom-right corner.',
            code: null,
        },
    ],
};
```

- [ ] **Step 3: Update the `nextjs` platform as the `jsx` reference case**

Replace the `nextjs` platform definition (starting line 55) with:

```js
const nextjs = {
    id: 'nextjs',
    name: 'Next.js',
    category: 'framework',
    description: 'App Router or Pages Router',
    getSteps: (botKey, env, { attribution = true } = {}) => [
        {
            title: 'Import next/script in your root layout',
            description: 'At the top of your root layout file (app/layout.tsx or pages/_app.tsx), add this import.',
            code: `import Script from 'next/script';`,
            language: 'jsx',
        },
        {
            title: 'Add the widget just before </body>',
            description: 'Drop the OyeChats widget inside your <body>, right after {children}.',
            code: `<Script
  src="${cdnUrl(env)}"
  data-bot-key="${botKey}"
  strategy="lazyOnload"
/>`,
            language: 'jsx',
        },
        ...attributionStep(botKey, 'jsx', 'your root layout, next to the <Script> tag', attribution),
        {
            title: 'Deploy your application',
            description:
                'Push your changes to your hosting provider (Vercel, Netlify, etc.). The widget loads lazily after the page becomes interactive.',
            code: null,
        },
    ],
};
```

- [ ] **Step 4: Update the `gtm` platform as the `manual` reference case**

In the `gtm` platform definition (starting line 542), change its `getSteps` signature to `(botKey, env, { attribution = true } = {})`, and append this spread as the **last** entry of its returned steps array:

```js
        ...attributionStep(
            botKey,
            'manual',
            "your site's own footer template - not a GTM tag",
            attribution,
        ),
```

- [ ] **Step 5: Update the remaining eleven platforms**

For each platform below, make exactly two edits: change the `getSteps` signature to `(botKey, env, { attribution = true } = {})`, and insert the `attributionStep(...)` spread immediately **before** the final "deploy/publish" step (or last, if there is none).

| Platform const | mode argument | `location` argument |
|---|---|---|
| `react` | `'html'` | `'public/index.html (CRA) or index.html (Vite), just before </body>'` |
| `vue` | `'html'` | `'index.html, just before </body>'` |
| `angular` | `'html'` | `'src/index.html, just before </body>'` |
| `svelte` | `'html'` | `'src/app.html, just before </body>'` |
| `astro` | `'html'` | `'your shared layout, just before </body>'` |
| `wordpress` | `'html'` | `"your theme's footer.php, just before </body>"` |
| `shopify` | `'html'` | `'theme.liquid, just before </body>'` |
| `squarespace` | `'html'` | `'Settings → Advanced → Code Injection → Footer'` |
| `webflow` | `'html'` | `'Project Settings → Custom Code → Footer Code'` |
| `wix` | `'manual'` | `"a Text element in your site footer, using its link option"` |
| `framer` | `'manual'` | `'a Text layer in your site footer, using its link option'` |
| `bubble` | `'manual'` | `'a Text element in your page footer, using its link option'` |

Note `react` uses mode `'html'` even though its install step is a `useEffect` — see the rationale at the top of this task.

- [ ] **Step 6: Update the type shim**

In `app/src/data/platformIntegrations.d.ts`, replace the `Platform` interface with:

```ts
export interface GetStepsOptions {
  /** Include the crawlable attribution anchor. Defaults to true. */
  attribution?: boolean;
}

export interface Platform {
  id: string;
  name: string;
  category: string;
  description: string;
  getSteps: (botKey: string, env: PlatformEnv, options?: GetStepsOptions) => PlatformStep[];
}
```

No `attributionMode` field and no `AttributionMode` type — see the revision note at the top of this task.

- [ ] **Step 7: Verify every platform was updated**

Anchor these greps on syntax that only the real thing produces, so a passing comment or docstring can't shift the count. Never edit prose to make a count match — the grep is a check on the code, not a constraint on it.

```bash
cd app && grep -c "\.\.\.attributionStep(" src/data/platformIntegrations.js
```

Expected: `15` — one spread call site per platform. (Note the helper is declared `const attributionStep = (` with a space, so a bare `attributionStep(` pattern matches call sites only, not the definition.)

```bash
cd app && grep -o "attributionStep(botKey, '[a-z]*'" src/data/platformIntegrations.js | sort | uniq -c
```

Expected: `10 'html'`, `1 'jsx'`, `4 'manual'`. This is a per-line count, so it will miss any call site formatted across multiple lines — the `gtm` one is. Reconcile against the total of 15 above rather than assuming.

```bash
cd app && grep -rn "attributionMode" app/src
```

Expected: no output — the field was dropped as dead data.

- [ ] **Step 8: Lint and typecheck**

```bash
cd app && npm run lint && npm run typecheck
```

Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add app/src/data/platformIntegrations.js app/src/data/platformIntegrations.d.ts
git commit -m "feat(app): emit crawlable attribution anchor in every platform install step"
```

---

## Task 5: Attribution in the AI install prompt

**Files:**
- Modify: `app/src/features/agents/channels/installPrompt.ts`
- Test: `app/src/features/agents/channels/installPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/src/features/agents/channels/installPrompt.test.ts`. The file already imports `describe`/`expect`/`it` from vitest and defines a `prompt(overrides)` helper — reuse it:

```ts
describe('attribution', () => {
  it('documents the attribution anchor by default', () => {
    const text = prompt();
    expect(text).toContain('Powered by OyeChats');
    expect(text).toContain('rel="nofollow"');
    expect(text).toContain(`ref=${BOT_KEY}`);
  });

  it('omits the attribution anchor when attribution is off', () => {
    const text = prompt({ attribution: false });
    expect(text).not.toContain('Powered by OyeChats');
    expect(text).not.toContain('rel="nofollow"');
  });

  it('keeps every platform snippet free of hidden-text styling', () => {
    for (const platform of platforms) {
      const text = prompt({ platform });
      expect(text).not.toContain('display:none');
      expect(text).not.toContain('visibility:hidden');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd app && npx vitest run src/features/agents/channels/installPrompt.test.ts
```

Expected: FAIL — the prompt contains no attribution text and `attribution` is not a valid option.

- [ ] **Step 3: Add the option and render the anchor**

In `app/src/features/agents/channels/installPrompt.ts`:

Extend the import from `platformIntegrations` to also pull the embed helpers:

```ts
import { attributionAnchorHtml } from '../../../data/widgetEmbed';
```

Add to `BuildInstallPromptOptions`:

```ts
  /** Include the crawlable attribution anchor in the briefing. Defaults to true. */
  attribution?: boolean;
```

Change the `genericSteps` signature and its closing lines so the anchor is part of the generic path:

```ts
function genericSteps(botKey: string, scriptUrl: string, attribution: boolean): string {
```

and replace its final block (the one ending with the script-tag fence) with:

```ts
    'Whichever path applies, the tag that must end up on the page is:',
    '',
    '```html',
    `<script src="${scriptUrl}" data-bot-key="${botKey}"></script>`,
    '```',
    ...(attribution
      ? [
          '',
          'And directly beside it, this visible attribution link:',
          '',
          '```html',
          attributionAnchorHtml(botKey),
          '```',
        ]
      : []),
  ].join('\n');
```

Update `buildInstallPrompt` to accept and thread the flag:

```ts
export function buildInstallPrompt({
  botKey,
  apiBaseUrl,
  env,
  platform,
  attribution = true,
}: BuildInstallPromptOptions): string {
```

```ts
  const steps = platform
    ? platform.getSteps(botKey, env, { attribution }).map(renderStep).join('\n\n')
    : genericSteps(botKey, scriptUrl, attribution);
```

Finally, add an attribution guideline so the user's coding agent does not "tidy it away". Insert as a new numbered item after guideline 3 (`No Local Bundling`) in the returned template string:

```ts
4. **Attribution Link:** ${
    attribution
      ? 'Keep the attribution anchor visible in the rendered page. Do not hide it with CSS, do not move it into a JavaScript-injected element, and do not remove the `rel="nofollow"`. It must be present in the server-rendered HTML.'
      : 'No attribution link is required for this account.'
  }
```

Renumber the following guidelines (`Verification` becomes 5, `CSP Allowances` becomes 6) and update the two in-body references to them if any exist.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd app && npx vitest run src/features/agents/channels/installPrompt.test.ts
```

Expected: PASS — including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/features/agents/channels/installPrompt.ts app/src/features/agents/channels/installPrompt.test.ts
git commit -m "feat(app): include attribution anchor in the AI install prompt"
```

---

## Task 6: Gate attribution on the plan entitlement

**Files:**
- Modify: `app/src/features/agents/channels/WebsiteInstall.tsx`

- [ ] **Step 1: Resolve the entitlement**

In `app/src/features/agents/channels/WebsiteInstall.tsx`, add the hook import alongside the existing imports:

```tsx
import { useEntitlements } from '../../../hooks/useEntitlements';
```

Inside the component body, near the other hook calls, add:

```tsx
  // Plans entitled to remove branding get a snippet with no attribution anchor.
  // Note this keys off the entitlement, not the bot's live `showBranding` flag,
  // which this screen does not load - a paid customer who chooses to keep the
  // badge still gets an anchor-free snippet.
  const { hasFeature } = useEntitlements();
  const attribution = !hasFeature('branding_removable');
```

- [ ] **Step 2: Pass it into both consumers**

Find the call to `getSteps(...)` in this file and add the third argument:

```tsx
selectedPlatform.getSteps(botKey, env, { attribution })
```

Find the call to `buildInstallPrompt({ ... })` and add the field:

```tsx
      attribution,
```

- [ ] **Step 3: Lint, typecheck and build**

```bash
cd app && npm run lint && npm run typecheck && npm run build
```

Expected: all three clean.

- [ ] **Step 4: Verify in the running dashboard**

```bash
cd app && npm run dev
```

Open the dashboard, go to an agent → Channels → Website install. Confirm:
- A Free/Starter agent shows an "Add the attribution link" step whose code contains `rel="nofollow"` and `ref=<bot_key>`.
- Switching the platform selector to GTM shows the manual-mode wording naming the crawler limitation.
- The "copy prompt for your coding agent" output contains the anchor.

- [ ] **Step 5: Commit**

```bash
git add app/src/features/agents/channels/WebsiteInstall.tsx
git commit -m "feat(app): gate install-snippet attribution on the branding_removable entitlement"
```

---

# Phase C — Docs and final verification

## Task 7: Update the documented embed snippet

**Files:**
- Modify: `CLAUDE.md:57,100` · `AGENTS.md:50,93` · `README.md:198` · `widget/README.md:6`

- [ ] **Step 1: Update each documented snippet**

In each of the six locations, replace the bare script tag with the script tag plus anchor, so the docs match what the product now hands customers:

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
<a href="https://www.oyechats.com/?ref=bot-xxx&utm_source=widget&utm_medium=referral"
   rel="nofollow" style="font-size:11px;color:inherit;opacity:0.7;text-decoration:none">Powered by OyeChats</a>
```

Leave the development-embed snippets (`localhost:4173`) unchanged — attribution is irrelevant locally.

- [ ] **Step 2: Add a short rationale note**

In `CLAUDE.md`, directly under the Production Embed snippet, add:

```markdown
> The `<a>` is not decoration. The widget mounts into a shadow root from JS after the visitor clicks
> the launcher, so its in-widget "Powered by" badge is invisible to every crawler. This anchor is the
> only attribution that lands in the customer's served HTML. It is visible (hidden text would violate
> Google's policy and penalise the customer's domain) and `nofollow` (a sitewide self-placed link is a
> named link scheme). Plans with the `branding_removable` entitlement get a snippet without it.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md widget/README.md
git commit -m "docs: document the crawlable attribution anchor in the embed snippet"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run every gate**

```bash
cd widget && npm run lint && npm test && npm run build
```

Expected: eslint clean · all service tests pass · `dist/oyechats-widget.js` emitted.

```bash
cd app && npm run lint && npm run typecheck && npm test && npm run build
```

Expected: all four clean.

- [ ] **Step 2: Prove the success criteria end to end**

Serve a static page containing a snippet copied verbatim from the dashboard for a Free-plan bot, then fetch it the way a non-rendering crawler would:

```bash
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" http://localhost:8080/ | grep -c "Powered by OyeChats"
```

Expected: `1` — this is the number that is currently `0` on every live customer site, and the whole point of the change.

- [ ] **Step 3: Confirm the widget badge tagging**

With the built widget embedded on that same page, open the chat and run in DevTools:

```js
document.getElementById('oyechats-widget-root').shadowRoot
  .querySelectorAll('a')[1].href
```

Expected: contains `ref=`, `utm_source=widget`, `utm_medium=referral`.

- [ ] **Step 4: Confirm branch and push**

```bash
git branch --show-current
```

Expected: `development` — never `main`.

```bash
git push origin development
```

---

## Task 9: Restore custom branding text & URL to the admin UI

Added 2026-08-11 at the user's request, promoting follow-up 5 into the plan. Phase A made the widget honour `branding_text` / `branding_url`, but Admin 2.0 exposes neither, so the capability is unreachable through the product. To be precise about scope: the **"Remove branding" toggle was never dropped** — it is live in `BrandingSection.tsx` and correctly entitlement-gated. What is missing is the two *white-label* fields.

**Files:**
- Modify: `app/src/features/agents/experience/types.ts`
- Modify: `app/src/features/agents/experience/BrandingSection.tsx`
- Modify: `api/app/api/bot_routes.py`
- Test: `app/src/features/agents/experience/types.test.ts` (create if absent)
- Test: `api/tests/` — extend whichever module covers `/bots/settings/public`

### Visibility rule

Show the two fields only when `hasFeature('branding_removable') && draft.showBranding`.

Rationale: a plan without the entitlement must display "Powered by OyeChats" verbatim — that is the whole point of the free tier carrying our branding, and Phase B's backlink strategy depends on it. A plan *with* the entitlement gets a real choice: remove the badge entirely (existing toggle), or keep it and make it their own (these fields). There is nothing to customise on a badge that is switched off, so the fields collapse when `showBranding` is false.

### The entitlement bypass this closes

`bot_routes.py` already force-sets `effective_feature_flags["show_branding"] = True` when the plan lacks `branding_removable`, so a non-entitled customer cannot hide the badge by PATCHing directly. But it does **not** do the equivalent for `branding_text` / `branding_url` — it serves whatever is stored. A non-entitled customer could therefore PATCH `branding_text: "Powered by Acme"` via the public API and white-label for free, bypassing the paywall entirely. Adding the UI makes that path discoverable, so the server-side guard must land in the same change.

- [ ] **Step 1: Extend the draft model**

In `app/src/features/agents/experience/types.ts`:

Add to `DEFAULTS`:
```ts
  brandingText: 'Powered by OyeChats',
  brandingUrl: 'https://www.oyechats.com',
```

Add to the `ExperienceDraft` interface, in the Branding block after `showBranding`:
```ts
  /** `bot.branding_text` - the badge label. Only meaningful when
   * `showBranding` is true AND the plan has `branding_removable`; the backend
   * forces both this and `brandingUrl` back to defaults otherwise, so a
   * non-entitled workspace cannot white-label by calling the API directly. */
  brandingText: string;
  /** `bot.branding_url` - where the badge links. Same entitlement rule as
   * `brandingText`. The widget validates this independently
   * (`widget/src/services/brandingLink.js`) and falls back to the default for
   * anything non-http, so a bad value here can never reach a live `href`. */
  brandingUrl: string;
```

Add to `draftFromSettings`'s returned object, after `showBranding`:
```ts
    brandingText: asNonEmptyString(raw.branding_text, DEFAULTS.brandingText),
    brandingUrl: asNonEmptyString(raw.branding_url, DEFAULTS.brandingUrl),
```

Add to `settingsFromDraft`'s returned object, beside `feature_flags`:
```ts
    branding_text: draft.brandingText.trim() || DEFAULTS.brandingText,
    branding_url: draft.brandingUrl.trim() || DEFAULTS.brandingUrl,
```

- [ ] **Step 2: Add the fields to `BrandingSection.tsx`**

Inside the existing "Remove branding" `<section>`, render the two fields below the card when `canRemoveBranding && draft.showBranding`. Use `Input` from `'../../../design-system'` (already the convention — see `MessagesSection.tsx` and `PersonalitySection.tsx`), matching their label/help-text/spacing pattern exactly rather than inventing a new layout.

- Label the first "Badge text", help text: `Replace “Powered by OyeChats” with your own wording.`
- Label the second "Badge link", help text: `Where the badge sends visitors.`
- Both write through `onChange({ brandingText: … })` / `onChange({ brandingUrl: … })`.

Validate the URL inline: it must parse as an absolute `http:` or `https:` URL. On invalid input show an error message in the same style `BrandingSection` already uses for `uploadError` (`role="alert"`, `text-[var(--ds-danger)]`). Check whether `ExperiencePage` has an existing mechanism for blocking save on invalid input — if it does, follow it; if it does not, surface the inline error and do NOT invent a save-blocking mechanism. Report which you found.

- [ ] **Step 3: Close the server-side bypass**

In `api/app/api/bot_routes.py`, in the same block that computes `_plan_branding_removable` and forces `effective_feature_flags["show_branding"] = True`, also force the branding strings back to defaults for non-entitled plans, so the public settings payload the widget reads can never carry a white-label value the plan does not include:

```python
    # Mirror the show_branding lock: a plan without branding removal must also
    # not be able to re-label or re-target the badge by PATCHing the fields
    # directly. The admin UI hides these inputs for such plans, but the API is
    # the real boundary.
    effective_branding_text = bot.branding_text or "Powered by OyeChats"
    effective_branding_url = bot.branding_url or "https://www.oyechats.com"
    if not _plan_branding_removable:
        effective_branding_text = "Powered by OyeChats"
        effective_branding_url = "https://www.oyechats.com"
```

and use those two variables in the returned dict in place of the current inline `bot.branding_text or …` / `bot.branding_url or …` expressions.

- [ ] **Step 4: Tests**

Frontend — round-trip the two fields through `draftFromSettings` → `settingsFromDraft`, covering: a stored custom value survives; a missing/blank stored value falls back to the default; whitespace-only input saves as the default rather than blank.

Backend — extend the existing `/bots/settings/public` coverage with two cases: an entitled plan with custom branding gets its custom values; a non-entitled plan with the same custom values stored gets the defaults. The second is the bypass regression test and is the important one.

- [ ] **Step 5: Gates**

```bash
cd app && npm run lint && npm run typecheck && npm test && npm run build
```

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

- [ ] **Step 6: Commit**

```bash
git add app/src/features/agents/experience/types.ts app/src/features/agents/experience/BrandingSection.tsx api/app/api/bot_routes.py
git commit -m "feat: let entitled workspaces white-label the widget badge"
```

---

## Follow-ups (not in this plan)

1. **Customer showcase pages** (`oyechats.com/customers/<slug>`) with opt-in reciprocal links. This is where dofollow equity actually comes from, and it reaches customers regardless of install method. Higher leverage than this plan; should be scoped next.
2. **Outreach to existing installs.** This plan changes what *new* installs copy. Existing customers keep the anchor-free snippet until someone asks them to update.
3. **Sample more customer domains.** Both sites checked (Fynix, iamgaurav) inject the widget through a framework or tag manager. If that is representative, the `html`-mode snippet reaches fewer sites than hoped and follow-up 1 becomes the primary channel.
4. **Unverified UX lead:** on iamgaurav.online the first launcher click opened only the teaser card; the panel needed a second action. Seen once, not isolated — worth reproducing separately.

5. **Add `branding_text` / `branding_url` to the admin UI.** Raised by the Phase A review. The API accepts both and the widget now honours both, but Admin 2.0's `BrandingSection.tsx` exposes neither — so the white-label capability Phase A delivered is unreachable through the product. Two fields alongside the existing `showBranding` toggle, mapped in `app/src/features/agents/experience/types.ts` (see `showBranding` at :163/:220). Should be gated on the same `branding_removable` entitlement. Until this lands, findings 6 and 7 below cannot actually bite.

6. **`WidgetChatPreview.jsx` diverges from the live widget.** Raised by the Phase A review. `app/src/components/WidgetChatPreview.jsx:499-505` still hardcodes `href="https://www.oyechats.com"` and the literal `Powered by OyeChats`, and it backs both `ExperiencePreview.tsx:135` and Launch Studio's `WidgetPreview.tsx:34`. Once follow-up 5 lands, a white-label bot would preview as OyeChats and ship as Acme. Fix by porting the `brandingLink` helper into `app/src` (the plan's own principle is one pure helper per app) and passing `branding_text` / `branding_url` through.

7. **Legacy settings fallback drops branding.** Raised by the Phase A review. `widget/src/services/api.js:866` falls back to `/client/settings` when the primary endpoint fails, and `api/app/api/client_routes.py:68-77` returns no branding fields — so a white-label bot would silently revert to OyeChats text and link during an outage. Pre-existing shape, but Phase A makes it load-bearing. Cheap fix: add the two keys to that payload.

8. **Minor durability notes on `brandingLink.js`.** Raised by the Phase A review, neither worth changing now: white-label URLs are round-tripped through `URL.toString()`, so `https://acme.example` returns as `https://acme.example/` and IDN hosts are punycoded (semantically identical, never re-tagged — worth one docblock line so a maintainer isn't surprised); and `OYECHATS_HOSTS` covers apex + `www` only, so a future badge target on e.g. `blog.oyechats.com` would silently lose its `ref`/UTM.
