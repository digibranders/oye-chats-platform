# Derived chat avatar — design

**Date:** 2026-08-10
**Status:** Approved — amended after CTO review, ready to implement
**Branch:** `development`
**Plan:** `docs/superpowers/plans/2026-08-10-derived-chat-avatar.md`

**Revision history**

| Rev | Change |
|---|---|
| 1 | Initial design |
| 2 | CTO review amendments — §3 (no byte-fetch helper exists), §4.1 (timeout semantics), §5.2 (`fetch_bytes_safely`), §5.5 (candidate budget), §6.1 (downgrade + `alembic check`), §6.2 (executor offload), §7.3c (second write path), §8 (rate-limit form, impersonation, source-URL divergence), §11.1 (response-field enumeration), §13 (`app/core/ssrf.py`) |

---

## 1. Problem

A customer pastes their website URL and we crawl it to train the agent. At the end
of that flow the widget still wears the generic robot mascot until the customer
finds the avatar picker and uploads an image. That is one more setup step between
signup and a widget that looks like *their* product.

We already fetch their homepage during every crawl. The brand mark is sitting in
that markup. Derive the avatar instead of asking for it.

**Success:** a customer who crawls a site carrying an `apple-touch-icon` sees their
own brand mark as the agent's avatar without touching the avatar picker, and a
customer who has ever chosen an avatar never sees it change.

---

## 2. The hard requirement

This sets a **default, never an override**.

An avatar the customer deliberately chose being replaced by a crawl is a support
ticket and a trust problem. The chat avatar is the single most visible pixel of the
widget; changing it silently is worse than never deriving it at all.

Everything below is subordinate to that.

---

## 3. Verified starting facts

Each finding was checked against the code before designing on top of it.

| Claim | Verdict |
|---|---|
| `crawl_orchestrator.py` imports and calls `fetch_recommended_colors` during every crawl | ✅ import at `:39`, call at `:566` |
| Pillow available | ✅ `Pillow>=10.0.0` in `api/pyproject.toml:36` |
| BeautifulSoup available | ✅ `beautifulsoup4>=4.14.3` at `:44` |
| An SSRF guard exists and is reused by `check_urls_alive` | ✅ `app/core/ssrf.py` — `validate_public_url`, `fetch_text_safely`, `probe_url_alive`, DNS-pinned against rebinding (AR-42) |
| That guard can fetch **binary** bodies | ❌ **Rev 2** — `fetch_text_safely` is the only body-reading helper and it returns `str` via `.decode("utf-8", errors="replace")` (`ssrf.py:289`). Image bytes routed through it are irreversibly corrupted (every non-UTF-8 sequence → U+FFFD) and Pillow then rejects them. A new `fetch_bytes_safely` is required — see §5.2 |
| Storage service is `b2_service.py` | ❌ **Corrected** — the module is `app/services/r2_service.py`. `upload_to_b2` survives only as a back-compat alias (`r2_service.py:284`) |
| The homepage HTML is in memory at the orchestrator's insertion point | ❌ **Corrected** — `fetch_recommended_colors(url)` fetches internally and returns `list[str]`. The HTML never leaves the function, and the call only fires when `recommended_colors` is empty |
| `avatar_type` can carry provenance (`"derived"`) | ❌ **Corrected** — it is a *style selector*, see §6 |

Two things the codebase already provides that this design leans on:

* **`process_image_for_logo()`** (`r2_service.py:67`) — Pillow square-centre-crop →
  512×512 PNG. Exactly the normalisation step required.
* **`upload_to_r2()`** (`r2_service.py:251`) — returns the R2 **object key**
  (`logos/<uuid>.png`). `bot_logo` stores keys; routes absolutise to
  `/files/{key}` (`main.py:693`, `bot_routes.py:553-559`). Copying to R2 rather
  than hotlinking is therefore the existing path, not new work.

---

## 4. Where derivation runs

A new best-effort task launched **beside** `harvest_footer_media`, not chained onto
the colour extractor.

```python
# crawl_orchestrator.run_full_crawl, ~line 489
footer_task = asyncio.create_task(harvest_footer_media(url))
icon_task   = asyncio.create_task(derive_site_icon(url))     # new
```

