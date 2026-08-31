# Schema reference

> **Audience:** New engineers · **Read time:** 12 min · **Last updated:** 2026-08-31

> **Authoritative source:** [`api/app/db/models.py`](../../../../api/app/db/models.py). When this page disagrees with `models.py`, the code wins — please update this page in the same PR.

> **Scope.** `models.py` declares **51** tables; this page covers the 25 core ones and, within those, the columns worth knowing about. Every table here has more columns than are listed (`bots` alone has ~90). Treat a missing column as "not documented", never as "does not exist".

## Conventions

- All tables have `created_at` (UTC, default `now()`) unless noted.
- Most have `updated_at` (UTC, on-update); exceptions are immutable audit-trail tables (`bant_signals`, `chat_audit_logs`, `credit_ledger`, `webhook_deliveries`).
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
| `company_name`, `legal_name`, `gstin`, `billing_*` | varchar | Onboarding + invoicing identity |
| `max_bots`, `extra_bot_seats` | int | Plan-derived; enforced at bot-create time |
| `kb_characters_used` | int | Knowledge-base quota counter, decremented from `documents.source_char_count` on delete |
| `is_superadmin` | bool | Gates super-admin routes |
| `superadmin_role` | varchar | Finer-grained super-admin scoping |
| `is_verified`, `email_otp`, `reset_otp`, `pending_email` | mixed | Email verification, password reset, email change |
| `razorpay_customer_id`, `pending_checkout_*` | varchar | Checkout continuity |

There is **no `is_bot_manager` column**. Workspace roles live on the `operators` row.

### `bots`

A chatbot instance. Multi-tenant key throughout the system.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK → clients.id | CASCADE |
| `bot_key` | varchar **UNIQUE** | `bot-xxxxxxxxxxxx`; widget public auth |
| `name` | varchar | Display |
| `system_prompt` | text | LLM persona |
| `primary_color`, `background_color`, `header_color`, `user_bubble_color`, `recommended_colors` | varchar / json | Branding (there is no single `colors` column) |
| `bot_logo`, `launcher_logo`, `launcher_name`, `avatar_type`, `orb_color` | varchar | Launcher + avatar |
| `welcome_title`, `welcome_subtitle`, `waiting_message`, `offline_message`, `widget_messages` | varchar / json | Customizable strings |
| `business_hours` | json | `{"mon":{"start":"09:00","end":"17:00"}, ...}` |
| `live_chat_enabled` | bool | Master switch |
| `operator_timeout_seconds`, `visitor_disconnect_timeout`, `operator_disconnect_timeout`, `live_chat_queue_timeout_seconds`, `live_chat_max_queue_size`, `live_chat_routing_strategy` | int / varchar | Live-chat tuning |
| `notification_email`, `notification_emails`, `reply_to_email` | varchar / jsonb | Per-event routing |
| `email_on_qualified`, `email_on_handoff`, `email_on_offline`, `email_visitor_confirmation` | bool | Per-event toggles |
| `relevance_threshold` | float | Per-bot override of the CRAG gate cutoff |
| `bant_enabled` | bool | Master switch for qualification |
| `bant_config` | jsonb | **The rubric AND the framework name.** There is no `qualification_framework` or `qualification_config` column on `bots`; `qualification_service._framework_name` reads it out of here |
| `qualification_flow`, `quotation_catalog` | jsonb | Pre-handoff flow and the quote catalogue |
| `language_config`, `widget_config`, `feature_flags` | jsonb | Multilingual, widget behaviour, per-bot flags |
| `allowed_domains`, `domain_check_enabled`, `session_share_domain` | json / bool | Embed origin control; also bounds `?url=` on the hosted demo page |
| `demo_screenshot_url`, `_captured_at`, `_source_url`, `_status` | varchar / timestamp | Hosted demo-page backdrop |
| `plan_id`, `subscription_id`, `credits_balance`, `is_legacy_pooled` | int / bool | Per-bot billing |
| `recrawl_enabled`, `next_recrawl_at`, `last_recrawl_status`, `recrawl_history` | mixed | Scheduled re-crawls |
| `indexed_chunk_count`, `last_crawl_status`, `crawl_completed_at` | int / varchar | Knowledge state |

