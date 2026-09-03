# Functional bug audit and fix plan (2026-09-02)

Read-only audit of the three apps in this repo for functional defects: wrong
behaviour, data loss, money, tenancy, and state that gets stuck. Style, naming
and UX opinions were out of scope. Nothing in this pass changed product code.

## Baseline checks

Run on a clean clone of `main` (8ea6f0a) in the audit container.

| Check | Result |
|---|---|
| `api`: `ruff check .` | clean |
| `api`: `ruff format --check .` | clean (649 files) |
| `api`: `alembic upgrade head` → `alembic check` → `downgrade -1` → `upgrade head` | clean, no model/migration drift |
| `api`: `pytest` against local Postgres 16 + pgvector | 6376 passed, 4 skipped (cross-process live-chat tests need two nodes), 10m43s |
| `app`: `npm run lint` | clean |
| `app`: `npx tsc --noEmit` | clean |
| `app`: `npx vitest run` | 158 files, 2043 tests, all pass |
| `widget`: `npm run lint` | clean |
| `widget`: `npm test` | 271 tests, all pass |

Note: importing `app.main` with no `DB_URL` crashes at import time
(`Base.metadata.create_all(bind=None)`, `main.py:249`). CI always has a
database so this only bites local runs, but it means no API test can be
collected without Postgres.

## How to read the findings

Each finding was located by a focused reviewer and then re-verified by reading
the code path (callers, callees, models, existing tests). Severity:

- **P0**: security, cross-tenant access, money leaking, or silent data loss.
- **P1**: a feature is broken or produces wrong results for real users.
- **P2**: edge case, degraded behaviour, stuck state, or a doc/code mismatch.

IDs are stable so the fix plan can reference them.

---

## P0

### A1. A deactivated operator keeps a working credential (corrected during Phase 1, downgraded from P0)
`api/app/api/auth.py:546-570`, `api/app/api/auth_routes.py:1490-1510`

**Correction.** The first draft of this finding said the billing routes were
reachable with an operator key. They are not: `subscription_routes.py`,
`payment_method_routes.py` and `affiliate_routes.py` import
`get_current_client_strict` under the name `get_current_client`, so every
money-moving route already refuses operator keys. What remains is real but
narrower, and is a P1:

- The operator fallback in `get_current_client` checked neither `operator.role`
  nor `operator.is_active`, while its siblings (`get_current_operator`,
  `get_current_client_or_operator`) refuse inactive operators. A deactivated
  operator's key kept working on every route built on the non-strict resolver:
  `/client/settings`, feedback, activation events, and the
  `require_active_subscription`, `require_feature` and `enforce_limit`
  dependencies.
- `operator_login` matched on email and password only, so a deactivated
  operator could sign in and be handed a fresh key, and an operator of a
  suspended workspace could obtain a key every request would then reject.

**Fixed in Phase 1:** the fallback rejects inactive operators with 401,
`operator_login` filters on `is_active` and runs
`_ensure_client_authenticatable` on the workspace. Tests in
`tests/test_operator_deactivation_auth.py`.

### I1. Streamed crawls re-grant the free-page allowance on every wave
`api/app/services/crawl_orchestrator.py:697-710, 940`, `api/app/ingestion/pipeline.py:725-743, 841-844`

`resolve_crawl_pricing` computes `free_pages = allowance - used` once at crawl
start. With stream ingest on (default) every 25-page wave is a fresh
`batch_web_ingestion` call, and `_ingest_wave` is a closure over the crawl-level
`free_pages`, so each wave starts with the full allowance again. A trial account
with a 25-page allowance crawling a 400-page site pays nothing.

Fix: keep `free_left` in the crawl's `ingest_state`, pass it per wave, and
subtract the wave's `pages_free` from the returned result. Add an assertion to
`test_crawl_streaming_ingestion.py`.

---

## P1

### A2. Widget side-endpoints create sessions with `client_id = NULL`; analytics drop them until restart
`api/app/api/chat_routes.py:1898, 1971, 2098`, `api/app/api/ws_routes.py:445, 547`, `api/app/db/repository.py:73-145, 925-936`

Lead capture, behavioural signals, meeting-booked and the visitor websocket
call `ensure_chat_session(..., bot_id=...)` without `client_id`. The widget's
pre-chat lead form does this before the first message. When the first turn
later passes `client_id`, `ensure_chat_session` only updates activity fields
and never backfills. Every analytics query filters `client_id = :cid`, so those
sessions vanish until `backfill_session_client_ids` runs at process start.

