# Company Intelligence — Design

**Status:** approved, ready for implementation planning
**Date:** 2026-08-10
**Tier:** Professional (display); paid tiers (IP lookup)
**New vendors:** none
**Diagrams:** https://claude.ai/code/artifact/3788715d-7fc7-41d8-b41a-851192e06752

## Goal

Identify the company behind a chat lead, and never state it with more certainty than
the evidence supports.

## Why the original premise was inverted

The feature was built around IP→company. Production disproved that premise. Every IP
resolution the platform has ever made:

| `company_type` | Resolved name | Count | Usable? |
|---|---|---|---|
| `isp` | Bharti Airtel Limited | 7 | No — carrier |
| `isp` | Reliance Jio Infocomm | 1 | No — carrier |
| `isp` | Vodafone Idea (VIL) | 1 | No — carrier |
| `business` | `TSBB pool2` | 1 | No — subnet label |

**10 resolutions, 0 usable identifications.** Over the same window, **6 of 8 leads
volunteered a work email**, which identifies the company for free and deterministically.

IP→company only resolves an employer when a company owns its own address block *and*
the visitor is on that corporate network. Most Indian SMBs reach the internet via
Airtel/Jio business broadband, so the IP belongs to the carrier. Hybrid work shrinks
the remainder further.

**Consequence:** the email domain becomes the engine; the IP becomes a rarely-fired
last resort, and keeps its budget for what it is genuinely good at — VPN, proxy,
datacenter and abuse detection.

## Resolution waterfall

First hit wins. Every tier records how it knew.

| # | Source | Confidence | Exported? | Cost |
|---|---|---|---|---|
| 1 | Work-email domain → crawl + `extract_company_context` | `email_domain` | Yes | ~0, cached per domain |
| 2 | Company field typed by the visitor on the lead form | `visitor_stated` | Yes | 0 |
| 3 | Employer named in the transcript → LLM extract | `conversation` | Yes | ~0, rides the BANT call |
| 4 | IP where `type == business` and the name passes a sanity filter | *(display only)* | **No** | already paid |
| — | Nothing matched | `null` | — | 0 |

### The export rule (load-bearing)

**Tiers 1–3 write `LeadInfo.company`. Tier 4 never does.**

That field flows into CSV export and webhooks, and from there into customers' CRMs —
where the confidence label does not survive. A network-derived guess would land in
Salesforce as fact, and a rep would cold-call Infosys about someone who was a guest in
their lobby.

Tier 4 remains a display-only signal in the lead drawer, beside the VPN/datacenter
flags where its context is visible.

This is enforced structurally: `company_source` is an enum with **no `ip` member**, so
the schema prevents a future contributor from writing a network guess into an exported
field.

## Data model

### New table — `company_profile`

Keyed by registrable domain. **Cross-tenant**: it holds only public web data about a
company, so there is nothing to leak between clients, and it is the largest cost lever
in the design — a popular domain is crawled once for the whole platform.

| Column | Type | Purpose |
|---|---|---|
| `domain` | text, PK | Registrable domain, public-suffix normalised |
| `name` | text, null | e.g. "Fynix Digital" |
| `description` | text, null | 2–3 sentences from the LLM |
| `logo_url` | text, null | `og:image` or apple-touch-icon from the crawled page |
| `resolution_failed` | bool | Site dead, or LLM output rejected |
| `retry_after` | timestamptz, null | Backoff gate; stops per-lead re-crawls |
| `refresh_after` | timestamptz | 90-day lazy refresh |
| `created_at` / `updated_at` | timestamptz | |

### Changes to `lead_info`

| Column | Change | Note |
|---|---|---|
| `company` | Now holds the display **name** | Today it holds the raw domain. Must never overwrite a visitor-typed value. |
| `company_domain` | New | Retains the domain once `company` becomes a name |
| `company_source` | New enum | `email_domain` \| `visitor_stated` \| `conversation` \| `null` |

## Domain resolution & cache

1. Normalise the address to its registrable domain via a **public-suffix list**. A naive
   `split('@')` breaks every multi-part TLD (`user@mail.acme.co.uk`).
2. Look up `company_profile`:
   - **Fresh hit** → return cached, 0 cost, 0 latency.
   - **Stale hit** (>90d) → serve stale immediately, refresh lazily behind it.
   - **Failed hit within backoff** → return "not identified", do not re-crawl.
   - **Miss** → crawl root page (Spider → Jina fallback).