### `documents`

Ingested chunk + embedding. **Many** rows per uploaded file.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK → clients.id | **Legacy nullable**; CASCADE |
| `bot_id` | int FK → bots.id | Modern; CASCADE |
| `document_name` | varchar | Source file name, or the page URL for a crawl. This is the per-source key `delete_chunks_for_url` uses |
| `source` | varchar | `upload` / `crawl`. Replaced a `document_name LIKE 'http%'` heuristic that mis-classified a file literally named `https-notes.pdf` |
| `is_active` | bool (idx) | Every retrieval and listing query is scoped to this. Flipped false in bulk when a paid subscription lapses to Free — the data is kept, the bot just stops answering from it |
| `file_hash` | varchar (idx) | Dedup key |
| `source_char_count` | int | Character count of the whole cleaned source, replicated on every chunk of it, so `clients.kb_characters_used` can be decremented on delete without recomputing |
| `content` | text | The chunk |
| `metadata_info` | jsonb | Per-chunk metadata |
| `embedding` | **vector(768)** NOT NULL | Google `gemini-embedding-001`, Matryoshka-truncated + L2-normalised |
| `search_vector` | tsvector | Full-text index, GIN. **Named `search_vector`, not `content_tsv`**, and built with the `'english'` config |

There is **no `source_type`, `source_path` or `chunk_index` column**. Indexes: `ix_documents_search_vector` (GIN) and the composite `ix_documents_bot_id_is_active` that every vector search rides. There is deliberately **no global HNSW index** — see [containers](/02-architecture/containers).

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
| `qualification_framework` | varchar | Per-session stamp of the framework in force |
| `last_probed_dimension` | varchar | Which dimension the bot asked about last. **Load-bearing security state**: it is what makes a visitor-supplied `cta_dimension` trustworthy |
| `dimension_scores` | jsonb | Per-dimension scores for custom frameworks |
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
| `location`, `device`, `page_url`, `referrer`, `utm_params`, `visitor_journey`, `visit_count`, `behavioral_score` | mixed | Visitor intelligence |
| `language_code`, `locale`, `language_source`, `language_confidence`, `language_locked` | varchar / float / bool | Multilingual. `language_source` ranks `explicit` > site locale > **detection** > browser > persisted > default |
| `quotation_state`, `flow_state` | jsonb | Quote flow and pre-handoff flow progress |

### `chat_messages`

Per-turn message log.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK → chat_sessions.id | CASCADE |
| `role` | varchar | `user` / `bot` / `operator` / `system` |
| `content` | text | |
| `trace_id` | varchar | Langfuse correlation |
| `feedback` | int | thumbs up/down |
| `is_unanswered` | bool (idx) | True on a bot turn that could **not** be answered from the knowledge base — the relevance gate fired on an on-scope question, or retrieval returned nothing. Powers knowledge-gap analytics; both refusal branches now set it |
| `media_card`, `media_secondary` | jsonb | YouTube / download cards, parsed out of `content` at save time so the widget can re-render them after a refresh |
| `source_language` | varchar(16) | The language `content` is written in |
| `translations` | jsonb | Derived translations keyed by target language. `content` is the canonical original and is never modified after insert |

### `lead_info`

Captured contact info; **one row per session** (1:1 enforced via UNIQUE).

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK **UNIQUE** | CASCADE |
| `bot_id` | int FK | CASCADE |
| `name`, `email`, `phone`, `company` | varchar | Captured contact |
| `company_name`, `company_description`, `company_logo_url`, `is_b2b` | varchar / text / bool | Enrichment from the IP → company lookup |
| `is_valid_email`, `email_score` | bool / int | Reoon verification verdict |
| `suppression_reason` | varchar | Per-bot unsubscribe / suppression |
| `utm_params`, `visitor_journey`, `metadata_json` | jsonb | Attribution |
| `last_followup_sent_at`, `followup_sent_by_operator_id` | timestamp / int FK | Manual follow-up |

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
| `is_online`, `last_seen_at`, `is_accepting_chats` | bool / timestamp | Presence + availability |
| `max_concurrent_chats` | int | |
| `notification_preferences` | jsonb | |
| `preferred_locale`, `supported_languages` | varchar / json | Operator locale, **re-read per message** so a mid-shift change takes effect in both directions |
| `bot_id`, `linked_client_id`, `invited_email` | int / varchar | Per-bot scoping, linked-admin seats, invites |
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
| `title`, `content`, `shortcut`, `category` | varchar/text | `/hello`-style trigger |

