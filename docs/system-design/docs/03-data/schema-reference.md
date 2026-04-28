# Schema reference

> **Audience:** New engineers · **Read time:** 12 min · **Last updated:** 2026-04-28

> **Authoritative source:** [`api/app/db/models.py`](../../../api/app/db/models.py). When this page disagrees with `models.py`, the code wins — please update this page in the same PR.

## Conventions

- All tables have `created_at` (UTC, default `now()`) unless noted.
- Most have `updated_at` (UTC, on-update); exceptions are immutable audit-trail tables (`bant_signals`, `chat_audit_logs`, `credit_ledger`).
- Index columns marked `(idx)`. Unique columns marked `UNIQUE`.

## Core domain

### `clients`

The customer account. One row per OyeChats sign-up.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `email` | varchar **UNIQUE** | Login |
| `hashed_password` | varchar | bcrypt |
| `api_key` | varchar **UNIQUE** | `X-API-Key` value |
| `company_name` | varchar | Onboarding |
| `max_bots` | int | Plan-derived; enforced at bot-create time |
| `is_superadmin` | bool | Gates super-admin routes |
| `is_bot_manager` | bool | Elevated access to a single bot |

### `bots`

A chatbot instance. Multi-tenant key throughout the system.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK → clients.id | CASCADE |
| `bot_key` | varchar **UNIQUE** | `bot-xxxxxxxxxxxx`; widget public auth |
| `name` | varchar | Display |
| `system_prompt` | text | LLM persona |
| `colors`, `logos`, `recommended_colors` | json | Branding |
| `welcome_title`, `welcome_subtitle`, etc. | varchar | Customizable strings |
| `business_hours` | json | `{"mon":{"start":"09:00","end":"17:00"}, ...}` |
| `live_chat_enabled` | bool | Master switch |
| `notification_emails` | jsonb | Per-event routing |
| `email_on_qualified`, `email_on_handoff`, `email_on_offline` | bool | Per-event toggles |
| `relevance_threshold` | float | RAG gate cutoff |
| `qualification_framework` | varchar | `bant` / `meddic` / `custom` |
| `qualification_config` | jsonb | Custom dimensions, thresholds, decay |

### `documents`

Ingested chunk + embedding. **Many** rows per uploaded file.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK → clients.id | **Legacy nullable**; CASCADE |
| `bot_id` | int FK → bots.id | Modern; CASCADE |
| `source_type` | varchar | `file` / `url` |
| `source_path` | varchar | R2 (Cloudflare) object key for files; URL for crawls |
| `chunk_index` | int | Order within parent document |
| `content` | text | The chunk |
| `embedding` | vector(1536) | OpenAI `text-embedding-3-small` |
| `content_tsv` | tsvector | Full-text index |

### `chat_sessions`

One conversation. The hub of the schema; lots of fields.

| Column | Type | Notes |
|---|---|---|
| `id` | varchar **PK** | UUID-like client-generated |
| `client_id` | int FK | Legacy nullable |
| `bot_id` | int FK | Modern |
| `assigned_operator_id` | int FK → operators.id | SET NULL |
| `department_id` | int FK | SET NULL |
| `status` | varchar | `bot` / `waiting` / `live` / `closed` |
| `qualification_framework` | varchar | bant / meddic |
| `bant_need`, `bant_timeline`, `bant_authority`, `bant_budget` | varchar | Latest extracted values |
| `bant_need_score`, `_timeline_score`, `_authority_score`, `_budget_score` | int | 0–25 each |
| `bant_score` | int | Composite 0–100 |
| `bant_tier` | varchar | unqualified / mql / sal / sql |
| `dimensions_assessed` | int | How many dims have non-zero score |
| `bant_last_updated` | timestamp | Decay anchor |
| `inline_cards_shown` | jsonb | Tracked CTAs (idempotency) |
| `lead_viewed_at` | timestamp | Unread state |
| `visitor_rating` | int | 1–5 post-chat |
| `visitor_resolved` | bool | Self-reported outcome |
| `handoff_reason` | text | Why escalated |

### `chat_messages`

Per-turn message log.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK → chat_sessions.id | CASCADE |
| `role` | varchar | `user` / `bot` / `operator` / `system` |
| `content` | text | |
| `trace_id` | varchar | Langfuse correlation |
| `feedback` | int | thumbs up/down (-1/0/+1) |

### `lead_info`

Captured contact info; **one row per session** (1:1 enforced via UNIQUE).

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK **UNIQUE** | CASCADE |
| `bot_id` | int FK | CASCADE |
| `name`, `email`, `phone`, `company`, `custom_fields` | varchar/json | |

## Live chat domain

### `operators`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK | CASCADE |
| `department_id` | int FK | SET NULL |
| `email`, `hashed_password`, `operator_api_key` | varchar **UNIQUE** | |
| `name`, `avatar_url` | varchar | |
| `role` | varchar | `owner` / `admin` / `operator` |
| `is_online`, `last_seen_at` | bool / timestamp | |
| `max_concurrent_chats` | int | |
| `notification_preferences` | jsonb | |
| `is_active` | bool | Soft delete |

### `departments`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK | CASCADE |
| `name` | varchar | |

### `chat_audit_logs`

Immutable transition log.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK | CASCADE |
| `operator_id` | int FK | SET NULL |
| `action` | varchar | `handoff_requested` / `accepted` / `closed` / `transferred` / `timeout` / `visitor_ended` |
| `details` | json | Free-form context |

### `canned_responses`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK | |
| `created_by_operator_id` | int FK | SET NULL |
| `title`, `content`, `shortcut` | varchar/text | `/hello`-style trigger |

