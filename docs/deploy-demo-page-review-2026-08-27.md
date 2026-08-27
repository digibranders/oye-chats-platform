# Deploy page demo link: review and rebuild plan

Date: 2026-08-27
Scope: `api/app/api/bot_routes.py` (`/demo/{bot_key}`), `app/src/features/agents/channels/DeployPage.tsx`, `app/src/features/agents/experience/WebsitePreviewDialog.tsx`, `app/src/services/api.js`
Status: implemented on `claude/admin-redesign`. Sections 1 to 6 are the review and research that led to the design; section 7 is what was built.

---

## 1. What the demo link does today

`GET /demo/{bot_key}` has two render paths:

| Path | Trigger | Output |
|---|---|---|
| Hero page | no `url` query param | `_build_demo_page_html`, a hand-written marketing page: "Try {bot} on a live page", three hint cards, gradient background, widget snippet |
| Iframe preview | `?url=<site>` and the site passes an embeddability probe | `_build_preview_page_html`, a dark toolbar over a full-height `<iframe src="{site}">` with the widget snippet on the outer page |

The iframe path already exists and does roughly what you asked for. The problem is that nothing in the product ever reaches it from the share link.

`getBotDemoUrl(botKey)` ([api.js:1990](../app/src/services/api.js#L1990)) returns `${API_BASE_URL}/demo/${botKey}` with no `url` parameter. Both the "Try it now" header button ([DeployPage.tsx:135](../app/src/features/agents/channels/DeployPage.tsx#L135)) and the "Share a link instead" card ([DeployPage.tsx:349](../app/src/features/agents/channels/DeployPage.tsx#L349)) use it. `bot.website` is read on the same page, three lines above, and is not passed. The only caller of `getBotPreviewUrl` (the variant that does pass a URL) is `WebsitePreviewDialog`, which is a modal inside Experience, not the shared link.

So the shipped behaviour is: the customer's site is known, the backend can render it, and the share link renders the fake page anyway.

## 2. Defects found

Ordered by what actually breaks the experience.

**D1. The share link never uses real-website mode.** As above. This is the reported bug and the cheapest part of the fix.

**D2. The embeddability probe rejects almost every real site.** `_check_iframe_allowed` returns `False` for any 3xx ([bot_routes.py:1526](../api/app/api/bot_routes.py#L1526)). Redirects are near universal: apex to www, http to https, trailing-slash normalisation. The comment acknowledges this and accepts it deliberately to avoid following a redirect into an internal address. The consequence is that even after D1 is fixed, the majority of customers still land on the hero page. The probe also uses HEAD, which a meaningful share of origins answer with 405 or with different headers than GET.

**D3. Framing fails for a large fraction of sites regardless of the probe.** HTTP Archive's 2024 Web Almanac puts `X-Frame-Options` on about 37% of sites, and CSP on 19% of hosts with roughly 56% of those setting `frame-ancestors`. Professional marketing sites, the exact population that buys this product, skew higher than the average. An iframe-first demo is a coin flip in front of a prospect.

**D4. Even a successful iframe cannot host the widget.** Cross-origin framing means the widget script sits on our outer page, not inside the customer's document. The visitor sees the widget floating over their site, which is the right picture, but it is an overlay in both the iframe design and the screenshot design. The iframe buys live scrolling and costs reliability; it does not buy a more genuine widget.

**D5. Unauthenticated `?url=` turns our origin into a site-wrapping surface.** `/demo/{bot_key}?url=` is public, needs only a bot key (which is public by design and printed on the Deploy page), and renders arbitrary third-party HTML inside a frame on an oyechats.com URL under a toolbar that says "Powered by OyeChats". That is a ready-made phishing wrapper with our branding as the trust signal. The URL should be constrained to the bot's own website or its verified `allowed_domains`, not to "any public host that resolves".

**D6. The block-detection warning in the dashboard is wired to the wrong signal.** `WebsitePreviewDialog` decides whether to warn "your site may block being embedded" by waiting for an `oyechats:preview-ready` postMessage ([WebsitePreviewDialog.tsx:23](../app/src/features/agents/experience/WebsitePreviewDialog.tsx#L23)). That message is emitted by the widget ([ChatWidget.jsx:149](../widget/src/components/ChatWidget.jsx#L149)) when it mounts in preview mode. The widget lives on our demo page, so it mounts and reports ready whether or not the customer's site rendered inside the inner frame. The warning is close to unreachable, and the blank rectangle it was written to explain is exactly the case that still shows nothing.

**D7. Silent downgrade.** When the probe says "not embeddable", the route quietly serves the hero page ([bot_routes.py:1838](../api/app/api/bot_routes.py#L1838)). The customer never learns that their site refused, so they cannot act on it and cannot tell the two pages apart as intentional states.

**D8. The widget URL is hardcoded to production.** Both builders emit `https://cdn.oyechats.com/oyechats-widget.js` ([bot_routes.py:1466](../api/app/api/bot_routes.py#L1466), [1739](../api/app/api/bot_routes.py#L1739)) while the Deploy page snippet on the same screen resolves per environment (localhost:4173 in dev). Local and staging demos exercise the production widget. This belongs in config alongside the other environment-dependent URLs.

## 3. How LiveChat actually does it

Confirmed at code level, not inferred.

LiveChat's "Customize widget on website" lives in the app under Settings, Chat widget, Customization. Two paths:

1. **Snippet already installed on that domain.** Open the real site with `cw_configurator=true` appended. The installed widget enters live-edit mode on the customer's own page. Highest possible fidelity, and it requires the install.
2. **Snippet not installed.** The bundle string reads "LiveChat is not installed on that website. You can still preview how the widget would look on it." It opens `https://cdn.livechatinc.com/widget/configurator-preview.html?license={id}&url={site}`.

That preview page loads `configurator-preview.cbXHs3xh.js`, which calls:

```
https://api.apiflash.com/v1/urltoimage?url=...&scale_factor=2&response_type=json&width=1400&height=<viewport>&access_key=...
```

ApiFlash returns a hosted image URL. The page renders it as a plain `<img>` at `width:100%`, draws a 36px fake browser bar above it, and boots the real widget on top via the normal snippet with `sessionStorage.cw_configurator = true`. Grepping that file for `iframe` returns zero matches. There is no iframe and no proxy anywhere in the flow.

Three details worth copying or improving on:

- They capture at viewport height, not full page, so their preview does not scroll. A full-page capture beats it.
- They ship the ApiFlash access key in client JavaScript. Calling the capture server-side is strictly better.
- The page is login-gated (opening it without a session returns 401 and redirects to accounts.livechat.com), so it is an in-product tool, not a shareable link. A public share URL beats it.

The same `configurator-preview.html` is reused across Text, Inc. products (`cdn.openwidget.com` serves the identical script and the same key). Their shareable no-site surface is the separate Direct Chat Link at `direct.lc.chat`.

## 4. What everyone else does

None of Intercom, Tidio, Crisp, Chatbase, Drift, Zoho SalesIQ, HubSpot, Tawk.to, Landbot or Voiceflow ships a documented "widget on your real website" preview. The market splits into two patterns:

- **Mock preview panel in the settings UI**: Intercom, Crisp, Zoho SalesIQ, HubSpot, Tawk.to, Zendesk, Drift. The widget renders against a stylised background, never the customer's site.
- **Vendor-hosted standalone chat page, shareable by URL**: Crisp (`go.crisp.chat/chat/embed/?website_id=`), Tawk.to Direct Chat Link and `tawk.to/{slug}` chat pages, Landbot (`chats.landbot.io/v3/...`), Voiceflow (`creator.voiceflow.com/prototype/{id}`), Botpress, Chatling, Wonderchat.

Chatbase is the cleanest reference for the second pattern: `www.chatbase.co/chatbot-iframe/{chatbotId}` is a real prerendered route that deliberately sends no `X-Frame-Options` and only a report-only CSP, so customers can frame it anywhere. Their own `embed.min.js` points its panel iframe at that same route.

Because nobody loads the customer's site, nobody has an `X-Frame-Options` fallback pattern to copy. HubSpot avoids the problem by only previewing on HubSpot-hosted pages, and documents testing on your real site with a query-param gate (`?test_chat=true`) after the snippet is installed, which is the same shape as LiveChat's path 1.

Read together with section 3: the screenshot-backed demo is close to white space. LiveChat has it and hides it behind login; nobody else has it at all.

## 5. Technique comparison

| | Fidelity | Reliability | Cost | Effort | Risk |
|---|---|---|---|---|---|
| Iframe the real site | Live and scrollable when it works; widget is an overlay either way | Poor. About 40% of sites block framing, worse among professional sites, and our own probe rejects every redirect on top of that | Free | Already built | Site-wrapping abuse under our domain (D5) |
| Screenshot background plus the real live widget | Static page image, real interactive widget, scrollable if captured full-page | Near total. Headless capture is not subject to `X-Frame-Options` or CSP | Roughly $0.001 to $0.01 per capture, or effectively free through vendors we already pay for | Low to medium | Minimal. Screenshot-for-preview is standard practice |
| Server-side proxy and mirror | Theoretically live, breaks badly on JavaScript-heavy sites | Medium to poor, unpredictable | Bandwidth plus engineering | High: URL rewriting, asset proxying, sandboxing | High: SSRF, open-proxy abuse, third-party scripts executing on our origin, trademark exposure |

The proxy option is out. We already had to fix an SSRF in `check_urls_alive`, and a fetch-and-reserve endpoint reopens that class of bug while adding open-proxy abuse and executing customer third-party scripts on our own origin.

## 6. Capture vendors

We do not need a new vendor. Both crawl providers already in the stack can produce screenshots.

**Jina Reader** (already integrated in `jina_service.py`): add one header to a Reader call.
- `X-Respond-With: screenshot` returns a hosted screenshot of the viewport.
- `X-Respond-With: pageshot` attempts a full-page capture. This is the one we want.
- Pair with `x-respond-timing: media-idle` so images and fonts settle before capture.
- Reader caches; `x-no-cache` and `x-cache-tolerance` control it. Billed as tokens on the existing key.
- Returns a URL, so we can store the bytes ourselves or reference it.

**Spider.cloud** (already integrated in `spider_service.py`): a separate `POST /screenshot` endpoint, not a `return_format` flag. Takes `full_page`, `omit_background`, `output`. Returns image bytes directly, which we would upload through the existing `upload_to_r2` helper in [r2_service.py:361](../api/app/services/r2_service.py#L361) and serve from `cdn.oyechats.com`.

For reference if we ever need a dedicated vendor: ApiFlash ($7/mo for 1,000, what LiveChat uses), ScreenshotOne ($17/mo for 2,000, signed URLs, can block chat widgets in the capture, which matters if the customer already runs a competitor's widget), Urlbox ($19/mo for 2,000, 30-day render-link cache), Microlink ($49/mo for about 46,000, cheapest per unit).

Latency is the reason this must not happen at view time. A cold full-page capture of a JavaScript-heavy homepage takes several seconds. LiveChat ships a gradient skeleton for exactly this wait.

## 7. Proposed design

**Capture once, at train time. Serve a static page at view time.**

We already crawl the customer's homepage during onboarding and on retrain. Take the screenshot in that same pass, store it on R2 keyed by bot, and the demo page becomes an image plus a script tag with no third-party call in the request path.

### Backend

1. New nullable columns on `Bot`: `demo_screenshot_url`, `demo_screenshot_captured_at`, `demo_screenshot_source_url`, `demo_screenshot_status`.
2. New ARQ task `capture_demo_screenshot(bot_id)`. Calls Spider `POST /screenshot` with `full_page: true` (or Jina `pageshot`), uploads through `upload_to_r2`, writes the four columns. Enqueued from the crawl pipeline on completion, and on demand from the dashboard. Idempotent, with a TTL so a capture older than about 30 days refreshes on next train.
3. Replace `_build_demo_page_html` with a page that renders, in order: light fake browser chrome showing the customer's own domain, the screenshot as a full-width scrollable image, and the real widget snippet, with a small badge saying this is a preview of the site rather than the live site.
4. Keep the hero page as the third fallback only, for a bot with no website and no capture. Give it honest copy about what it is.
5. Constrain `?url=` to the bot's own website or its `allowed_domains` (D5), and return 400 rather than silently downgrading (D7).
6. Move the widget script URL into config (D8).
7. Decide on the iframe path. Recommendation: keep it behind an explicit `mode=live` parameter for the in-dashboard dialog, where a blank frame is recoverable, and never use it for the shared link. Relax the redirect rejection there by resolving the redirect target through `validate_public_url` and probing the final hop, rather than treating all 3xx as hostile (D2).

### Frontend

8. `getBotDemoUrl` gains the website so the share link and "Try it now" both open the real-site demo (D1).
9. The "Share a link instead" card states what the recipient will see, and offers a recapture control when the screenshot is stale or missing.
10. `WebsitePreviewDialog` stops inferring blocking from `oyechats:preview-ready`. The demo page itself should report the inner frame's state to the parent, or the dialog should read a status the backend already knows (D6).

### Ordering

- **Phase 1, one day.** D1, D7, D8, and the `?url=` constraint from D5. Ships the existing iframe path to the share link with honest fallbacks and closes the abuse vector. Immediate visible improvement, no new infrastructure.
- **Phase 2, two to three days.** The capture task, the columns, the screenshot demo page. This is the LiveChat-parity change and the one that makes the demo work for every customer rather than the minority whose site allows framing.
- **Phase 3, one day.** Dialog signal fix (D6), the probe relaxation (D2), recapture control, staleness handling.

### What we would ship that LiveChat does not

Full-page scrollable capture instead of viewport-only, the capture called server-side instead of an API key in client JavaScript, and a genuinely public shareable URL instead of a login-gated in-product tool.

## 8. What live testing changed

Sections 1 to 7 were written from code review and vendor research. Everything below was then verified against the live APIs, and three of the research-derived assumptions turned out to be wrong. Recording them because each one would have shipped as a bug.

**Spider's payload was wrong.** `POST /screenshot` deserializes `viewport` into a struct with no optional members, so it rejects field by field: "missing field `emulating_mobile`", then "missing field `is_landscape`". All six of `width`, `height`, `device_scale_factor`, `emulating_mobile`, `is_landscape`, `has_touch` must be present. Every Spider capture would have returned 400.

**A 2xx from Spider is not success.** Target-side failures arrive inside a 200 body, e.g. `[{"status": 504, "error": "Error getting website url."}]`. Without a check for that, a failed render reached the magic-number test and surfaced as a generic "non-image body" instead of the real reason. `_spider_upstream_error` now extracts the vendor's own message and status.

**Spider's screenshot route is inert on this account.** It returns HTTP 200 with `{"error": "screenshot route produced no image bytes on this backend"}` and populated `compute_cost`, so it bills for the attempt. Reproduced on example.com and python.org, `full_page` both true and false. Their `/scrape` route is healthy, so this is specific to the screenshot backend. That inverted the section 6 recommendation: **Jina is primary, Spider is the fallback, and the fallback is currently inert.**

**Jina's response shape held.** `X-Respond-With: pageshot` with `Accept: application/json` returns 200 with `data.pageshotUrl`, as assumed. Without an `Accept` header the same call 302s to the storage object, so the shape is content-negotiated rather than fixed; our path sends the header. Verified end to end: capture, R2 upload, public CDN fetch, byte-identical round trip.

### The scroll-reveal limitation

The one finding that is a product decision rather than a bug. Two different causes produce the same symptom, a blank band:

| Cause | Fixed by waiting? | Evidence |
|---|---|---|
| Lazily loaded media | Yes | fynix.digital's "Trusted by" logo grid: blank at default settling, fully painted at 30s |
| Sections revealed on scroll | **No** | oyechats.com and fynix.digital: blank at both settings, across fresh uncached renders |

A full-page capture extends the document to its full height but never scrolls through it, so IntersectionObserver-driven reveals never fire and their content stays at opacity 0 no matter how long the renderer waits. `DEMO_SCREENSHOT_WAIT_SECONDS` addresses the first row only.

One render of oyechats.com did come back complete, which briefly looked like the wait having fixed it. Forcing fresh uncached renders showed it was a cached artifact. Worth recording as a caution: a single passing sample is not evidence when the vendor caches.

Fixing the second row needs a renderer that scrolls before capturing, which neither Reader nor Spider exposes.

## 9. Recommended next step: Cloudflare Browser Rendering

Considered self-hosting Chromium and rejected it. Production is **4 GB / 2 vCPU with 2 GB swap** (verified: `free -h` 3.8 GiB, `nproc` 2), currently 2.1 GB used with 1.7 GB available, shared by the API at ~962 MB, the ARQ worker at ~331 MB, Postgres, nginx and Redis. A full-page Chromium render of a 7,595px page peaks around 600 MB to 1 GB. It would fit if serialized, but the failure mode lands on live customers: the OOM killer targets the largest process, which is a Gunicorn worker, and a 30 to 45 second render pegs one of two cores. This repo also already migrated off local Chromium on purpose (`spider_service.py`: "no local Chromium. That is the whole point of the migration").

Cloudflare Browser Rendering is the version of "build our own" that fits:

- Already on Cloudflare for R2 and `cdn.oyechats.com`.
- The REST API supports `addScriptTag`, so the scroll-and-reveal script that fixes the blank bands can be injected from Python in one HTTP call, in the same shape as the two providers already wired up. No Worker deployment required.
- Workers Paid ($5/mo) includes 10 browser-hours per month, roughly 800 to 1,200 captures at our 30 to 45 second duration, then $0.09 per additional browser-hour. Cheaper than ScreenshotOne ($17/mo for 2,000) and Urlbox ($19/mo for 2,000).
- Nothing runs on the droplet.

A separate 2 GB container to isolate Chromium would cost about $12/mo, more than Cloudflare, while adding permanent ownership of Chromium upgrades, font packages, zombie processes and anti-bot handling. At roughly one capture per bot per 30 days, that trade is clearly bad.

Requires `CLOUDFLARE_ACCOUNT_ID` and a token with Browser Rendering permission. The Workers Free tier (10 minutes/day, 60s browser timeout) is too tight for 30 second captures at any volume.

## 10. Open questions

- Whether to add Cloudflare Browser Rendering as a third provider (section 9). This is the only path that fixes the scroll-reveal blank bands.
- Whether to raise the inert Spider screenshot backend with their support, or drop Spider from the capture chain and keep it for crawling only.
- Whether to capture the homepage only, or let the customer pick the page.
- Whether a competitor's chat widget visible in the customer's screenshot is acceptable. fynix.digital already shows one. ScreenshotOne has `block_chats`; Cloudflare's `addScriptTag` could hide it by selector; Reader and Spider offer nothing.