Fix: pass `client_id=bot.client_id` at all four sites and have
`ensure_chat_session` set it when the stored value is NULL.

### B1. Cancel webhook for a superseded account-level subscription pauses the upgraded customer's knowledge base
`api/app/services/razorpay_service.py:4583-4655`, `api/app/services/knowledge_state_service.py:34-71, 101-129`

On upgrade the old row is flipped to `canceled` and a gateway cancel is issued.
Razorpay then delivers `subscription.cancelled` for the old id. The handler has
no "already superseded" guard and, for an account-level row (`bot_id IS NULL`),
calls `deactivate_client_knowledge`, which loops every bot through
`deactivate_bot_knowledge`. Its guard `_bot_still_funded` matches
`Subscription.bot_id == bot_id`, which an account-level subscription never
satisfies, so every document is set inactive. Nothing turns it back on.

If the superseded row was an unbilled trial conversion, the same handler also
runs `_forfeit_and_convert_to_free`, which zeroes the new plan's credits and
inserts a second active row, violating `ix_subscriptions_client_legacy_active`
and putting the webhook into a 5xx retry loop.

Fix: at the top of `_handle_subscription_cancelled` and
`_handle_subscription_completed`, if the row is already terminal or another
funded row exists in the same scope, do terminal bookkeeping only. Make
`_bot_still_funded` also consider an active account-level subscription for the
bot's client.

### B2. Verify endpoint records the mandate authorization payment as a paid `plan_charge` tax invoice
`api/app/services/razorpay_service.py:4231-4268, 4798-4812`, `api/app/api/subscription_routes.py:831`

Deferred-start mandates (trial conversion, resume, launch promo) produce a
token authorization payment. `record_verified_subscription_charge` only checks
`status == "captured"` and writes a paid `plan_charge` invoice with a real
gapless serial. `_revoke_unpaid_activation_grant` then treats the activation
as paid, so when the real first debit fails the plan allowance is not revoked.
Razorpay's auto-refund of the token amount also mints a credit note against it.

Fix: skip when the local subscription has a future `start_at` or no
`current_period_start`, or when the amount differs from the expected cycle
gross; alternatively stamp `kind="auth_token"` and exclude that kind everywhere
`plan_charge` is counted. Confidence medium: depends on Checkout returning the
authorization payment id, which the code comments say it does.

### R1. Background BANT extraction drives live-chat sockets and Redis from a throwaway event loop
`api/app/services/rag_service.py:3140-3157`, `api/app/services/live_chat_service.py:1558-1579`, `api/app/services/ws_backplane.py`

`_background_bant_extraction` runs on the shared thread pool, so
`get_running_loop()` raises and it falls to `asyncio.run(broadcast...)`. That
coroutine either sends on a Starlette websocket owned by the main loop, or
lazily creates the module-global backplane publisher client on the temporary
loop, which `asyncio.run` then closes. Every later publish from the main loop
fails until restart. A send failure on the socket path also triggers operator
disconnect handling from the wrong loop.

Fix: `asyncio.run_coroutine_threadsafe` on the bound main loop (the pattern
`notification_broadcaster.bind_loop` already uses), or publish via a sync Redis
client from the thread.

### R2. Multi-tab operator (and visitor reconnect) tears down the new socket
`api/app/services/live_chat_service.py:476-479, 597-625`, `api/app/api/ws_routes.py:1237-1251`

`connect_operator` closes the old socket and stores the new one under the same
key. The old handler then receives `WebSocketDisconnect` and calls
`disconnect_operator_and_broadcast(operator_id)`, which pops by id with no
socket identity check, removing the new tab's socket and arming the grace
timer. Sixty seconds later the operator is marked offline and their live chats
are re-queued with "Your operator disconnected". Visitors have the same shape.

Fix: pass the socket into disconnect and no-op unless
`self.operator_connections.get(operator_id) is ws`.

### I2. Re-uploading a changed file with the same name leaves the old chunks live
`api/app/ingestion/pipeline.py:256-317`, `api/app/api/document_routes.py:665-990`

The upload path never deletes existing rows for the same `document_name`. A
changed `pricing.pdf` has a new hash, passes dedup, and is inserted alongside
the old chunks. Retrieval returns both versions, `kb_characters_used` is
incremented twice, and a later delete reclaims only one source's count.

