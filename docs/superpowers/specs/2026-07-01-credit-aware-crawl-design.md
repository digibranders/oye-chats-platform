# Credit-Aware Crawl (Scan → Warn → Pick → Crawl) — Design

**Date:** 2026-07-01
**Status:** Approved (Approach 1 / v1b), ready for implementation plan

## Problem

Paid plans keep `max_crawl_pages = -1` (unlimited) — the real limit is **credits** (`url_scan` = 5 credits/page). Today a user clicks "Start Crawl" and *then* either gets silently capped (unlimited plan auto-limits to `balance ÷ 5`) or gets a hard `HTTP 402`. There is no informed, up-front warning. Goal: **before crawling, detect the site's page count, compare to what the user's credits can afford, and let the user pick how many pages to crawl (capped at affordable) and in what order.**

## Non-goals

- Changing plan limits (unlimited stays unlimited on paid tiers).
- Changing the credit cost (`url_scan` stays 5; tunable via `pricing_config`).
- Replacing the atomic per-page billing — it remains the final overspend safety net.

## Existing building blocks (reused, not rebuilt)

- `POST /crawl/discover` (`document_routes.py:502`) → returns `total_found` via `url_discovery.discover_website_urls`.
- Credit pre-flight in `POST /crawl` (`document_routes.py:~831`) → `cost_per_page = get_credit_cost("url_scan")`, `balance = get_balance`, unlimited plans auto-cap to `balance // cost_per_page`, else `HTTP 402 insufficient_credits`.
- `batch_web_ingestion` deducts `cost_per_page` **atomically per page**, stopping cleanly on insufficient credits.
- Frontend: `KnowledgeBase.jsx` (crawl UI), `CrawlContext.jsx` (crawl lifecycle), `getCurrentSubscription()` (plan limits).

## Approach: Approach 1 (capped recursive crawl) + small explicit-list extension for ordering

### Flow

```
URL → [Scan] → POST /crawl/discover
     ⇒ { total_pages, cost_per_page, balance, max_affordable_pages, credits_required_full, exceeds_balance, urls[] }
  → if exceeds_balance: open Estimate modal
       • count input/slider (capped at max_affordable_pages)
       • order radio: shallow | sitemap | discovered
       • live cost readout: count × cost_per_page
       • [Start Crawl (N)] [Top up] [Cancel]
     else: proceed straight to crawl (no modal friction, as today)
  → POST /crawl (max_pages = N, crawl_order = <choice>, [ordered_urls when order != shallow])
  → per-page atomic billing = final safety net (never overspends)
```

## Components

### C1 — `/crawl/discover` credit math (backend, additive)
Extend the response with fields derived from existing helpers:
- `cost_per_page` = `credit_service.get_credit_cost(db, "url_scan")`
- `balance` = `credit_service.get_balance(db, client_id)`
- `max_affordable_pages` = `balance // max(cost_per_page, 1)`
- `credits_required_full` = `total_found × cost_per_page`
- `exceeds_balance` = `credits_required_full > balance`

Existing `total_found` and `urls` stay. No breaking change to current callers.

### C2 — `crawl_order` on the crawl request (backend, additive)
Add `crawl_order: Literal["shallow","sitemap","discovered"] = "shallow"` to `CrawlRequest`. Thread through `POST /crawl → task_crawl_and_ingest → run_full_crawl → crawl_website`.
- `shallow`: recursive crawl from seed, capped at `max_pages` — the crawler's natural breadth-first order (no new fetch code).
- `sitemap` / `discovered`: use the explicit-list fetch (C3).

### C3 — Explicit ordered-URL fetch (backend, the v1b extension)
When `crawl_order != "shallow"`, the crawl consumes a caller-supplied `ordered_urls` list (first N of the discovered list, sorted by the chosen order) instead of recursively discovering. New provider capability: **fetch a known list of URLs → `batch_web_ingestion`**.
- Spider: one scrape/fetch per URL (or a seed-list crawl), returning `{url, content}` per page.
- Playwright fallback: fetch each URL directly.
- Reuses `batch_web_ingestion` (chunk → embed → store → atomic billing) unchanged.
Ordering is applied client-side/route-side by sorting the discovered `urls[]` (each carries `depth` + `sitemap_index` for sorting) and truncating to N.

### C4 — Estimate modal (frontend, `KnowledgeBase.jsx`)
- After "Scan", if `exceeds_balance`: open modal with the math headline, count slider/input **clamped to `max_affordable_pages`**, order radio group, live cost = `count × cost_per_page`, and **Start Crawl (N) / Top up / Cancel**.
- If `!exceeds_balance`: no modal — proceed as today.
- Display hint keeps the existing `?? 100 / ?? 3` fallback; the modal uses authoritative discover numbers.

## Error handling / edge cases

- **0 credits (`max_affordable_pages == 0`):** modal offers Top up only; no crawl option.
- **Site grew between scan and crawl:** atomic per-page billing stops the crawl at the balance; `pages_crawled` reported. No overspend.
- **JS mode:** effective cap = `min(max_affordable_pages, max_crawl_js_pages)`; show the tighter number.
- **Discover fails/timeouts:** fall back to today's behavior (start crawl; backend `402` as the net). Non-fatal.
- **Free plan (hard cap):** cap = `min(plan_max_pages, max_affordable_pages)`.
- **Re-crawl (`replace_source`):** existing SHA-skip + `expected_new_pages` pre-flight path is unchanged; the estimate uses `expected_new_pages` when present.

## Testing

- **Backend:** discover returns correct credit math (balance/cost mocked); `crawl_order` validated + threaded; explicit-list fetch ingests exactly the supplied URLs; 0-balance path; JS-cap interaction.
- **Frontend:** modal renders only when `exceeds_balance`; count clamps at `max_affordable_pages`; live cost = `count × cost_per_page`; order radio passes through.
- **Reuse:** existing crawl/billing integration tests (pipeline unchanged).

## Recommended implementation order (shippable mid-plan)

1. C1 — discover credit math (additive, unblocks UX).
2. C2 — `crawl_order` plumbing (additive, default shallow = no behavior change).
3. C4 — estimate modal + count picker → **shippable: warning + count picker + shallow-first.**
4. C3 — explicit ordered-URL fetch (enables sitemap/discovered).
5. Frontend order selector wired to C2/C3.
6. Tests + rollout (feature works incrementally; each step is independently valuable).