3. Crawl failure (down / parked / 404) → record failure with exponential backoff.
4. Crawl success → `extract_company_context` (gate-tier LLM).
5. Validate output — reject empty, over-length, or prompt-echoing responses; a rejected
   output is recorded as a failure.
6. Store name + description + logo.

All of it runs in the background. Nothing blocks a visitor-facing request.

## Edge cases

| Case | Handling |
|---|---|
| `user@mail.acme.co.uk` | Public-suffix normalisation |
| Personal provider (gmail, etc.) | Tier 1 skipped; falls through. Already handled by `extract_company_domain` |
| Site down / parked / for sale | Failure cached with backoff; never re-crawled per lead |
| LLM returns junk | Rejected and recorded as a failure |
| IP name is a pool label | Sanity filter rejects ISP names and `pool` / `subnet` / `broadband` / `telecom` / digit-only strings |
| Chat names a different company than the email domain | Tier 1 wins; verified beats self-reported. No conflict surfaced |
| Visitor typed a company AND has a work email | Tier 1 wins on name; the typed value is preserved, never clobbered |
| 500 leads from one domain | One crawl total |
| Disposable domain | Already blocked upstream by Reoon |
| Profile older than 90 days | Stale served immediately, refreshed lazily |
| Free-plan bot | No ipapi.is call at all — quota is not spent on a tier that cannot display it |

## Plan gating

| Capability | Tier |
|---|---|
| Real-time email validation | Any paid plan (`plan_slug != "free"`) |
| IP lookup (once per session) | Any paid plan |
| Company Intelligence display + resolution | Professional only |

Gates resolve **per bot**, not per account — billing attaches to the Bot, and the
account-level resolver deliberately returns the highest-priced plan across all bots.

## Cost

| Operation | When | Cost |
|---|---|---|
| Domain crawl + LLM extract | Once per *unique* domain, platform-wide | 1 scrape + 1 gate-model call |
| Conversation company extract | Every qualifying chat | ~0 — an extra field on an existing LLM call |
| ipapi.is | Once per session, paid plans only | Existing spend, reduced by the per-session guard |
| Reoon | Unchanged | Existing spend |

No new vendor, no per-lead marginal cost. The feature is priced on outcome, not cost
base, and must appear as a named line item in the plan matrix to be chargeable.

## Phasing — parallel work in flight

A second developer is building visitor-name capture and handoff inputs (unpushed, local
only). His work overlaps our lead-capture path and strengthens Tier 2. To avoid an
alembic fork — which this repo has already suffered once (`7cb7db6`) — the build is
split:

**Phase A — no contact with his files**
- `company_profile` table + migration
- Public-suffix domain normaliser (new module)
- Domain → crawl → LLM resolver with cache (new module)
- IP sanity filter (isolated function in `ip_intel_service`)
- Admin UI: confidence chips, tier-4 display-only separation

**Phase B — after his merge**
- `lead_info` column additions (single combined migration)
- `chat_routes` lead-capture wiring
- Tier 2 against whatever form he ships
- Tier 3 conversation extraction

**Rule:** whoever merges second rebases their migration's `down_revision`; never allow
two alembic heads.

## Testing strategy

- **Domain normaliser** — unit tests over public-suffix edge cases (`co.uk`, `com.au`,
  subdomains, bare domains, malformed input).
- **IP sanity filter** — `TSBB pool2` as a fixture, plus each ISP name and each rejected
  keyword; and a positive case that a genuine business name passes.
- **Waterfall** — contract tests asserting each tier fires only when every tier above it
  misses.
- **Export rule** — a test asserting a tier-4 resolution leaves `LeadInfo.company` NULL
  and is absent from the CSV export.
- **Cache** — a test proving the second lead on a domain triggers no crawl, and that a
  failed domain is not re-crawled while backoff is active.
- **Plan gating** — per-bot tests mirroring the existing `test_bot_entitlements.py`
  pattern (Professional allowed, Free sibling denied).

## Non-goals

- Firmographics (employee count, revenue, industry) — deferred; would require a paid
  vendor.
- Person-level identification — out of scope, and non-compliant under DPDP without
  consent.
- Scoring, routing, or alerting on company data — a later layer that depends on this one.
