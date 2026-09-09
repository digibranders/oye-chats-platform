# Wave 3: Config, Constants and the Safety Net

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** One definition per setting, no dead branches, and a safety net that tells someone when it fails.

**Architecture:** Three layers decide a setting today (env, `config.py`, DB `runtime_config`) and 68 `os.getenv` calls sit outside `config.py`, some of them per request. This wave collapses the duplicates, deletes the flags that have never been set to anything but their default, and turns the two fail-open judges from silent into alerting.

**Findings closed:** M-5, M-6, M-7, M-8, M-9, O-3, O-4, O-14, R-2, R-3, R-4.

---

### Task 1: A fail-open judge pages someone (M-6)

Relevance, moderation and groundedness all return "safe" on any exception. Only relevance increments a counter, and its endpoint has no frontend caller. A gate-model outage silently disables scope enforcement for every bot; this has already happened once for 41 consecutive requests.

**Files:**
- Modify: `api/app/services/relevance_gate.py`, `groundedness_gate.py`, `rag_service.py:2081,2125`
- Modify: `api/app/core/metrics.py` (`forward_to_sentry_if_alertable`)
- Test: `api/tests/test_fail_open_is_alerted.py`

- [ ] **Step 1: Write the failing test:** each of the three fail-open paths increments a named counter and forwards to Sentry once a per-bot threshold of consecutive failures is crossed.
- [ ] **Step 2: Run, implement, run.** Add `moderation_failed_open` and `groundedness_failed_open` counters beside the existing `gate_failed_open`, and add all three to the alertable set.
- [ ] **Step 3: Commit.**

---

### Task 2: Groundedness stops being decoration (M-5)

The judge writes a metric and a Langfuse score. Nothing blocks, nothing surfaces, and a customer cannot see that an answer was ungrounded.

**Files:**
- Modify: `api/app/services/rag_service.py:3540-3586`
- Modify: `api/app/db/models.py` (reuse `ChatMessage.answer_status` from wave 1, add `groundedness_score`)
- Create: `api/alembic/versions/b1000012groundedness.py`
- Test: `api/tests/test_groundedness_is_recorded.py`

- [ ] **Step 1: Write the failing test:** a low-scoring answer persists `groundedness_score` on its message and sets `answer_status="answered_ungrounded"`.
- [ ] **Step 2: Run, implement, run.** Keep it non-blocking for now: recording it is what makes the "Unverified answers" surface possible without risking a rewrite mid-stream. Blocking is a wave-7 product decision, not a mechanical fix.
- [ ] **Step 3: Commit.**

---

### Task 3: Delete the flags nobody has ever set (O-3)

Thirteen boolean flags are never set off their default anywhere in the repo, the deploy workflow or the docs, each with a dead branch behind it. `GATE_MODEL` and `EMBED_PROVIDER` are dead constants. Two ARQ tasks are registered and never enqueued.

**Files:**
- Modify: `api/app/config.py`, `api/app/services/relevance_gate.py:83`, `api/app/ingestion/embedder.py:44`, `api/app/worker/tasks.py:133,187`
- Test: `api/tests/test_no_dead_flags.py`

- [ ] **Step 1: Confirm each one is genuinely unset everywhere**

```bash
for f in LANGFUSE_FORCE_DISABLE SENTRY_FORCE_ENABLE EXPO_PUSH_ENABLED IMPERSONATION_ENABLED \
         DEV_AUTO_VERIFY_EMAIL WEBHOOK_RETRY_ON_ERROR PRORATED_UPGRADES_ENABLED \
         INVOICING_V2_ENABLED INVOICE_EMAILS_ENABLED EVENT_EXTRACTION_ENABLED \
         CRAWL_STREAM_INGEST_ENABLED GROUNDEDNESS_CHECK_ENABLED MODERATION_ENABLED; do
  echo "== $f"; grep -rn "$f" --include='*.yml' --include='*.env*' --include='*.md' . | grep -v node_modules | head -3
done
```
A flag that appears in the deploy workflow with a non-default value stays. `MODERATION_ENABLED` and `GROUNDEDNESS_CHECK_ENABLED` are hardcoded true in the deploy, so keep the variable and delete only the false branch if it is unreachable; do not delete the safety check itself.

