# Timezone & Datetime Handling

How OyeChats handles time across the stack.

**Core principle:** *All timestamps are stored and computed in **UTC**. Local time appears in only two places — the **frontend display layer** and the **business-hours** feature.*

> Last reviewed: 2026-06-29 (counts re-verified against source: 81 `DateTime(timezone=True)` columns / 0 naive ✓; 73 `datetime.now(UTC)` in app code ✓). Related: [architecture.md](architecture.md), [database-schema.md](database-schema.md), [billing/2026-06-29-payment-system-review-report.md](billing/2026-06-29-payment-system-review-report.md) (timezone findings M5, N8, N9).

---

## Data flow at a glance

```
Store / compute (UTC)                              Convert to local
──────────────────────────────                    ─────────────────────────────────────
Postgres timestamptz ──UTC──► Backend             ──UTC ISO 8601──► Frontend toLocale*()
  datetime.now(UTC)                                                  → viewer's BROWSER timezone
Razorpay epoch ──fromtimestamp(ts, tz=UTC)──► billing math
  add_months() preserves wall-clock time-of-day

Business hours: now(UTC) ──► ZoneInfo(bot's IANA tz) ──► open / closed
Geo headers (country) ──► currency display only (NOT timezone)
```

---

## 1. Database layer — uniformly timezone-aware

Every `DateTime` column in [`api/app/db/models.py`](../api/app/db/models.py) is declared `DateTime(timezone=True)` — **all 81 of them; zero naive timestamp columns.** They default via `server_default=func.now()` (the Postgres server clock).

Because the columns are `timestamptz`, Postgres stores the absolute instant in UTC internally regardless of the connection timezone, and reads return timezone-aware UTC datetimes. This is the foundation that makes "UTC everywhere" hold at rest.

> **Operational dependency:** the production DB server runs in **UTC**. `timestamptz` keeps the stored *instant* correct either way, but keep the server in UTC to avoid surprises in raw SQL / `func.now()` defaults.

## 2. Backend — UTC-aware datetimes

The backend is disciplined about aware UTC:

- **73** datetime creations use `datetime.now(UTC)` (timezone-aware).
- Razorpay Unix-epoch fields are always parsed as UTC, e.g. `datetime.fromtimestamp(sub_entity["current_start"], tz=UTC)` — a naive parse would shift by the server offset.
- Only **one** code path intentionally leaves UTC: business hours (§4).

### Shared helpers — [`api/app/core/dates.py`](../api/app/core/dates.py)

Centralized so the API, dashboard, billing badge, and reminder cron can never disagree:

| Helper | Behavior |
|---|---|
| `trial_days_remaining(trial_end)` | Whole days left, **rounded up** (`ceil`) — a trial ending in 2h reads "1 day left", matching how customers count and the reminder cadence. Naive inputs assumed UTC. Returns `None` if no trial, `0` once lapsed. |
| `add_months(dt, months)` | **Calendar-month** arithmetic (not `timedelta(days=30)`), clamping short months (Jan 31 + 1mo → Feb 28/29). **Preserves the original `tzinfo` and wall-clock time-of-day**, so a sub created at 17:18 IST renews at 17:18 IST on the anniversary — not midnight UTC. |

## 3. Geo (related, not timezone)

[`api/app/core/geo.py`](../api/app/core/geo.py) resolves the visitor's **country** from edge headers (`CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`, `X-Country-Code`). This drives **currency display** (IN → INR, otherwise USD), **not** timezone. Unknown country → treated as non-Indian. There is **no IP-based timezone detection** anywhere in the app.

## 4. Business hours — the only "local time" feature

The single place the app evaluates "what time is it *there*." Each **bot** (or **department**, which overrides) stores a `business_hours` JSON blob ([`models.py` `Bot.business_hours`](../api/app/db/models.py)):

```json
{
  "timezone": "Asia/Kolkata",
  "mon": { "start": "09:00", "end": "17:00" },
  "sat": null
}
```

[`api/app/services/live_chat_availability_service.py`](../api/app/services/live_chat_availability_service.py) decides availability by converting UTC *now* into the configured IANA zone — `datetime.now(ZoneInfo(tz_name))` — then comparing against that day's window. Rules:

- **No config** = 24/7 (always available).
- **Department hours override bot hours** when present.
- **Per-day `null`** = closed that day.
- **Cross-midnight ranges** supported (e.g. `22:00`–`02:00`).
- **Fail open**: an invalid timezone string logs a warning and treats the bot as open rather than locking customers out.

The **widget** mirrors this client-side ([`widget/src/components/ChatWidget.jsx`](../widget/src/components/ChatWidget.jsx)) using the bot's configured `timeZone`, so the "offline" banner matches the server's decision.

## 5. Frontend — display in the viewer's browser zone

The backend always emits UTC (ISO 8601); the frontend converts to **the viewer's own browser timezone** via JS `Date`:

- `toLocaleString()` / `toLocaleDateString()` / `toLocaleTimeString()` throughout the admin app and widget render in the user's local zone automatically.
- [`app/src/components/BusinessHoursEditor.jsx`](../app/src/components/BusinessHoursEditor.jsx) uses `Intl.DateTimeFormat().resolvedOptions().timeZone` to pre-fill the admin's detected zone and `Intl.supportedValuesOf('timeZone')` for the IANA dropdown.
- The widget's [`ChatWindow.jsx`](../widget/src/components/ChatWindow.jsx) renders message times with `timeZoneName: 'short'`.

**Intended consequence:** the same `created_at` instant is shown differently to an admin in Mumbai vs. New York — each sees their own local time.

## 6. Known gaps & cleanup items

None are currently biting because the primary market is India (IST has no DST), but for correctness:

1. **`add_months` DST safety (review finding M5).** It copies wall-clock `tzinfo` literally. For a DST zone, "preserve wall-clock" shifts the real UTC instant by the DST delta across a boundary, and a spring-forward gap yields a non-existent local time with no `fold` handling. Safe for IST; a hazard if billing ever anchors to a DST zone. *Fix:* do period math in UTC, or normalize with `zoneinfo` + `fold`.
2. **Deprecated naive calls in ingestion.** [`api/app/ingestion/pipeline.py`](../api/app/ingestion/pipeline.py) uses naive `datetime.utcnow()` / `datetime.now()` for log timestamps and filenames. `utcnow()` is deprecated in Python 3.12 and **removed in 3.14**. *Fix:* migrate to `datetime.now(UTC)`.
3. **`trial_days_remaining` uses `ceil`.** Correct for display, but must not be used as an access *gate* (would grant an extra calendar day). The expiry cron compares `trial_end < now()` directly — keep it that way.
4. **`add_months` anniversary drift across a chain (review finding N8).** The short-month clamp `min(dt.day, last_of_month)` (`dates.py:58`) uses the *current* `dt.day`. If billing periods roll by calling `add_months(prev_period_end, 1)` rather than re-deriving from the original anchor, a 31st anchor ratchets down (Jan-31 → Feb-28 → Mar-28 → …) and never recovers. Safe only if callers always pass the original anchor. *Fix:* pass the anchor, or carry the anchor day separately.
5. **Ingestion emits naive `ingest_date` (review findings T1 / N9).** [`api/app/ingestion/pipeline.py`](../api/app/ingestion/pipeline.py) writes `datetime.utcnow().isoformat()` (`:168,345`) into chunk metadata — a *naive* string with no `+00:00`, while every DB `timestamptz` and `datetime.now(UTC).isoformat()` carries the offset. Any consumer that parses and compares `ingest_date` aware-vs-naive hits `TypeError` (violating the §"Conventions" aware-to-aware rule). `:530,551` also use server-local `datetime.now()` for filenames. *Fix:* `datetime.now(UTC)` throughout.

## Conventions for new code

- **Always** create datetimes with `datetime.now(UTC)`. Never `datetime.utcnow()` (deprecated/naive) or `datetime.now()` (server-local).
- **Parse external epochs** (Razorpay/Stripe) with `datetime.fromtimestamp(ts, tz=UTC)`; send back with `int(aware_dt.timestamp())`.
- **DB columns:** `DateTime(timezone=True)`, default `lambda: datetime.now(UTC)` (or `server_default=func.now()`).
- **Month/year math:** use `add_months` (or `dateutil.relativedelta`), never `timedelta(days=30)`.
- **Compare aware-to-aware only** — mixing aware and naive raises `TypeError`.
- **Convert to local only at the edges:** the frontend (`toLocale*`) and the business-hours evaluator (`ZoneInfo`). Everything in between stays UTC.