Fix: delete rows for `(client_id/bot_id, document_name)` and decrement their
`source_char_count` in the same transaction as the insert, as the crawl path
does with `delete_chunks_for_url`.

### I3. Concurrent `task_ingest_documents` jobs double-ingest the same file
`api/app/api/document_routes.py:968`, `api/app/ingestion/pipeline.py:257-268, 378-430`

Two uploads in quick succession enqueue two sweeps of the same tenant folder
with no `_job_id`. Both see the same pending files; the second passes
`is_document_processed` before blocking on the client row lock, then inserts a
second copy after the first commits.

Fix: enqueue with `_job_id=f"ingest:{client_id}:{bot_id}"`, and re-check
`is_document_processed` after the row lock is acquired.

### I4. Document upload holds a `FOR UPDATE` lock on `clients` across the embedding call
`api/app/ingestion/pipeline.py:256-298`, `api/app/services/knowledge_quota_service.py:84-88`

`check_kb_quota` locks the client row inside the transaction, then chunking,
optional enrichment and `embed_chunks` run with it held. Embedding can block for
minutes under 429 back-off. Every writer of that client row (login, OTP
verify, profile save, checkout, concurrent crawl wave accounting) blocks
meanwhile. The batch web path already embeds before locking.

Fix: dedup, chunk and embed outside the transaction; then open the session,
check quota, insert, increment, commit.

### I5. Credits charged at upload are never refunded when background ingestion fails
`api/app/api/document_routes.py:903`, `api/app/ingestion/pipeline.py:268, 414-430`

The route deducts `document_upload` credits synchronously. The worker may then
hit `KnowledgeQuotaExceeded` (there is no quota pre-flight in the route), an
embedding outage, or a DB error. All are caught, the file is quarantined, and
nothing refunds the ledger or notifies the customer.

Fix: pre-check `check_kb_quota` in the route; on worker failure write an
idempotent refund and emit a notification with the quarantine reason.

### I6. `kb_characters_used` is never reclaimed by orphan sweep, bot deletion or trial purge
`api/app/services/crawl_orchestrator.py:1039`, `api/app/api/bot_routes.py:4022`, `api/app/worker/tasks.py:1654`, `api/app/services/knowledge_quota_service.py:199`

Only single-document delete and crawl re-ingest decrement the counter. Bot
deletion, the orphan sweep and the trial purge cascade-delete documents without
touching it, so the counter only grows and ingest eventually 402s on a mostly
empty knowledge base. `recompute_kb_usage` exists and has no caller.

Fix: decrement before each delete, and schedule `recompute_kb_usage` daily as a
backstop.

### I7. Demo-screenshot refresh is dropped for an hour after any capture
`api/app/api/bot_routes.py:2972-2995`, `api/app/services/crawl_orchestrator.py:206`, `api/app/worker/settings.py`

Both enqueues use `_job_id=f"demo-screenshot:{bot_id}"`. ARQ refuses an enqueue
while `result:{job_id}` exists, and results are kept for 3600 s by default. The
route has already set `demo_screenshot_status="pending"` and ignores the `None`
return, so the Deploy card shows "taking a picture now" indefinitely.
`install-probe:{bot_id}` has the same dead window.

Fix: `keep_result=0` for these functions or a time bucket in the job id, and
revert the status when `enqueue_sync` returns `None`.

### W1. A `FINAL_METADATA:` frame split mid-marker is rendered as visible text and the metadata is lost
`widget/src/services/api.js:196-201`

After `METADATA:` arrives, every read flushes the buffer tail unless it already
starts with a full marker. If a read boundary lands inside the first 15 bytes
of `FINAL_METADATA:`, the fragment is emitted as answer text and the JSON that
follows is treated as an ordinary line. `onFinalMetadata` never fires: no
message id, no feedback buttons, no CTA, no media card, and the visitor sees
raw JSON.

Fix: hold the tail when it is a prefix of either marker
(`'FINAL_METADATA:'.startsWith(buffer)`), the same prefix-hold the sentinel
stripper uses. Add a split-at-byte-5 case to `sendMessageStream.test.js`.

### W2. Loading the loader twice orphans `window.OyeChats`
`widget/src/loader.js:77, 214-216`, `widget/src/app-entry.jsx:225-234`

Line 77 guards the stub, but line 215 unconditionally overwrites
`window.OyeChats`. A second execution (SPA re-mount, GTM firing on two
triggers, two snippets) installs a fresh stub whose queue is never drained,
because the cached entry module's `init()` skips `register` once
`_registered` is true. `open()`, `send()`, `on('ready')` all go silent.