Awaited with `asyncio.wait_for(..., timeout=20.0)` immediately before the metadata
persist block; cancelled and suppressed in the existing `finally`. `harvest_footer_media`
(`crawl_orchestrator.py:488-490, 528-555, 965-971`) is the working precedent for a
bounded, silent, cancel-safe side task inside the crawl — this mirrors it.

**Gate:** `bot_id is not None and not ordered_urls and SITE_ICON_DERIVATION_ENABLED`.
An ordered-URL crawl is a partial re-scrape of an explicit page list, not a
"train me from my website" moment.

### 4.1 The caller-side timeout is a backstop, not the budget

The task is created at ~`:489` and awaited at ~`:770`. `asyncio.wait_for` measures
from the **await**, not from task creation — so on a ten-minute crawl a hung fetch
gets ten minutes *plus* twenty seconds of wall clock, not twenty seconds.

That is harmless (the `finally` block cancels it either way, and nothing downstream
waits on it), but it means the real bound has to live **inside** `derive_site_icon`
as a wall-clock budget — see §5.5. The outer `wait_for(20.0)` stays as a backstop
against a task that somehow ignores its own budget.

`harvest_footer_media` has the same shape and gets away with it because it is
log-only. This task writes to the database, so it is bounded properly.

### Why not reuse the colour extractor's fetch

Rejected. `fetch_recommended_colors` would need its signature widened to return the
HTML, which:

* couples two features with nothing in common beyond a URL — a colour-fetch failure
  would become an avatar failure and vice versa;
* only runs when `recommended_colors` is empty, so the coupling is conditional and
  therefore surprising;
* saves one HTTP GET that overlaps a multi-minute crawl, i.e. ≈0 wall-clock.

The independent task costs one extra GET of a page we are already crawling and has
zero blast radius. `brand_color_extractor.py` is not modified.

---

## 5. New module — `api/app/services/site_icon_extractor.py`

New file; no overlap with the concurrent company-intelligence work
(`company_profile_service.py`, `company_markup.py`, `domain_normalizer.py`,
`spider_service.py`, `llm_service.py`).

Three layers, so the interesting logic is testable without network or object storage:

| Function | I/O | Responsibility |
|---|---|---|
| `select_icon_candidates(html: str, base_url: str) -> list[IconCandidate]` | pure | parse markup, rank candidates |
| `fetch_icon_bytes(url: str) -> bytes \| None` | network | SSRF-safe fetch, byte cap, Pillow validation, normalisation |
| `derive_site_icon(page_url: str) -> str \| None` | network + R2 | orchestrate; return the R2 object key |

`IconCandidate` is a frozen dataclass: `url: str`, `tier: int`, `declared_size: int`,
`order: int`.

### 5.1 Preference cascade

Ranked by tier, then by largest declared size, then document order.

| Tier | Source | Rationale |
|---|---|---|
| **A** | `<link rel="apple-touch-icon">` / `apple-touch-icon-precomposed` | 180×180, square, purpose-built, and it *is* the brand mark. Undeclared `sizes` → assume 180 |
| **B** | `<link rel="manifest">` → `icons[]` with `sizes ≥ 96`, PNG, `purpose != "monochrome"` | Where modern sites actually keep the 512px mark. One extra 64 KiB fetch |
| **C** | `<link rel="icon">` / `shortcut icon` with declared `sizes ≥ 96` | Often the PWA PNG when no manifest is linked |
| **D** | `<link rel="icon">` with no or small declared size | Weak signal; usually filtered out by the 64px floor in §5.3 |
| **E** | `/favicon.ico` at the origin root | Last resort. Passes only when the site ships a ≥64px `.ico` |

**Deliberately excluded:**

* **`og:image`** — typically a 1200×630 banner. Centre-cropping that into a circle
  produces a fragment of a marketing image. Note that
  `company_markup.extract_logo()` *does* read `og:image` — that is a *company logo*
  for visitor intelligence, a different job with no circular-crop constraint. It is
  not reused here and is not modified.
* **`msapplication-TileImage`** — square, but commonly a bled brand tile designed to
  sit inside Windows chrome. Marginal value, extra surface.

### 5.2 URL-level rejection