### `offline_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `bot_id` | int FK | |
| `session_id` | varchar FK | SET NULL |
| `department_id` | int FK | SET NULL |
| `visitor_name`, `visitor_email`, `visitor_phone`, `message_body` | varchar / text | The submitted form |
| `transcript`, `fallback_reason` | text / varchar | Context at capture time |
| `status` | varchar | `new` / `read` / `replied` (with `read_at` / `replied_at`) |

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
| `source` | varchar | `llm` / `cta_click` / `operator_override` |

### `visitor_events`

Behavioral signals.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK (idx) | CASCADE |
| `bot_id` | int FK | CASCADE |
| `event_type` | varchar | `page_view`, `return_visit`, `utm_captured`, `time_on_site` |
| `event_data` | json | UTM, URL, referrer (the column is `event_data`, not `payload`) |

### `bot_growth_events`

Per-bot business events (engagement spikes, milestones).

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `bot_id` | int FK (idx) | CASCADE |
| `event_type` | varchar | There is no `metadata` column |

### `meeting_bookings`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `session_id` | varchar FK (idx) | CASCADE |
| `bot_id` | int FK | CASCADE |
| `booking_url` | varchar | The provider link that produced the booking |
| `meeting_time` | timestamp | Scheduled slot |
| `attendee_email` | varchar | |
| `status` | varchar | Booking state |

The provider itself (`calendly` / `zcal` / `calcom`) is configured per bot in `bots.meeting_provider`; this table has no `provider` or `booking_id` column.

## Billing domain

### `plans`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `slug` | varchar **UNIQUE** | `free`, `standard`, … |
| `name`, `description` | varchar / text | |
| `monthly_price_cents`, `annual_price_cents` | int | Minor units. **BASE price, exclusive of GST**: a domestic charge is this plus tax |
| `currency` | varchar | `INR`, `USD` |
| `credits_per_month` | int | Plan grant |
| `included_operator_seats` | int | |
| `extra_seat_price_cents`, `extra_seat_price_usd_cents` | int | BASE price, exclusive of GST |
| `monthly_price_usd_cents`, `annual_price_usd_cents` | int | Fixed USD headline pricing, set deliberately — **never converted live** |
| `features` | jsonb | Per-plan feature toggles (the column is `features`, not `feature_flags`) |
| `limits` | jsonb | `ai_messages`, `url_scans`, `knowledge_pages`, `knowledge_characters`, `storage_mb`, … (the column is `limits`, not `usage_limits`) |
| `trial_days` | int | Exactly one seeded row is non-zero: the non-public `trial` plan. Every purchasable tier is 0; the `7` default is historical |
| `pricing_model` | varchar | `per_operator` / `flat` / `custom` |
| `razorpay_plan_id_monthly`, `_annual`, `_monthly_usd`, `_annual_usd` | varchar | Four ids: a Razorpay plan's currency is fixed at creation, so INR and USD need separate plans. **There are no Stripe columns** |
| `annual_discount_percent` | int | DERIVED, never authored — no read path serves it |
| `marketing` | jsonb | Public pricing-page copy |
| `is_active`, `is_default`, `is_public`, `sort_order` | bool / int | `is_public=false` marks rows that must exist and be assignable but never shown or bought (the signup trial) |