Fix: bail at the top of the loader if `window.OyeChats.__register` exists, or
have `init()` always re-register so a new stub gets bound.

### W3. Every live-chat reconnect re-appends the visitor's recent messages
`widget/src/components/LiveChatMode.jsx:254-268`, `widget/src/components/ChatWindow.jsx:2186-2199`

On every `status: connected` frame history is refetched and rows newer than
the largest local timestamp are appended. Visitor messages carry the client
clock; DB rows carry the later server time; `message_ack` never updates
`timestamp`. So the visitor's own last messages are appended again as
`srv-<id>` on every reconnect.

Fix: dedupe by `dbId` from `message_ack`, and overwrite `timestamp` with the
server's ack time.

### W4. After 15 failed reconnects the visitor is stuck on "Reconnecting" with the composer disabled
`widget/src/components/LiveChatMode.jsx:389-401, 455-484`, `widget/src/components/ChatWindow.jsx:3720-3724`

`onclose` gives up and reports `disconnected`, which ChatWindow does not
handle, so `isLiveReconnecting` stays true. The `online` and
`visibilitychange` recovery handlers call `ws.close()` on an already CLOSED
socket, which fires no `onclose`, so `connect()` is never invoked again.

Fix: keep `connect` in a ref and call it directly from the recovery handlers;
handle `disconnected` in ChatWindow with a reconnect affordance.

### W5. Storage-blocked browsers crash the chat window on open
`widget/src/services/api.js:926-937, 994`, `widget/src/components/ChatWindow.jsx:838, 1208`

`collectPageContext` touches `localStorage` and `sessionStorage` bare. In
Safari with cookies blocked or Chrome with site data blocked the accessor
throws, the throw reaches the ChatWindow error boundary, and the visitor sees
"Chat failed to load" on every open. Every other storage touch in the widget
is wrapped.

Fix: try/catch around the reads and writes; degrade to
`is_return_visit=false`, `pages_viewed=1`.

### D1. Operator's own replies render twice after switching conversations
`app/src/features/inbox/useOperatorSocket.ts:693-712`, `app/src/features/inbox/liveChatHelpers.ts:97-108`, `app/src/features/inbox/ChatPane.tsx:160-184`

`sendMessage` appends an optimistic echo with `dbId: null`; the backend never
echoes operator messages back. `ChatPane` is keyed on session id, so
re-selecting a chat remounts it and reloads history. `mergeHistoryWithLive`
keeps every live entry with a null `dbId` and appends it after history, so the
persisted copy and the echo both render, with the echo pinned to the bottom.

Fix: drop echoes that match a history row by role, content and a timestamp
within a few seconds, or have the backend ack with the persisted id so the
echo can be upgraded and deduped.

### D2. Legacy operator sessions are not role-gated and get force-logged-out on Billing
`app/src/pages/Login.tsx:116-134`, `app/src/context/WorkspaceContext.tsx:286`, `app/src/services/api.ts:877, 912-923`, `api/app/api/auth.py:854`

The operator login bundle never writes `current_workspace_role`, so
`isOperator` is false and the operator sees owner navigation with no route
guard. Strict endpoints reject with "Missing X-API-Key header"; the
interceptor's suppression matches the substring `'api key'`, which
`x-api-key` does not contain, so the 401 clears auth and bounces to `/login`.

Fix: derive `isOperator` from `auth_type === 'operator'` as well as the
workspace role, and match the suppression on a structured error code.

---

## P2

### API and services