Applied after `urljoin` against the *final* (post-redirect) document URL:

* scheme not in `{http, https}` — kills `data:`, `javascript:`, `blob:`, `mailto:`
* URL longer than 500 characters (matches `company_markup._MAX_URL_LEN`)
* `.svg` extension or `type="image/svg+xml"` — **SVG is script-bearing and is never
  fetched, decoded, or stored**
* `app.core.ssrf.validate_public_url`, connecting through the existing DNS-pinned
  resolver so every redirect hop is re-validated (closes the rebinding TOCTOU
  window, AR-42)

The icon URL comes from a third-party page and is therefore attacker-influenceable.
The SSRF guard is not optional here.

**New shared helper — `app.core.ssrf.fetch_bytes_safely()`.** The existing
`fetch_text_safely` cannot be used: it returns `str` via
`.decode("utf-8", errors="replace")`, which destroys image data before Pillow ever
sees it. The new helper is a byte-preserving sibling — same redirect
re-validation, same `_PinnedResolver`, same `iter_chunked` cap — returning
`tuple[int, bytes] | None`. Both functions share the per-hop validate/pin/connect
logic, which is extracted rather than duplicated.

This lands in `app/core/ssrf.py`, a shared module. It is additive (no signature or
behaviour change to `fetch_text_safely` or `probe_url_alive`), and the file is not
owned by the concurrent company-intelligence work.

### 5.3 Byte-level rejection

* **1 MiB cap**, enforced while streaming — not from `Content-Length`, which the
  origin controls.
* `Content-Type` is a cheap pre-filter only. The real gate is Pillow:
  * `Image.open()` → `verify()` → **reopen** (Pillow requires a reopen after verify)
  * format ∈ `{PNG, JPEG, WEBP, ICO, GIF}`
  * both dimensions in `[64, 4096]`
  * `width * height` capped to reject decompression bombs
  * animated GIF/WEBP → frame 0
* **Aspect ratio outside `[0.8, 1.25]` → skip this candidate, try the next tier.**

The aspect-ratio gate is what makes excluding `og:image` a *principle* rather than a
preference, and it is why `process_image_for_logo`'s centre-crop is safe here: every
candidate that reaches it is already square-ish.

**The 64px floor is load-bearing.** A 32×32 `favicon.ico` fails it and nothing is
derived. That is the correct outcome — the entire premise is that a 16–32px favicon
upscales blurry against a 40px CSS / 80px retina avatar. A source that cannot beat
the generic mascot should not replace it.

### 5.4 Normalisation and storage

`process_image_for_logo(bytes)` → 512×512 PNG → `upload_to_r2()` → R2 key. Both
already exist and are already the path uploaded logos take. Nothing new. The image
is **copied to R2, never hotlinked** — hotlinking would put a request on the
customer's origin for every widget load and break the day they reorganise assets.

512×512 is retained (rather than a smaller derived-specific size) so a derived asset
is byte-for-byte interchangeable with an uploaded one; every downstream consumer
stays unchanged.

### 5.5 Work budget

Aspect ratio and true dimensions are only knowable after a candidate is decoded, so
§5.3 rejections imply *trying the next candidate*. With five tiers and several
`<link>` elements per tier, that is an open-ended fetch loop pointed at a
third-party origin. Hard bounds:

| Bound | Value |
|---|---|
| Document fetch (homepage) | 1, 10s timeout, 2 MiB cap |
| Manifest fetch | ≤1, 5s timeout, 64 KiB cap |
| Candidate image fetches | **≤3 attempts total**, 5s timeout each, 1 MiB cap each |
| Total wall clock inside `derive_site_icon` | **15s**, enforced internally |

Three attempts is enough to walk past a broken top-tier URL and a wrong-aspect
second choice without turning a crawl into a scraper. On exhausting the budget the
function returns `None` — indistinguishable, from every caller's perspective, from
"this site has no usable icon".

### 5.6 Nothing blocking runs on the event loop

`derive_site_icon` is a coroutine running on the same loop as the streaming-ingest
consumer and the crawl heartbeat — the heartbeat being what stops a long crawl from
being falsely reaped. Two of its steps are synchronous and must not run inline:

* `process_image_for_logo` — Pillow LANCZOS resize on an image up to 4096²
* `upload_to_r2` — a blocking boto3 `put_object`

Both go through `loop.run_in_executor(None, ...)`, matching what the orchestrator
already does for `batch_web_ingestion` (`crawl_orchestrator.py:655`).

---

## 6. Provenance: `avatar_type` is not touched

`avatar_type ∈ {upload, orb, mascot}` is a **style selector**, not provenance:

* `widget/src/components/BotAvatar.jsx:15` branches on it to pick orb / mascot /
  image rendering;
* `app/src/features/launch-studio/customize/AvatarPicker.tsx:65-69` renders it as a
  three-tab segmented control — a fourth value shows *no* tab selected;
* `app/src/features/agents/experience/types.ts:153` coerces unknown values back to
  `'upload'` via `asAvatarType()`, so the next settings save would **silently destroy
  the provenance**.

Adding `avatar_type = "derived"` would appear to work (the widget's fall-through
branch still renders `bot_logo`) and then quietly break on the customer's first save.

**Decision:** one new column.

```python
# api/app/db/models.py — Bot
bot_logo_source = Column(String, nullable=True)
# NULL      -> uploaded by the customer, or unknown/legacy
# 'derived' -> auto-derived from the customer's website
```

The widget requires **zero changes**. That is the dividend of not overloading
`avatar_type`.

### 6.1 Migration must be reversible — CI enforces it

Single `add_column`, nullable, no server default → no table rewrite, no backfill.
Existing rows read as NULL, which is correct: every avatar that exists today was
uploaded.

`.github/workflows/ci.yml:74-77` runs:

```
alembic upgrade head && alembic check && alembic downgrade -1 && alembic upgrade head
```

Two consequences the migration must satisfy or CI fails:

1. **`downgrade()` must actually drop the column.** An empty or `pass` downgrade
   breaks the `downgrade -1` → `upgrade head` round trip.
2. **`alembic check` must report no diff** — the model and the migration have to
   agree exactly (same column name, type, and nullability).

---

## 7. State machine

### 7.1 The rule

> **Derive only when the slot is empty — checked inside the persist transaction.**

Chosen over "derive once at first crawl, never again" and over "re-derive on every
crawl unless locked".

* It gives the strongest possible form of the §2 requirement: a visible avatar —
  uploaded *or* derived — is never silently changed. Ever.
* It is strictly better than once-at-first-crawl: a site that had no
  `apple-touch-icon` on day one and added one later still gets an avatar, and
  clearing the avatar becomes a natural, discoverable re-derive gesture.
* It rejects re-derive-on-every-crawl. That policy is what `brand_tone` /
  `company_name` do today (`_apply_crawl_metadata_to_bot`, `crawl_orchestrator.py:177`),
  but those are text *inside* the agent. The avatar is the widget's face; a recrawl
  swapping it is alarming rather than helpful.
* It mirrors an existing house rule — `services_url` is auto-filled *only when empty*
  (`crawl_orchestrator.py:224`).

### 7.2 Transitions

| Event | `bot_logo` | `bot_logo_source` | Next crawl derives? |
|---|---|---|---|
| New bot | NULL | NULL | ✅ |
| Crawl derives | key | `'derived'` | ❌ slot full |
| Customer uploads | key | **NULL** | ❌ |
| Customer clicks Remove | NULL | NULL | ✅ |
| Customer uploads **then** removes | NULL | NULL | ✅ |
| Crawl derives nothing | unchanged | unchanged | ✅ still empty |
| Customer runs on-demand refresh (§8) | key | `'derived'` | ❌ slot full |

An explicit upload therefore stays frozen forever, and a derived avatar can be
refreshed — which is what the requirement asked for.

### 7.3 Two details that are easy to get wrong

**(a) The emptiness check happens at write time, not launch time.**

A crawl can run for ten minutes. A customer can upload an avatar during it. If the
guard is evaluated when the task is launched, that upload is stomped — precisely the
failure this design exists to prevent.

So: pre-check at launch (an optimisation — skip the fetch entirely when an avatar
already exists), then **re-check under the session immediately before writing**,
inside the same `get_session()` block as `_apply_crawl_metadata_to_bot`.

**(b) An upload must clear `bot_logo_source`.**