### `subscriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `plan_id` | int FK | RESTRICT (no plan delete with active subs) |
| `bot_id` | int FK | Per-bot billing. NULL = legacy client-level subscription |
| `status` | varchar | `trialing`, `active`, `past_due`, `canceled`, `expired`. `trial_expired` is **legacy** — see the [Subscription FSM](/05-state-machines/subscription) |
| `billing_cycle` | varchar | `monthly`, `annual` (the column is `billing_cycle`, not `cycle`) |
| `payment_provider` | varchar | `razorpay` \| `manual` (the column is `payment_provider`, not `provider`) |
| `razorpay_subscription_id`, `razorpay_customer_id`, `prev_razorpay_subscription_id` | varchar | Gateway refs |
| `current_period_start`, `current_period_end` | timestamp | |
| `last_granted_period_end` | timestamp | Monotonic marker making the per-period credit grant idempotent |
| `cancel_at_period_end`, `canceled_at`, `cancel_reason` | bool / timestamp / varchar | A reversible customer **intent** |
| `gateway_cancel_executed_at` | timestamp | The irreversible Razorpay cancel. Deliberately separate from the intent above |
| `operator_quantity` | int | Operator seats (the column is `operator_quantity`, not `seats`) |
| `seat_addon_subscription_id`, `seat_addon_quantity`, `branding_addon_subscription_id`, `branding_addon_active` | mixed | Add-ons bill on their **own** subscriptions, never as quantity on the main plan |
| `scheduled_plan_id`, `scheduled_billing_cycle`, `scheduled_change_at` | mixed | Queued downgrade |
| `trial_start`, `trial_end`, `trial_emails_sent`, `dunning_emails_sent`, `past_due_since` | mixed | Trial + dunning cadences, each with a JSONB idempotency map |
| `data_retention_until` | timestamp | **Legacy** — nothing writes a timestamp here any more |

Partial unique indexes enforce "at most one live subscription per scope": `ix_subscriptions_client_legacy_active` (`WHERE bot_id IS NULL AND status IN active/trialing/past_due`) and `ix_subscriptions_client_bot_active` for per-bot rows.

### `usage_records`

One row per (client, period); counters update through period.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `plan_id` | int FK | SET NULL |
| `period_start`, `period_end` | timestamp | |
| `ai_messages_used` / `_limit`, `url_scans_used` / `_limit`, `live_chat_messages_used` / `_limit`, `email_summaries_*`, `email_notifications_*` | int | Counters are `*_used`, each paired with the limit that applied |
| `bots_count`, `operators_count`, `storage_used_mb`, `storage_limit_mb` | int | |
| `overage_messages`, `overage_amount_cents` | int | |

### `invoices`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `subscription_id` | int FK | SET NULL |
| `bot_id` | int FK | Per-bot billing |
| `amount_cents`, `currency`, `status`, `refunded_minor` | int / varchar | |
| `period_start`, `period_end`, `paid_at` | timestamp | |
| `razorpay_payment_id` | varchar **UNIQUE** | The synchronous verify path and the webhook cannot double-invoice one capture |
| `invoice_url`, `pdf_url`, `invoice_number`, `invoice_type`, `issued_at` | varchar / timestamp | Issued by OyeChats, not by the gateway |
| `seller_snapshot`, `buyer_snapshot`, `place_of_supply`, `supply_kind` | jsonb / varchar | Frozen identity at issue time |
| `taxable_value_minor`, `tax_rate_bps`, `cgst_minor`, `sgst_minor`, `igst_minor`, `total_tax_minor`, `hsn_sac`, `is_export` | int / bool | GST breakdown |
| `inr_amount_minor`, `fx_rate_micros`, `fx_rate_source` | int / varchar | INR equivalents for a USD invoice |
| `credit_note_of_id` | int FK | Section 34 credit note against the original |
| `irn`, `signed_qr` | varchar | e-invoicing fields |

### `payment_methods`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK (idx) | CASCADE |
| `provider` | varchar | `razorpay` |
| `type` | varchar | `card`, `upi`, `bank` |
| `last4`, `network`, `issuer`, `upi_handle` | varchar | Display |
| `razorpay_token_id`, `razorpay_customer_id` | varchar | Gateway refs (there is no `provider_method_id`) |
| `is_default`, `synced_at` | bool / timestamp | |

### `credit_ledger`