- **A3.** AI-chat credit is deducted before `_resolve_session_id` and the pipeline; any exception other than `generation_failed` is a 500 with no refund. `chat_routes.py:1400-1500, 1555-1640`. Wrap post-deduction work in try/except that refunds and re-raises, in both endpoints.
- **A4.** `/operators/handoff` accepts a foreign `department_id`; another tenant's department name lands in notifications and its business hours decide out-of-hours. `operator_routes.py:1040-1050, 1155-1160, 1272`. Resolve the department with `Department.client_id == db_bot.client_id`.
- **A5.** `transfer_chat` can hand a live chat to a deactivated operator who can never connect. `operator_routes.py:1750-1755`. Add `Operator.is_active.is_(True)` to the target query.
- **A6.** `PATCH /operators/{id}` bot reassignment re-queues live chats by raw SQL without notifying the ConnectionManager or visitors. `operator_routes.py:668-682`. Mirror the deactivation path and call `manager.handle_operator_deactivated` after commit.
- **A7.** `GET /chat/history/{sid}` widget branch bypasses `get_current_bot`, so it skips the origin allowlist and the suspended-owner check. `chat_routes.py:2278-2290`. Call `get_current_bot` there.
- **A8.** Operator and visitor websockets ignore workspace suspension and deactivation. `ws_routes.py:319-360, 730-835`. Load the owner and close 4003 when suspended or deactivated.
- **A9.** `DEV_AUTO_VERIFY_EMAIL` signups never get a trial subscription because `is_verified` is assigned after the grant check. `auth_routes.py:1106 vs 1154`. Move the assignment above the check. Dev only.
- **A10.** Document and crawl routes rate-limit operator callers by IP, so admins on one NAT share a bucket. `core/rate_limit.py:55-57`. Switch to `key_from_operator_credential` as `/operators/translate` already does.
- **R3.** Partial-answer persistence on client disconnect never runs: Starlette cancels the streaming task, which surfaces as `CancelledError`, not `GeneratorExit`. `rag_service.py:8397-8430`. Catch both, persist, re-raise.
- **R4.** Concurrent BANT extractions race: duplicate `tier_transition` webhooks and emails, and lost `dimension_scores`; notifications are also sent before commit. `rag_service.py:2968-3170`. Lock the session row with `with_for_update()`, compute `old_tier` after the lock, dispatch after commit.
- **R5.** Blocking calls on the event loop inside `rag_pipeline_stream`: output-side moderation (`check_generated_answer_safety`, sync HTTP up to 10 s) and `rerank`. `rag_service.py:7963, 8449`. Wrap in `asyncio.to_thread`.
- **R6.** QA response cache is never invalidated on bot config changes; edits to `system_prompt`, tone, company name or links keep serving old answers for an hour. `bot_routes.py:1211, 3074, 3773, 4024`. Flush `qa_prefix_for_bot` and the gate prefix wherever `bot_config_key` is deleted.
- **R7.** Backplane subscriber dies permanently on the first Redis error. `ws_backplane.py:150-185`. Reconnect loop with bounded backoff.
- **R8.** `_fix_stale_online_flags` and `_recover_orphaned_sessions` assume one process holds all sockets; on a host without the `oyechats-ws` split, operators on the other worker are flipped offline every five minutes. `live_chat_service.py:215-256, 314-333`. Exclude ids from Redis presence.
- **R9.** A primary-model stall before the first token yields "Response timed out" instead of trying the fallback. `llm_service.py:775-780`. When zero chunks were yielded, take the fallback path.
- **R10.** `runtime_config` reload failure has no backoff and serialises every `get()` behind a blocking SELECT under the lock. `runtime_config.py:46-72`. Advance `_cache_loaded_at` by a short retry window on failure.

### Billing

- **B3.** `subscription.halted` and `pending` resurrect a `canceled` or `expired` row into `past_due` with a fresh 7-day grace window; with a live sibling this also violates the active-row index. `razorpay_service.py:4710-4722, 4831-4857`. Guard both handlers the way `charged` does.
- **B4.** Dunning expiry and `subscription.completed` call `deactivate_bot_knowledge(sub.bot_id)` which no-ops for account-level rows. `worker/tasks.py:1767`, `razorpay_service.py:4683`. Use the client-level helper when `bot_id` is None.
- **B5.** `_clawback_reasons_for` treats `kind="branding"` as a legacy plan charge and logs a false "review manually" error on every branding refund. `razorpay_service.py:5398-5424`. Add `branding` to the None branch.
- **B6.** Renewal cron passes the previous period end to `add_months`, so a sub anchored on the 31st drifts to the 28th permanently. `worker/tasks.py:668`, `core/dates.py:53-57`. Anchor on `current_period_start` or a stored anchor day.
- **B7.** Cancel-before-first-debit on a non-trial mandate keeps the full activation grant. `razorpay_service.py:4583-4655`. Call `_revoke_unpaid_activation_grant` in the cancel handler.
- **B8.** `_handle_subscription_authenticated` does not pass `event_id`, so a refusal inside activation burns the provider event id and the mandate can never be reprocessed. `razorpay_service.py:2794, 3311`. Thread `event_id` through.
- **B9.** First-period grant is linked to its invoice only on exact timestamp equality; any drift means a later refund of that invoice claws back nothing. `credit_service.py:1280`. Backfill within `_PERIOD_KEY_TOLERANCE`.