Any `bot_logo` value arriving from the customer that differs from the stored one
sets `bot_logo_source = None`. In `update_bot` this belongs where
`_reconcile_manual_overrides` already sits (`bot_routes.py:1787`, called at
`:1932`) — *before* the patch is applied, while the stored value is still readable.

Without it, an uploaded avatar inherits the "Taken from your website" caption.

**(c) `update_bot` is not the only write path.**

`PATCH /client/settings` (`client_routes.py:80`) also writes `bot_logo` /
`launcher_logo` directly onto the Bot, with its own `/files/` stripping and its own
logo mirroring, bypassing `update_bot` entirely (`client_routes.py:99-111`). The
frontend only falls back to it when no `botId` is available
(`app/src/services/api.js:1157`), and the Admin 2.0 Experience page is always
bot-scoped — but the route is live and reachable with any `X-API-Key`.

Blast radius is limited to a **stale caption**, not a stomped avatar: the freeze in
§7.1 keys off `bot_logo IS NULL`, which an upload through either path satisfies.
Still, the rule from (b) is mirrored into this handler so provenance cannot lie.
Both call sites use one shared helper rather than two copies of the rule.

### 7.4 `launcher_logo` moves with `bot_logo`

`bot_logo` and `launcher_logo` are kept in lockstep in both directions today
(`bot_routes.py:1873-1876`, `types.ts:198-199`). The derived write must set **both**,
guarded on **both** being NULL. Otherwise the chat header goes branded while the
floating launcher keeps the generic icon — visibly worse than doing nothing.

### 7.5 Accepted imperfection

The R2 upload happens before the guarded DB write, so a write rejected by the
race-recheck orphans one ~30 KB PNG in the bucket. Reordering does not remove the
race, only moves it. Logged at INFO, not chased.

---

## 8. On-demand refresh

```
POST /bots/{bot_id}/derive-avatar
```

* **Auth:** `get_current_client_or_operator` + `_require_bot_management_access` —
  identical to `update_bot`.
* **Impersonation:** carries `@impersonation_writable`. This is a branding edit,
  the same class `update_bot` already admits under its "it looks wrong" support
  rationale, and it touches nothing in billing, credentials, or the origin
  allowlist.
* **Rate limit:** `@limiter.limit("10/minute", key_func=key_from_api_key)`. The
  house form throughout `app/api/` is per-minute (`bot_routes.py:1195`, `:1676`,
  `:1752`), and the only key funcs that exist are `key_from_api_key` (per client)
  and `key_from_bot_key` (widget traffic only) — a per-bot hourly bucket would need
  a custom key func written for one route. Per-client-per-minute is the right
  trade: it bounds abuse without inventing limiter infrastructure.
* **Source URL:** `bot.website`, read from the database. **Never a URL from the
  request body.** This is what stops the endpoint becoming an SSRF probe / port
  scanner on top of the guard — the customer can only ever point it at a domain
  already stored on their own bot.
* **Overwrites unconditionally** (the customer explicitly asked), setting
  `bot_logo`, `launcher_logo`, and `bot_logo_source = 'derived'`.
* **Responses:** `200 {"bot_logo": <absolutised url>, "bot_logo_source": "derived"}`,
  or `422 {"message": "We couldn't find a usable icon on your website."}`

This is the **only** surface where failure is visible — because here the customer
asked a question and deserves an answer. It also fully covers the rebrand case
without any silent change, at the cost of one HTML fetch and one image fetch (no
crawl, no credits).

### 8.1 The two paths can read different URLs

Crawl-time derivation uses the crawl's `url` argument. On-demand refresh uses
`bot.website`, which is written once at bot creation (`bot_routes.py:1422`) and
never updated by a crawl. A customer who registers `example.com` and then crawls
`docs.example.com` gets the icon from the second and the refresh from the first.

Accepted, not fixed. Making the crawl overwrite `bot.website` would change a
customer-entered field as a crawl side effect — the exact class of behaviour §2
exists to prevent. The refresh button correctly hides when `bot.website` is unset
(a bot trained only from document uploads), and the divergence is invisible to the
overwhelming majority of customers, who register and crawl the same domain.

---

## 9. Failure is silent and bounded

