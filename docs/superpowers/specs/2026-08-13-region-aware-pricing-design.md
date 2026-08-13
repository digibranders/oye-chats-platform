# Region-Aware Pricing in the Chat Widget — Design

- **Date:** 2026-08-13
- **Status:** Approved (design) — pending implementation plan
- **Scope:** Backend only (`api/`). No widget, admin, or knowledge-base changes.

## Problem

When a bot's knowledge base contains pricing in both INR and USD, the RAG
answer shows **both** currencies to every visitor, regardless of where they
are. We want an Indian visitor to see INR (₹) pricing and everyone else to
see USD ($) pricing — without re-crawling, duplicating documents, or tagging
chunks by region.

## Key insight

Region is a **query-time** property of the *visitor*, not an *ingestion-time*
property of the *crawler*. The crawler runs from one location and stores one
copy of the knowledge base, shared by all visitors. So the currency decision
must happen at the moment the visitor asks — based on where that visitor is —
and the knowledge base keeps **both** currencies untouched. The LLM filters to
the correct one at generation time.

## Approach (chosen)

**Universal, zero-config LLM directive driven by Cloudflare's `CF-IPCountry`
header.**

- `api.oyechats.com` is proxied through Cloudflare (verified: DNS resolves to
  Cloudflare ranges `104.21.11.179` / `172.67.192.96`; responses carry
  `server: cloudflare` and `cf-ray`). The backend already consumes Cloudflare
  headers — `chat_routes.py:270` reads `cf-connecting-ip`.
- Cloudflare can stamp `CF-IPCountry` (`IN`, `US`, `GB`, …) on every request,
  so the visitor's country is available **synchronously** on the same request
  that triggers the RAG answer. No widget change, no extra network call, no IP
  handling in our code.
- We thread the country into the system-prompt builder and inject one currency
  directive. The directive is written defensively so it is a **no-op** for
  bots that price in a single currency.

### Why not the existing IP→country geolocation

`_resolve_and_update_location` (`chat_routes.py`) already resolves country from
IP via ipwho.is / ipapi.co — but it runs in a **background thread after** the
response is produced, purely to stamp the session's `location`. It is too late
to influence the current answer, and making it synchronous would add
200–1000 ms of vendor latency to every chat turn. `CF-IPCountry` is free and
already present, so it is the correct signal.

### Rejected alternatives

- **Browser timezone in the widget** (`Asia/Kolkata`): viable and free, but
  requires widget changes and passing the value through the request body. Since
  the API is already behind Cloudflare, `CF-IPCountry` is server-side, more
  accurate, and needs zero widget work.
- **Per-bot `regional_pricing_enabled` toggle:** deferred (see Future scope).
  Adds a migration + admin UI for a feature the defensive directive already
  handles safely for every bot.

## Data flow

```
POST /chat  ·  POST /chat/stream            (chat_routes.py)
  request.headers.get("cf-ipcountry")  →  visitor_country (str|None)
        │
        ▼  new keyword arg
rag_pipeline(...)  ·  rag_pipeline_stream(...)   (rag_service.py:5342 / :6228)
        │
        ▼  new keyword arg
build_hybrid_prompt(...)                          (rag_service.py:3263)
        │
        ▼  conditional block appended to
hybrid_system_prompt  (f-string at rag_service.py:4482)
```

## Changes (all additive)

### 1. `api/app/api/chat_routes.py`

- In both `chat_endpoint` (`POST /chat`) and `chat_stream_endpoint`
  (`POST /chat/stream`), read the country header once:
  ```python
  visitor_country = (request.headers.get("cf-ipcountry") or "").strip().upper() or None
  ```
  Header names are case-insensitive in Starlette, so `"cf-ipcountry"` matches
  `CF-IPCountry`. Cloudflare uses `XX` for unknown and `T1` for Tor — both are
  simply "not IN", so they fall through to USD with no special handling.
- Pass `visitor_country=visitor_country` into the `rag_pipeline(...)` and
  `rag_pipeline_stream(...)` calls (the two existing call sites).