Append-only event log; **the** source of truth for credit balance.

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `client_id` | int FK | CASCADE |
| `bot_id` | int FK | **Ledger scope.** Non-NULL = this bot's isolated ledger; NULL = the client pool |
| `attributed_bot_id` | int FK | **Reporting only.** Answers "which bot spent it?" for pooled accounts. Summing balances on this column would corrupt both the pool and the per-bot balance |
| `delta` | int | Signed; +grant, –deduction |
| `reason` | **native PG enum `credit_reason`** | `plan_grant`, `topup`, `ai_chat`, `url_scan`, `email_send`, `manual_adjust`, `refund`, `expiry`, `document_upload`, `email_verification`, `company_name`, `translation`. It must be declared as the enum, not a `String`: a multi-row flush at a FIFO boundary goes through insertmanyvalues, which binds VARCHAR and Postgres rejects |
| `grant_id` | int FK → credit_ledger.id | SET NULL — links a deduction to the grant it consumed |
| `idempotency_key` | varchar | Opt-in, globally unique per billable unit of work; only the crawl path sets one (`ingest:{client}:{bot}:{job}:{url_sha}`). Backed by a partial unique index on negative deltas |
| `reference_id` | int | Coarse audit label — bot_id / document_id / invoice_id depending on `reason`. Polymorphic, so never group on it |
| `expires_at` | timestamp | NULL for plan grants **and** for top-ups while `pricing_config.topup_expiry_months` is `0` (the shipped default = lifetime) |
| `note` | text | Free-form |
| `created_by` | int FK → clients.id | SET NULL — who initiated (super-admin for manual) |

### `pricing_config`

Super-admin tunable key/value.

| Column | Type | Notes |
|---|---|---|
| `key` | text **PK** | `credit_cost.ai_chat`, `credit_cost.url_scan`, `topup_expiry_months`, `topup_packs`, `kill_switch`, `crawl.provider_primary`, the gate model, … There is **no `id` column** — `key` is the primary key |
| `value` | jsonb | Anything |
| `updated_at` | timestamp | |
| `updated_by` | int FK → clients.id | SET NULL |

### `processed_webhooks`

Idempotency for inbound provider webhooks.

| Column | Type | Notes |
|---|---|---|
| `event_id` | text **PK** | Single-column primary key |
| `provider` | text (idx) | `razorpay`. Indexed, but **not part of the PK** |
| `payload_digest` | text | Partial-unique second dedup key. The HMAC covers only the body and the event id is a header, so a replayed signed body with a fresh id would otherwise pass both checks |
| `processed_at` | timestamp | The column is `processed_at`, not `received_at` |

A sibling table, `failed_webhooks`, is the dead-letter store for billing webhooks whose processing failed.

## Webhook (outbound) domain

### `webhooks`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `bot_id` | int FK (idx) | CASCADE |
| `url` | varchar | HTTPS only |
| `secret` | varchar | HMAC-SHA256 key |
| `events` | jsonb | List of events to subscribe (the column is `events`, not `event_filter`) |
| `is_active` | bool | The column is `is_active`, not `active` |

### `webhook_deliveries`

| Column | Type | Notes |
|---|---|---|
| `id` | int **PK** | |
| `webhook_id` | int FK (idx) | CASCADE |
| `event_type` | varchar | `tier_transition` / `lead_captured` / `handoff_requested` / `chat_closed` / `meeting_booked` |
| `payload` | jsonb | The exact envelope that was signed and sent |
| `attempt` | int | 1–5. **One row per attempt** — rows are appended, never updated |
| `status_code` | int | HTTP status. `0` means the request never left (SSRF block or transport failure) |
| `response_body` | text | Truncated to 1000 chars |
| `next_retry_at` | timestamp | Set ⇒ a retry is owed. Cleared only **after** the re-enqueue returns |
| `delivered_at` | timestamp | Set ⇒ delivered |

There is **no `status` column** and no `response_code`. State is derived: delivered = `delivered_at IS NOT NULL`; retry pending = `next_retry_at IS NOT NULL`; abandoned = neither, at `attempt = 5`.

## Why this matters

When a bug is "a column is wrong," start here — but confirm against `models.py`, which is the only authority and which carries 26 tables this page does not cover. When a query is slow, the index notes tell you whether the right column is indexed. When a model changes, this page is part of the same PR.