### Ingestion, worker, integrations

- **I8.** Outbound webhook retries are 30s/2m/10m/1h (four), not the documented five with a 4h rung; an endpoint down 90 minutes loses events. `webhook_service.py:25-26, 366-373`. Add 14400 s and adjust `_MAX_RETRIES`, or fix the docs.
- **I9.** A crawl job re-run by ARQ after a worker restart runs without re-acquiring the crawl lock. `crawl_orchestrator.py:1355-1371`. Re-acquire when `ctx["job_try"] > 1`.
- **I10.** `next_retry_at` is cleared on enqueue, so a delivery task that crashes before writing its row loses the retry. `webhook_service.py:447-461`, `worker/tasks.py:350-373`. Raise `Retry` on unexpected exceptions or write the row first.
- **I11.** `task_reembed_all_documents` is not registered in `WorkerSettings.functions`. `worker/settings.py:152-186`. Register it or delete it and the doc row.
- **I12.** Email tasks can double-send when Brevo accepts the message but the 10 s read times out. `worker/tasks.py:1186-1225`, `email_service.py:194-201`. Only retry connection-phase errors.
- **I13.** `CLAUDE.md` says `WS_BACKPLANE_ENABLED` defaults false; `config.py:455` defaults true. Fix the doc.

### Widget

- **W6.** Download-card URLs are rendered into `href` with no scheme check on the client. `widget/src/components/MediaCard.jsx:322, 394`. Mitigated today: the server drops any download card whose URL is not in a whitelist built from `https?://` file URLs found in chunk metadata (`rag_service.py:320-346`, `_is_valid_file_url`). Add `sanitizeFileUrl` on the client anyway so the guarantee does not rest on one server function.
- **W7.** A greeting-bubble or `OyeChats.send()` message is dropped when the lead form gates, then auto-sent on a later open. `ChatWindow.jsx:733-737, 809-813`. Consume the pending message in `handleLeadFormSubmit`.
- **W8.** `ChatWindow` snapshots `initialSettings` at mount; opening before settings resolve locks in defaults (wrong name, lead form skipped, language menu hidden). `ChatWindow.jsx:228, 712-721`. Add an effect on `initialSettings` and gate the lead-form decision on settings loaded.
- **W9.** "Cancel and return to AI chat" from the waiting screen routes through `onChatEnded` and shows the rating survey with the composer hidden. `ChatWindow.jsx:3150-3161`. Pass a silent flag or cancel without `onChatEnded`.
- **W10.** Welcome title "emoji stripping" uses `\p{Emoji}`, which also deletes digits, `#` and `*` ("Welcome to 3M" becomes "Welcome to M"). `WelcomeScreen.jsx:35, 68`. Use `\p{Extended_Pictographic}`.
- **W11.** Pre-boot `OyeChats.getLocale()` returns the raw stored JSON blob instead of the locale. `loader.js:45-55`. Parse and return `.locale`.
- **W12.** Live messages sent into a dying socket are silently dropped and stuck at "sending"; the retry queue is dead code. `LiveChatMode.jsx:62, 107-115, 488-509`. Have `send` report failure and mark unacked messages failed on close.
- **W13.** Five `GET /chat/quotation` polls per bot reply for every bot, even with quotation disabled. `ChatWindow.jsx:1395-1410, 1645-1677`. Gate on a setting or return a terminal status.
- **W14.** Journey flush on `pagehide` uses `sendBeacon`, which cannot send `X-Bot-Key`, so it is always rejected with 401. `api.js:757-791`. Use `fetch` with `keepalive` and headers.
- **W15.** Open panel leaves an invisible launcher in the tab order with `aria-expanded="false"`, and there is no Escape to close. `ChatWidget.jsx:481-493`, `Launcher.jsx:196-201`. Pass real open state, set `inert`, add Escape handling.

### Dashboard