- **Runtime verification (temporary):** log the resolved header once per
  request at INFO so we can confirm in production logs that Cloudflare is
  actually sending it:
  ```python
  logger.info("visitor_country header | bot_id=%s | cf_ipcountry=%s", bot.id, visitor_country)
  ```
  This line is the acceptance check that the Cloudflare "IP Geolocation"
  toggle is enabled. If production logs show `cf_ipcountry=None` for real
  traffic, enable **Cloudflare → (zone) → Rules / Network → "Add visitor
  location headers" (IP Geolocation)** and re-verify. The log stays until the
  header is confirmed live, then is dropped to DEBUG.

### 2. `api/app/services/rag_service.py`

- Add `visitor_country: str | None = None` to the signatures of
  `rag_pipeline` (line 5342) and `rag_pipeline_stream` (line 6228), appended
  after `cta_dimension` so all existing positional/keyword calls stay valid.
- Forward it into the two `build_hybrid_prompt(...)` call sites
  (near lines 5808 and 6721).
- Add `visitor_country: str | None = None` to `build_hybrid_prompt`
  (line 3263), appended last for the same compatibility reason.
- Inject a currency directive into `hybrid_system_prompt`. Build a small
  string before the f-string and interpolate it as its own delimited section
  (matching the existing `═══`-bordered rule blocks), placed near the SCOPE /
  TODAY'S DATE section:

  ```python
  is_india = visitor_country == "IN"
  currency_directive = f"""
  ═══════════════════════════════════════════════════════
  PRICING & CURRENCY
  ═══════════════════════════════════════════════════════
  The visitor is located in {"India" if is_india else "a country outside India"}.
  When the reference information lists prices in more than one currency:
  - {"Show ONLY the Indian Rupee (INR, ₹) price." if is_india
     else "Show ONLY the US Dollar (USD, $) price."}
  - Do not mention the other currency or its amount unless the visitor
    explicitly asks to see it.
  If pricing is available in only one currency, present it exactly as written —
  never convert or invent an amount.
  """
  ```

  Notes:
  - The **"only one currency … present it exactly as written"** clause is what
    makes this safe to apply to every bot: single-currency bots are unaffected.
  - **Never convert or invent an amount** guards against the LLM fabricating a
    ₹→$ conversion when only one currency exists.
  - `visitor_country is None` (local dev, header disabled, non-Cloudflare
    path) evaluates `is_india = False` → USD, the correct default for the
    entire non-India world.

## Failure modes & defaults

| Situation | `visitor_country` | Result |
|---|---|---|
| Indian visitor, header present | `"IN"` | INR shown |
| Any non-India visitor | `"US"`, `"GB"`, … | USD shown |
| Header absent (toggle off / local dev / direct-to-origin) | `None` | USD (safe default) |
| Cloudflare "unknown"/Tor | `"XX"` / `"T1"` | USD (safe default) |
| VPN / traveler | country of exit node | Occasionally "wrong"; low-stakes, acceptable for v1 |

The design **fails safe to USD** in every ambiguous case — a non-Indian
visitor is never shown INR.

## Testing

- **Unit (`build_hybrid_prompt`):** assert the system prompt contains the INR
  directive when `visitor_country="IN"`, the USD directive when
  `visitor_country="US"`, and the USD directive when `visitor_country=None`.
- **Unit (header parsing):** a small helper (or inline) parses `CF-IPCountry`
  case-insensitively, upper-cases it, and maps empty/missing → `None`.
- **Manual/behavioral:** with a bot whose KB lists both ₹ and $ prices, send a
  pricing question with a spoofed `CF-IPCountry: IN` header and confirm only
  INR appears; repeat with `US` and with the header omitted and confirm USD.
  (Locally the header must be sent manually — Cloudflare is not in the loop on
  `localhost`.)

## Rollout

1. Ship the change with the temporary INFO log.
2. In production, confirm logs show real `cf_ipcountry` values (not `None`).
   If `None`, enable Cloudflare IP Geolocation and re-check.
3. Once confirmed, demote the log to DEBUG.

## Future scope (not in v1)

- **Per-bot currency configuration** (`regional_pricing_enabled` + a
  currency-by-country map on `Bot`): needed only when customers want
  currencies beyond INR/USD (EUR, GBP) or per-bot control. Would layer on top
  of this same threading path.
- **Widget currency toggle (₹/$):** a manual override for the VPN/traveler
  case. Small, additive, deferrable until asked for.