- [ ] **Step 2: Write the failing test:** `config.py` declares no flag whose name is absent from both the deploy workflow and `.env.example`.
- [ ] **Step 3: Run, delete, run the full suite. Step 4: Commit.**

---

### Task 4: One default per value (O-4)

The relevance threshold had three defaults across three files (fixed in wave 1's predecessor). The seat price still has three: 49900 in `config.py:375`, 1500 in `credit_service.py:205`, 1500 in `models.py:1760`.

**Files:**
- Modify: `api/app/config.py:375`, `api/app/services/credit_service.py:205`, `api/app/db/models.py:1760`
- Test: `api/tests/test_single_source_of_truth.py`

- [ ] **Step 1: Write the failing test:** for each of seat price, relevance threshold, chunk size and rerank top-n, every module that names a default resolves to the same number.
- [ ] **Step 2: Run, implement (one constant, imported), run. Step 3: Commit.**

---

### Task 5: Settings are read once (O-14)

`APP_ENV` and `CORS_ORIGINS` are read from the environment on every origin check; `CAG_LITE_THRESHOLD` on every chat turn.

**Files:**
- Modify: `api/app/core/middleware.py:311-313,362`, `api/app/services/rag_service.py:7660,9434`
- Test: `api/tests/test_settings_read_once.py`

- [ ] **Step 1: Write the failing test:** `os.getenv` is not called inside the request path for these three, asserted by monkeypatching `os.getenv` to raise and driving one request and one chat turn.
- [ ] **Step 2: Run, implement (module-level constants, or `config` attributes), run. Step 3: Commit.**

---

### Task 6: Structured logs and request ids (M-8, M-9)

**Files:**
- Modify: `api/app/main.py:93` (formatter), add middleware
- Modify: `api/app/services/translation_service.py`, `api/app/ingestion/event_extractor.py` (Langfuse spans)
- Test: `api/tests/test_request_id_middleware.py`

- [ ] **Step 1: Write the failing test:** every response carries an `X-Request-ID` header, and a log line emitted during that request carries the same id as a field.
- [ ] **Step 2: Run, implement, run.** JSON formatter behind `LOG_FORMAT=json`, defaulting to json in production and text locally.
- [ ] **Step 3: Wrap the two untraced LLM calls in `langfuse_generation`. Step 4: Commit.**

---

### Task 7: Per-bot cost survives the day (M-7)

Token counters live in Redis with a 26-hour TTL, so there is no durable per-bot spend.

**Files:**
- Create: `api/app/db/models.py` `BotUsageDaily` (bot_id, day, input_tokens, output_tokens, llm_calls, gate_calls)
- Create: `api/alembic/versions/b1000013botusage.py`
- Modify: `api/app/core/metrics.py`
- Test: `api/tests/test_bot_usage_daily.py`

- [ ] **Step 1: Write the failing test:** two turns on one bot on one day produce one row with summed tokens; a turn on another bot produces its own row.
- [ ] **Step 2: Run, implement (upsert on (bot_id, day)), run. Step 3: Commit.**

---

### Task 8: The three small deferred items (R-2, R-3, R-4)

- [ ] **R-4:** raise `GROUNDEDNESS_CHUNK_PREVIEW_CHARS` to 1000 so it mirrors the relevance gate as its comment claims, and apply the same total-character budget. Test: the groundedness prompt for 20 chunks stays inside the budget.
- [ ] **R-3:** rename `_apply_model_family_kwargs` to `apply_model_family_kwargs` and update its four importers. It has been public by use for a long time.
- [ ] **R-2:** coarsen the knowledge fingerprint so a re-crawl does not miss the cache on every inserted chunk: use `Bot.indexed_chunk_count` plus the ingest-completion timestamp rather than `max(Document.id)`. Test: the fingerprint is stable across two inserts within one ingest run and changes when the run completes.
- [ ] **Commit each separately.**

---

### Task 9: Wave close

- [ ] Full backend and dashboard checks.
- [ ] Confirm the eval is unchanged: this wave should move no answer.