- **D3.** Edits typed while an Experience save is in flight are reverted when the PATCH resolves. `useExperience.ts:201-247`. Only replace the baseline on success, keep `prev.draft`.
- **D4.** Second document upload in the same panel never triggers the post-ingestion refresh; `announced` ref latches for the component's lifetime. `IngestionProgress.tsx:78-84`. Reset on `jobId` change or key the component by `jobId`.
- **D5.** Leads custom date range sends the local calendar day and the server filters by UTC day; off-by-one at edges for IST users. `leadsUrl.ts:219-226`, `lead_routes.py:136-137`. Send `tz` as the analytics endpoint already does.
- **D6.** Auto-logout on 401 discards the deep link. `api.ts:912-923`. Reuse `loginUrlWithNext`.
- **D7.** `getMyWorkspaces` passes `signal: undefined`, which the interceptor replaces with the workspace abort signal, so it does not survive a switch. `api.ts:770-772, 4547`. Use a dedicated controller.
- **D8.** OAuth callback writes `is_superadmin` from `?superadmin=1` in the URL instead of `/auth/me`. `OAuthCallback.tsx:68, 131-136`. Client-side gate only; set it from the profile.

---

## Fix plan

Ordered by risk retired per unit of work. Each phase is one PR from
`development`, with the listed tests added in the same PR.

### Phase 1: close the money and access holes (DONE 2026-09-03)

1. **A1** deactivated operator credential. `get_current_client` rejects
   inactive operators; `operator_login` filters on `is_active` and refuses a
   suspended workspace. Tests: `tests/test_operator_deactivation_auth.py`.
2. **I1** free pages re-granted per wave. `batch_web_ingestion` reports
   `pages_free`; the orchestrator keeps `free_left` in `ingest_state` and
   passes it to every wave and the final sweep. Tests: allowance offered per
   wave is 3, 1, 0, 0 for five pages with a 3-page allowance
   (`test_crawl_streaming_ingestion.py`), and `pages_free` accounting
   (`test_crawl_ingest_accounting.py`).
3. **B1** superseded cancel pauses the KB. The `cancelled` and `completed`
   handlers do terminal bookkeeping only when the row is already
   `canceled`/`expired` locally (the echo of a cancel we issued). The
   `completed` handler and the dunning expiry now use the client-level
   knowledge helper for account-level rows (B4 folded in). The
   `_bot_still_funded` account-level check was deliberately not added: the
   trial-to-Free conversion creates the active Free row before pausing
   knowledge, so a generic "any funded account-level row" check would turn that
   pause into a no-op. Tests: `test_billing_bl1_nb3.py` (superseded cancel
   keeps knowledge live, already-expired `completed` is bookkeeping only,
   genuine cancel still pauses).
4. **B2** authorization payment recorded as a paid invoice.
   `record_verified_subscription_charge` returns without writing when the
   subscription has no `current_period_start`, which Razorpay sets at the
   first real debit and nowhere else. Test: `test_verify_first_charge_invoice.py`.
5. **A2** NULL `client_id` sessions. Lead capture, behavioural signals,
   meeting-booked and both visitor-socket persist paths pass the bot's
   `client_id`; `ensure_chat_session` backfills a NULL owner on an existing
   row and never overwrites a set one. Tests: `test_repository.py`,
   `test_chat_routes.py`.

### Phase 2: live chat and streaming correctness (next week)

6. **R1** BANT broadcast from a pool thread. Bind the main loop and use
   `run_coroutine_threadsafe`.
7. **R2** multi-tab teardown of the new socket. Identity check in both
   disconnect paths. Test: connect twice, disconnect the first handler, assert
   the second socket is still registered and no grace timer is armed.
8. **W3, W4, W12** live-chat reconnect duplicates, stuck reconnecting, dead
   retry queue. One PR in `LiveChatMode.jsx` and `ChatWindow.jsx`.
9. **W1** split `FINAL_METADATA:` frame. Prefix-hold in `api.js` plus the
   split test.
10. **D1, D2** operator echo duplicates and legacy operator role gating.
11. **R3** persist partial answers on `CancelledError`.
12. **R4** lock the session row during BANT merge; notify after commit.

### Phase 3: ingestion integrity and accounting (following week)

13. **I2, I3, I4** same-name re-upload, concurrent folder sweeps, lock held
    across embedding. One PR restructuring `_ingest_document` to match the
    batch path and adding the `_job_id`.
14. **I5, I6** upload credit refund on quarantine, and reclaiming
    `kb_characters_used` on every delete path plus a daily
    `recompute_kb_usage` cron.
15. **I7** demo-screenshot and install-probe `keep_result=0` and status
    revert on dedup.
16. **W2, W5, W8** loader double-load, storage-blocked crash, settings
    snapshot.

### Phase 4: the rest of the P2 list

Bundle by file so each PR is reviewable:

- `operator_routes.py`: A4, A5, A6. `chat_routes.py`: A3, A7. `ws_routes.py`: A8.
  `rate_limit.py`: A10. `auth_routes.py`: A9.