### `offline_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `bot_id` | int FK | |
| `session_id` | varchar FK | SET NULL |
| `department_id` | int FK | SET NULL |
| `name`, `email`, `phone`, `message` | text | |
| `status` | varchar | `new` / `read` / `replied` |

## Qualification domain

### `bant_signals`

Append-only audit trail; one row per dimension assessment.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK (idx) | CASCADE |
| `message_id` | int FK | SET NULL |
| `dimension` | varchar | `need`, `timeline`, `authority`, `budget`, … |
| `signal_text` | text | Raw extracted text |
| `extracted_value` | varchar | Mapped category |
| `confidence` | varchar | `low` / `medium` / `high` |
| `score_before`, `score_after` | int | 0–25 |
| `source` | varchar | `llm` / `cta_click` |

### `visitor_events`

Behavioral signals.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK (idx) | CASCADE |
| `bot_id` | int FK | CASCADE |
| `event_type` | varchar | `page_view`, `return_visit`, `utm_captured`, `time_on_site` |
| `payload` | json | UTM, URL, referrer |

### `bot_growth_events`

Per-bot business events (engagement spikes, milestones).

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `bot_id` | int FK (idx) | CASCADE |
| `event_type`, `metadata` | varchar / json | |

### `meeting_bookings`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK (idx) | CASCADE |
| `bot_id` | int FK | CASCADE |
| `provider` | varchar | `calendly` / `zcal` |
| `booking_id` | varchar | Provider's ID |
| `confirmed_at` | timestamp | |

## Billing domain

### `plans`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `slug` | varchar **UNIQUE** | `free`, `standard`, … |
| `name`, `description` | varchar / text | |
| `monthly_price_cents`, `annual_price_cents` | int | Minor units |
| `currency` | varchar | `INR`, `USD` |
| `credits_per_month` | int | Plan grant |
| `included_operator_seats` | int | |
| `extra_seat_price_cents` | int | |
| `feature_flags` | jsonb | Per-plan toggles |
| `usage_limits` | jsonb | E.g., max bots, max docs |
| `trial_days` | int | |
| `stripe_product_id`, `stripe_price_id` | varchar | |
| `razorpay_plan_id`, `razorpay_plan_id_annual` | varchar | |
| `is_active` | bool | |

### `subscriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `plan_id` | int FK | RESTRICT (no plan delete with active subs) |
| `status` | varchar | `trialing`, `active`, `past_due`, `canceled`, `paused`, `expired` |
| `cycle` | varchar | `monthly`, `annual` |
| `provider` | varchar | `stripe`, `razorpay`, `manual` |
| `provider_subscription_id` | varchar | |
| `current_period_start`, `current_period_end` | timestamp | |
| `cancel_at_period_end` | bool | |
| `canceled_at`, `paused_at`, `resumed_at` | timestamp | |
| `seats` | int | Operator seats purchased |

### `usage_records`

One row per (client, period); counters update through period.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `plan_id` | int FK | SET NULL |
| `period_start`, `period_end` | date | |
| `ai_messages`, `url_scans`, `live_chat_messages`, `emails_sent`, `documents_indexed` | int | |
| `overage_*` counters | int | |

### `invoices`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `subscription_id` | int FK | SET NULL |
| `amount_cents`, `currency`, `status` | int / varchar / varchar | |
| `period_start`, `period_end` | timestamp | |
| `provider`, `provider_invoice_id`, `hosted_invoice_url` | varchar | |
| `paid_at` | timestamp | |

### `payment_methods`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `provider` | varchar | |
| `provider_method_id` | varchar | |
| `type` | varchar | `card`, `upi`, `bank` |
| `last4`, `brand` | varchar | Display |
| `is_default` | bool | |

### `credit_ledger`

Append-only event log; **the** source of truth for credit balance.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK | CASCADE |
| `delta` | int | Signed; +grant, –deduction |
| `reason` | varchar | `monthly_grant`, `topup`, `ai_message`, `url_scan`, `email`, `refund`, `manual_adjust` |
| `grant_id` | int FK → credit_ledger.id | SET NULL — links a deduction to the grant it consumed (FIFO for top-ups) |
| `expires_at` | timestamp | NULL for plan grants; set for top-ups (12 mo) |
| `created_by` | int FK → clients.id | SET NULL — who initiated (super-admin for manual) |
| `metadata` | json | Reference IDs |

### `pricing_config`

Super-admin tunable key/value.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `key` | varchar **UNIQUE** | `credit_cost.ai_message`, `topup_packs`, `kill_switch`, … |
| `value` | json | Anything |
| `updated_by` | int FK → clients.id | SET NULL |

### `processed_webhooks`

Idempotency for inbound provider webhooks.

| Column | Type | Notes |
|---|---|---|
| `event_id` | varchar **PK (composite)** | |
| `provider` | varchar **PK (composite)** | `stripe` / `razorpay` |
| `received_at` | timestamp | |

## Webhook (outbound) domain

### `webhooks`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `bot_id` | int FK (idx) | CASCADE |
| `url` | varchar | HTTPS only |
| `secret` | varchar | HMAC-SHA256 key |
| `event_filter` | jsonb | List of events to subscribe |
| `active` | bool | |

### `webhook_deliveries`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `webhook_id` | int FK (idx) | CASCADE |
| `event_type` | varchar | `tier_transition` / `lead_captured` / `handoff_requested` / `chat_closed` / `meeting_booked` |
| `payload` | json | Snapshot |
| `attempt` | int | 1–5 |
| `status` | varchar | `pending` / `delivered` / `failed` / `dead` |
| `response_code` | int | HTTP status |
| `response_body` | text | Truncated |
| `next_retry_at` | timestamp | |

## Why this matters

When a bug is "a column is wrong," start here. When a query is slow, the index hints in this page tell you whether the right column is indexed. When a model changes, this page is part of the same PR.