Inside the crawl, every failure mode collapses to *"avatar unchanged"*:

* timeout (20s), no candidates, every candidate rejected, SSRF reject, Pillow
  reject, R2 error, DB race lost.

No retry. No queue. No error surfaced to the customer. No effect on crawl status,
`last_crawl_status`, credits, or the result payload. One log line at INFO with the
reason.

Many sites have no `apple-touch-icon`; deriving nothing is the **expected** outcome,
not an error. The crawl is already the customer's slowest path, so the extra work is
capped at a single 20-second wait that overlaps existing multi-minute phases.

`SITE_ICON_DERIVATION_ENABLED` (default `true`) in `app/config.py` is the kill
switch, matching `CRAWL_STREAM_INGEST_ENABLED` / `RELEVANCE_GATE_ENABLED`.

---

## 10. Plan gating: none

Available on every plan, including Free.

The cost is one HTTP fetch inside a crawl the customer already paid for. A Free-tier
widget that looks like the customer's brand from minute one is acquisition value, so
gating a setup-friction reducer works against the funnel. No slug list, no
`get_bot_entitlements` call, no upgrade affordance.

(`plan_entitlements_service.py` and its per-bot resolvers are untouched. Recorded
here so the omission reads as a decision rather than an oversight.)

---

## 11. Admin UI

Under the Admin Platform 2.0 mandate, **Agent → Experience** answers *"What will
visitors see?"* — this is its only correct home. It is already built:
`features/agents/experience/BrandingSection.tsx` → `AvatarPicker`.

* **`AvatarPicker`** takes a new optional `logoSource?: 'derived' | null`. When
  `'derived'`, a caption renders under the preview: *"Taken from your website"*.
  The existing **Replace** and **Remove** controls are unchanged — the
  see / replace / clear requirement is already satisfied by components that exist.
* **New "Use my website's icon" button** in the `upload` panel, shown when
  `bot.website` is set. A confirmation dialog appears when it would replace a
  customer-uploaded image (`bot_logo` set and `bot_logo_source` NULL).
* **`ExperienceDraft`** gains `botLogoSource`, read-only. It is mapped in
  `fromApi` but **not** included in `toPayload()` — the field is server-owned, and
  `update_bot` ignores it if sent.
* **Launch Studio → Customize** shares the same picker, so it inherits the
  "we already did this for you" moment for free. No new step, no new screen.

No new page, no new navigation entry, no change to the IA.

### 11.1 Which API payloads carry `bot_logo_source`

The Bot is serialised in four places with different audiences. The field belongs in
exactly three:

| Payload | Location | Carries it? |
|---|---|---|
| `BotSettingsResponse` (the Experience page's read) | `bot_routes.py:341` model, `:431` construction | ✅ |
| Bot detail dict | `bot_routes.py:621` | ✅ |
| Bot list | `bot_routes.py:1298` | ✅ |
| **Widget settings** | `auth.py:886-896` | ❌ **never** |

The widget renders the avatar from `bot_logo` and `avatar_type` alone
(`BotAvatar.jsx`). Provenance is an admin-facing fact about *where the file came
from*; shipping it to every visitor's browser leaks a detail about the customer's
setup for no rendering benefit.

`bot_logo_source` is server-owned in both directions: it is mapped in `fromApi` but
omitted from `toPayload()`, and `update_bot` ignores it if a client sends it anyway.

---

## 12. Testing

**Pure selection** (HTML fixtures, no network):
tier ordering; largest declared `sizes` wins within a tier; SVG rejected by
extension and by `type`; `data:` / `javascript:` rejected; `og:image` never selected;
manifest tier parsed and ranked; malformed manifest JSON tolerated.

**Validation** (byte fixtures): non-image bytes; over 1 MiB; 16×16 rejected by the
floor; 1200×630 rejected on aspect; animated GIF yields frame 0; oversized
dimensions rejected.

**Budget** (§5.5): stops after 3 failed candidate fetches even when more candidates
remain; a slow origin trips the 15s internal budget and returns `None`.

**SSRF:** `http://169.254.169.254/latest/meta-data/` rejected; public URL redirecting
to a private address rejected at the hop. **`fetch_bytes_safely` specifically:**
returns bytes unmodified for a PNG fixture (the regression `fetch_text_safely` would
cause — assert the returned bytes still decode as a valid image); honours the
`max_bytes` cap mid-stream; re-validates each redirect hop.

**Orchestrator:** derives when `bot_logo` is NULL; does **not** when it is set;
does **not** when it is set mid-crawl (the §7.3a race); sets `launcher_logo` too;
crawl still returns `done` when derivation raises, times out, or returns None.

**Source clearing:** `bot_logo_source` cleared when a new logo is uploaded; both
fields cleared on remove; unrelated patches leave `bot_logo_source` alone.
Parametrised across **both** write paths — `PATCH /bots/{id}` and
`PATCH /client/settings` (§7.3c) — so the shared helper is proven on each.

**Serialisation** (§11.1): `bot_logo_source` present in the three admin payloads,
**absent** from the widget settings payload; a client that sends it in a
`PATCH /bots/{id}` body cannot set it.

**Route:** 200 shape; 422 when nothing derivable; 404/403 for a bot outside the
workspace; rate limit enforced; a request body URL is ignored in favour of
`bot.website`.

---

## 13. Files touched

| File | Change |
|---|---|
| `api/app/core/ssrf.py` | **`fetch_bytes_safely()`** — additive; shared per-hop validate/pin/connect logic extracted (§5.2) |
| `api/app/services/site_icon_extractor.py` | **new** |
| `api/app/services/crawl_orchestrator.py` | launch / bounded await / teardown; guarded write |
| `api/app/db/models.py` | `Bot.bot_logo_source` |
| `api/alembic/versions/*` | **new** — one nullable add_column **with a real `downgrade()`** (§6.1) |
| `api/app/api/bot_routes.py` | source-clearing rule; `POST /{bot_id}/derive-avatar`; response fields ×3 (§11.1) |
| `api/app/api/client_routes.py` | mirror the source-clearing rule into the legacy settings patch (§7.3c) |
| `api/app/config.py` | `SITE_ICON_DERIVATION_ENABLED` |
| `api/tests/test_ssrf.py` | `fetch_bytes_safely` cases |
| `api/tests/test_site_icon_extractor.py` | **new** |
| `api/tests/test_crawl_orchestrator_derived_avatar.py` | **new** |
| `app/src/features/launch-studio/customize/AvatarPicker.tsx` | `logoSource` caption; refresh button |
| `app/src/features/agents/experience/BrandingSection.tsx` | wire the new props |
| `app/src/features/agents/experience/types.ts` | `botLogoSource` (read-only) |
| `app/src/features/agents/experience/ExperiencePage.tsx` | refresh handler |

**Not touched:** `company_profile_service.py`, `company_markup.py`,
`domain_normalizer.py`, `spider_service.py`, `llm_service.py` (concurrent
company-intelligence work), `brand_color_extractor.py`, `r2_service.py`,
`plan_entitlements_service.py`, and the entire `widget/` app.

---

## 14. Accepted tradeoffs

Recorded so each reads as a decision rather than an oversight.

| # | Tradeoff | Why accepted |
|---|---|---|
| 1 | A write rejected by the §7.3a race-recheck orphans one ~30 KB PNG in R2 | Reordering moves the race, it does not remove it. Logged at INFO |
| 2 | Crawl-time and on-demand derivation can read different URLs (§8.1) | The alternative — a crawl overwriting the customer-entered `bot.website` — is the exact behaviour §2 forbids |
| 3 | A 32×32 `favicon.ico` derives nothing (§5.3) | A source that cannot beat the generic mascot should not replace it |
| 4 | Rate limit is per-client-per-minute, not per-bot-per-hour (§8) | Per-bot hourly needs a custom key func written for one route; the house pattern bounds abuse adequately |
| 5 | The legacy `PATCH /client/settings` path is patched rather than removed (§7.3c) | Removing a live, API-key-reachable route is out of scope for this feature |

## 15. Open items

None. The three decisions that were genuinely open — recrawl policy (§7.1), plan
gating (§10), and whether to ship an on-demand refresh (§8) — were resolved before
rev 1. The six items raised in CTO review are resolved in rev 2 and folded into the
sections above.