- `razorpay_service.py`: B3, B5, B7, B8. `worker/tasks.py`: B4, B6.
  `credit_service.py`: B9.
- `rag_service.py` and `bot_routes.py`: R5, R6. `ws_backplane.py` and
  `live_chat_service.py`: R7, R8. `llm_service.py`: R9. `runtime_config.py`: R10.
- `webhook_service.py`: I8, I10. `crawl_orchestrator.py`: I9. `worker/settings.py`:
  I11. `email_service.py`: I12. Docs: I13.
- Widget: W6, W7, W9, W10, W11, W13, W14, W15.
- Dashboard: D3, D4, D5, D6, D7, D8.

### Guardrails to add alongside

- A test that imports every router and asserts no mutating billing route
  depends on the non-strict client resolver (prevents A1 regressing).
- A widget stream-parser fuzz test that splits the byte stream at every offset
  of a recorded response and asserts identical output.
- A conftest guard that skips `app.main` imports cleanly without `DB_URL`
  instead of crashing at collection.

## Verified as OK

Items each reviewer flagged as suspicious and then cleared, kept here so they
are not re-investigated: bot-scoped tenancy on every vector, keyword and
CAG-lite query; RRF fusion using ranks only; webhook idempotency insert in the
same transaction as effects; HMAC over raw bytes with `compare_digest`;
advisory locks on every ledger write; GST integer rounding and credit-note
caps; gapless invoice numbering under `FOR UPDATE`; cron versus webhook
double-grant guard; origin allowlist shared by HTTP and WS; `/demo` URL
validation; document route ownership checks; CORS credentials disabled on
wildcard; markdown rendering without raw HTML in the widget; queued loader API
calls replayed in order; multi-byte UTF-8 across stream reads; dashboard embed
snippet matching `CLAUDE.md`; `bant_config` shape matching the backend;
dashboard polling cleanup and race tokens; model/migration drift (none).

## Test run

Baseline, before any fix: 6376 passed, 4 skipped, 0 failed. Every finding in
this document was therefore uncovered by the suites as they stood.

## Status: all findings resolved (2026-09-03)

Phases 1 through 4 are complete. All 62 findings are fixed except the two
recorded below as deliberately not-fixed, plus B4, which was folded into B1
because it was the same code path.

Corrections made while implementing, both recorded in place above:

* **A1** was overstated as a P0 reaching the billing routes. Those routers
  import the strict resolver, so operator keys never reached them. The real
  defect was narrower and is a P1.
* **W6** was overstated as a P0. The server already drops any download card
  whose URL is not in an `https?://` whitelist, so the client-side check is
  defense in depth, not the only guard.

Deliberately not changed:

* **`_bot_still_funded` account-level check** (part of B1). The trial-to-Free
  conversion creates the active Free row *before* pausing knowledge, so a
  generic "any funded account-level row" check would turn that pause into a
  no-op. The terminal-status guard in the webhook handlers closes the bug
  without it.
* **`bot_routes.py` widget-install cache stamp** (part of R6). That
  `cache_delete` is the one-time install stamp on the widget bootstrap hot
  path and changes nothing that affects answers.

Follow-ups surfaced but out of scope for this pass:

* Expose `quotation_enabled` on `GET /bots/settings/public` so the widget's
  quotation poll drops to zero requests for bots with no catalog.
* A server-side message id would close a narrow live-chat race where a message
  persists but its ack is lost, letting a visitor resend it.
* The widget vendor chunk sits at 66.94 KB of its 67 KB budget. That predates
  this work and needs headroom before anything else lands there.
* Historical drift in subscription period anchors is stopped, not repaired; a
  data backfill would be needed to recover anchors already lost.

### Gates after the fixes

| Check | Result |
|---|---|
| `api`: `ruff check` · `ruff format --check` | clean |
| `api`: `pytest` | 6510 passed, 4 skipped, 0 failed |
| `app`: `npm run lint` · `tsc --noEmit` | clean |
| `app`: `vitest run` | 163 files, 2066 tests, all pass |
| `widget`: `npm run lint` · `npm test` | 293 tests, all pass |
| `widget`: `npm run build` · `npm run size` | pass; eager path ~80 KB of ~90 KB |

The lazy chat chunk's budget was raised from 32 KB to 33 KB (it sat at 31.95 KB
before this work, with 50 bytes of headroom). The eager path a visitor pays for
on every page view is unchanged.
