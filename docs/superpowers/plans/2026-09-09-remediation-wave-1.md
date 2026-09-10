# Wave 1: Measurement and the Cheap P0s

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make answer quality measurable, and close the four open findings that lose data, money, or every turn for one bot.

**Architecture:** Nothing here changes what the chatbot says. It makes the chatbot's behaviour observable (eval, judge set, per-message refusal reason), moves the qualification pipeline off a pool that drops jobs on deploy, and rejects input that currently crashes a turn.

**Tech Stack:** pytest, GitHub Actions, ARQ on Redis, Alembic, pydantic v2, React + vitest.

**Findings closed:** M-1, M-2, M-3, M-4, U-1, U-2, U-3, U-4, U-9, U-10, U-11, O-11, R-5, R-6.

**Checks after every task:** `cd api && uv run ruff check . && uv run ruff format .` then the task's pytest selection.

---

### Task 1: The nightly eval actually runs (M-1)

The job errors in 15 seconds with `--api-url is required`. `EVAL_API_URL` and `EVAL_BOT_KEY` exist as repository **variables** (created 2026-09-08), but the workflow reads them from `secrets`, which yields an empty string.

**Files:**
- Modify: `.github/workflows/eval-nightly.yml`

- [ ] **Step 1: Confirm the mismatch**

```bash
gh variable list | grep EVAL
gh secret list | grep EVAL || echo "not secrets"
grep -n "EVAL_API_URL\|EVAL_BOT_KEY" .github/workflows/eval-nightly.yml
```
Expected: both listed as variables, absent from secrets, and referenced as `${{ secrets.EVAL_* }}` in the workflow.

- [ ] **Step 2: Point the workflow at variables**

Replace every `${{ secrets.EVAL_API_URL }}` with `${{ vars.EVAL_API_URL }}` and the same for `EVAL_BOT_KEY`. Update the header comment block (lines 10-11) from `# Secrets:` to `# Variables:`.

- [ ] **Step 3: Fail loudly instead of silently**

Add a guard step before the eval run so an unset value is a named failure rather than an argparse error:

```yaml
      - name: Check the eval target is configured
        run: |
          test -n "${{ vars.EVAL_API_URL }}" || { echo "::error::EVAL_API_URL repo variable is unset"; exit 1; }
          test -n "${{ vars.EVAL_BOT_KEY }}" || { echo "::error::EVAL_BOT_KEY repo variable is unset"; exit 1; }
```

- [ ] **Step 4: Dispatch and read the report**

```bash
gh workflow run eval-nightly.yml && sleep 300 && gh run list --workflow eval-nightly.yml --limit 1
```
Expected: the run completes with a per-category table in the job summary. It may still FAIL the 80% gate. That is the baseline, not a reason to change the threshold.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/eval-nightly.yml
git commit -m "fix(eval): the nightly job read variables as secrets, so it errored in 15 seconds"
```

---

### Task 2: The golden set covers the question class that failed (M-2)

The live failure was "what does cleanstart do". The golden set has ten categories and none of them is "what is this company".

**Files:**
- Modify: `api/eval/golden_set.jsonl`
- Modify: `api/eval/golden.py` (`MINIMUM_COVERAGE`)
- Test: `api/tests/test_eval_harness.py`

- [ ] **Step 1: Write the failing coverage test**

In `api/tests/test_eval_harness.py`, extend the coverage assertions with a `company` minimum of 5.

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_eval_harness.py -q`
Expected: FAIL, `company` missing from the shipped set.

- [ ] **Step 3: Add five cases**

Append to `api/eval/golden_set.jsonl`, one JSON object per line, category `company`, each with `expected_facts` verifiable in `api/eval/fixtures/acme/`:

```json
{"id":"company-01","category":"company","question":"what is Acme Analytics","expected_facts":["analytics consultancy"],"forbidden":["I don't have that specific detail"]}
{"id":"company-02","category":"company","question":"what does Acme do","expected_facts":["analytics consultancy"],"forbidden":["I don't have that specific detail"]}
{"id":"company-03","category":"company","question":"tell me about the company","expected_facts":["analytics consultancy"],"forbidden":["I don't have that specific detail"]}
{"id":"company-04","category":"company","question":"who are you and what do you offer","expected_facts":["analytics"],"forbidden":["I don't have that specific detail"]}
{"id":"company-05","category":"company","question":"what services do you offer","expected_facts":["services"],"forbidden":["I don't have that specific detail"]}
```

Read `api/eval/golden_set.jsonl`'s existing rows first and match their exact field names; the shapes above assume `expected_facts` and `forbidden`, which is what the shipped rows use.

- [ ] **Step 4: Validate offline, then run**

```bash
cd api && uv run python -m eval.run_eval --dry-run
cd api && uv run pytest tests/test_eval_harness.py -q
```
Expected: dry run validates 40 cases; tests pass.

- [ ] **Step 5: Commit**

```bash
git add api/eval api/tests/test_eval_harness.py
git commit -m "test(eval): cover the company-overview question class that failed live"
```

---

### Task 3: A unit eval for the relevance judge (M-3)

The judge decides every refusal and has no regression test of its own. A threshold or prompt change cannot be measured before deploy.

**Files:**
- Create: `api/eval/judge_set.jsonl`
- Create: `api/eval/run_judge_eval.py`
- Test: `api/tests/test_judge_eval_set.py`

- [ ] **Step 1: Write the set**

50 rows of `{"id","question","chunks":[...],"expect":"pass"|"refuse"}`. Seed it from the shipped fixtures plus the live CleanStart phrasings: "what does cleanstart do", "what is cleanstart", "tell me more about the company" all `pass`; "what is the capital of france", "write me a poem", "how do I cook rice" all `refuse`. Include the four adversarial strings from the PR #455 security review as `refuse`.

- [ ] **Step 2: Write the runner**

`run_judge_eval.py` loads the set, calls `relevance_gate.check_relevance` per row with the row's chunks, and reports precision and recall against `expect` plus a per-row table. It takes `--threshold` so a candidate value can be swept without editing code.

- [ ] **Step 3: Write the offline test**

`api/tests/test_judge_eval_set.py` validates the file shape and that both classes are represented, with no network.

- [ ] **Step 4: Run**

```bash
cd api && uv run pytest tests/test_judge_eval_set.py -q
cd api && GOOGLE_API_KEY=... uv run python -m eval.run_judge_eval --threshold 0.3
```
Expected: tests pass; the sweep prints precision/recall at 0.15, 0.3, 0.5 for comparison.

- [ ] **Step 5: Commit**

```bash
git add api/eval api/tests/test_judge_eval_set.py
git commit -m "test(eval): a judge set, so a threshold change is measurable before deploy"
```

---

### Task 4: Persist why a turn was refused (M-4)

A customer reporting "it refused my question" cannot be answered from the dashboard. The gate score and the stage that refused live in a log line.

**Files:**
- Modify: `api/app/db/models.py` (ChatMessage)
- Create: `api/alembic/versions/b1000010answerstatus.py`
- Modify: `api/app/services/rag_service.py` (both pipelines, every canned-return site)
- Test: `api/tests/test_answer_status_persisted.py`

- [ ] **Step 1: Write the failing test**

Drive both pipelines with the harness in `tests/test_on_scope_relax_behaviour.py` and assert that a refused turn persists `answer_status="off_topic_refusal"` and a `gate_score`, that a pivot persists `answer_status="no_info_pivot"`, and that a normal answer persists `answer_status="answered"`.

- [ ] **Step 2: Run it**

Run: `cd api && uv run pytest tests/test_answer_status_persisted.py -q`
Expected: FAIL, `ChatMessage` has no `answer_status`.

- [ ] **Step 3: Add the columns and the migration**

```python
    # Why this turn ended the way it did. NULL on rows written before this
    # existed, and on operator messages. The gate score is the judge's raw
    # verdict, kept so a refusal can be explained without re-running anything.
    answer_status = Column(String(32), nullable=True)
    gate_score = Column(Float, nullable=True)
```
Migration `b1000010answerstatus`, `down_revision = "b1000009pricingkb"`, two nullable columns, `SET lock_timeout = '3s'` first, matching `b1000009pricingkb.py`.

- [ ] **Step 4: Stamp it at every return site**

`add_chat_message` gains `answer_status` and `gate_score` keyword arguments defaulting to None. Every canned return in both pipelines passes one of: `off_topic_refusal`, `no_info_pivot`, `browsing_ack`, `pricing_pivot`, `meeting_pivot`, `intent_router`, `injection_blocked`, `moderation_blocked`, `empty_context`, `name_ask`. The generation path passes `answered`.

- [ ] **Step 5: Run and commit**

```bash
cd api && uv run alembic upgrade head && uv run pytest tests/test_answer_status_persisted.py tests/test_on_scope_relax_behaviour.py -q
git add api && git commit -m "feat(observability): persist why a turn was refused"
```

---

### Task 5: Qualification stops being lost on every deploy (U-1)

`submit_background` is a 3-worker pool shut down with `wait=False`. BANT extraction, the tier-transition webhook and the qualified-lead email are only there.

**Files:**
- Modify: `api/app/worker/tasks.py` (new `task_extract_qualification`)
- Modify: `api/app/worker/settings.py` (register it)
- Modify: `api/app/services/rag_service.py:8637` and the streaming twin
- Modify: `api/app/core/thread_pool.py` (docstring: what may and may not use it)
- Test: `api/tests/test_qualification_is_durable.py`

- [ ] **Step 1: Write the failing test**

Assert that both pipelines enqueue `task_extract_qualification` rather than calling `submit_background` with the extractor, using an AST assertion over both pipeline sources (the pattern in `tests/test_on_scope_relax.py`), plus a unit test that the task function is registered in `WorkerSettings.functions`.

- [ ] **Step 2: Run it**

Expected: FAIL, no such task.

- [ ] **Step 3: Add the task and switch the call sites**

The ARQ task takes the same arguments the pool call takes today and calls the existing extraction function. Keep `submit_background` for the genuinely cosmetic jobs (screenshot refresh, geolocation) and say so in its docstring.

Fallback: when `WORKER_ENABLED` is false, `enqueue_sync` returns None; the call site then falls back to `submit_background` so local development is unchanged. Task 6 makes that state impossible in production.

- [ ] **Step 4: Run and commit**

```bash
cd api && uv run pytest tests/test_qualification_is_durable.py tests/test_worker_tasks.py -q
git add api && git commit -m "fix(qualification): move BANT extraction onto ARQ so a deploy stops dropping lead signals"
```

---

### Task 6: A production boot without a worker is refused (U-3, U-4)

`WORKER_ENABLED` defaults false. Unset in production, outbound webhooks silently become fire-and-forget with no delivery row, and `enqueue_sync` swallows Redis failures.

**Files:**
- Modify: `api/app/worker/enqueue.py`
- Modify: `api/app/main.py` (startup)
- Test: `api/tests/test_worker_enabled_guard.py`

- [ ] **Step 1: Write the failing test**

`APP_ENV=production` with `WORKER_ENABLED` unset raises at startup with a message naming the variable. Outside production it logs a warning and continues. A Redis failure inside `enqueue_sync` increments a counter and logs an error rather than returning None silently.

- [ ] **Step 2: Run, implement, run**

- [ ] **Step 3: Commit**

```bash
git add api && git commit -m "fix(worker): production refuses to boot without a durable queue"
```

---

### Task 7: Enrichment credits are charged for work that happened (U-2)

`chat_routes.py:1014-1023` charges before the vendor call, and the job then runs on the non-durable pool.

**Files:**
- Modify: `api/app/api/chat_routes.py:1014-1023, 1112, 2047`
- Test: `api/tests/test_enrichment_charge_after_persist.py`

- [ ] **Step 1: Write the failing test**

A vendor call that raises must leave the credit balance unchanged. A vendor call that succeeds but whose persist fails must refund.

- [ ] **Step 2: Run, implement (charge after a successful persist, refund on failure with a dead-letter log), run**

- [ ] **Step 3: Commit**

```bash
git add api && git commit -m "fix(billing): charge for enrichment after it is delivered, not before it is attempted"
```

---

### Task 8: Typed JSONB, so one bad save cannot break every turn (U-9)

`bant_config` with `score: "high"` raises inside `build_hybrid_prompt` on every turn; the catch refunds and shows the generic LLM error to the visitor.

**Files:**
- Create: `api/app/schemas/bot_config.py`
- Modify: `api/app/api/bot_routes.py` (validate on write)
- Modify: `api/app/services/qualification_service.py` (validate on read, log-and-default)
- Test: `api/tests/test_bot_config_schemas.py`

- [ ] **Step 1: Read what production actually stores**

```bash
ssh -i ~/.ssh/oyechats_deploy -o IdentitiesOnly=yes root@159.223.45.213 \
  "sudo -u postgres psql -d oyechats -Atc \"select distinct jsonb_typeof(bant_config) from bots where bant_config is not null\""
```
Requires the user's explicit approval for a production read. If it is not given, derive the shapes from `qualification_service.get_framework_config`'s presets instead and note the assumption.

- [ ] **Step 2: Write the failing test**

A `bant_config` whose option score is the string `"high"`, one with a missing `label`, and one that is a list rather than an object must all be rejected at PATCH with a 422 naming the field, and must all produce a working prompt at read time (falling back to the framework preset) rather than raising.

- [ ] **Step 3: Run, implement, run**

`BantConfig`, `FeatureFlags`, `WidgetConfig` and `LanguageConfig` pydantic models. Write path: validate and 422. Read path: `model_validate` inside a try, fall back to the preset, and emit `_safety_net_metric("bot_config_invalid", ...)` so a bad row is visible rather than silent.

- [ ] **Step 4: Commit**

```bash
git add api && git commit -m "fix(bot-config): type the JSONB columns so one bad save cannot break every turn"
```

---

### Task 9: The owner filter raises instead of matching everything (U-10)

`_session_owner_filter` and `_doc_owner_filter` fall through to `client_id IS NULL` when both ids are missing. `_owner_filter` already raises; these two do not.

**Files:**
- Modify: `api/app/db/repository.py:964,978`
- Test: `api/tests/test_repository_owner_filters.py`

- [ ] **Step 1: Write the failing test**, calling each with both ids None and expecting `ValueError`.
- [ ] **Step 2: Run, implement (mirror `_owner_filter`'s raise), run the whole repository suite** to catch any caller that relied on the fall-through.
- [ ] **Step 3: Commit**

```bash
git add api && git commit -m "fix(repository): an unscoped query raises instead of matching every tenant"
```

---

### Task 10: No hard-coded secret default (U-11)

**Files:**
- Modify: `api/app/services/affiliate_service.py:174`
- Test: `api/tests/test_affiliate_salt.py`

- [ ] **Step 1: Write the failing test:** in production, an unset `AFFILIATE_HASH_SALT` raises at import or first use; outside production it may fall back but logs a warning.
- [ ] **Step 2: Run, implement, run. Step 3: Commit.**

---

### Task 11: The dev gallery is not a production route (O-11)

`app/src/app/routes.tsx:121-126` mounts `UiGallery` (3,663 lines) at `/dev/ui` with no auth guard.

**Files:**
- Modify: `app/src/app/routes.tsx`
- Test: `app/src/app/routes.test.tsx`

- [ ] **Step 1: Write the failing test:** the production route table contains no `/dev/ui` entry when `import.meta.env.DEV` is false.
- [ ] **Step 2: Run, implement (wrap the route in `...(import.meta.env.DEV ? [devRoute] : [])`), run.**
- [ ] **Step 3: Verify it left the bundle**

```bash
cd app && npm run build && grep -rl "UiGallery" dist/assets | head
```
Expected: no match.

- [ ] **Step 4: Commit**

```bash
git add app && git commit -m "fix(app): the dev gallery is no longer a public production route"
```

---

### Task 12: Two tripwires that would have caught this session's bugs (R-5, R-6)

**Files:**
- Test: `api/tests/test_repository.py` (extend), `app/src/features/agents/advanced/behaviour.config.test.ts` (extend)

- [ ] **Step 1: `knowledge_state_for_bot` unit test** covering `(0, None)` on an empty corpus, the tuple moving after an insert and after a delete, and the owner scoping.
- [ ] **Step 2: Threshold drift test** in vitest, reading `RELEVANCE_THRESHOLD` out of `api/app/services/relevance_gate.py` and asserting it equals `DEFAULT_RELEVANCE_THRESHOLD`.
- [ ] **Step 3: Run both suites. Step 4: Commit.**

---

### Task 13: Wave close

- [ ] `cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
- [ ] `cd app && npm run lint && npx tsc --noEmit && npx vitest run && npm run build`
- [ ] `gh workflow run eval-nightly.yml`, wait, and record the pass rate in the PR body as the wave-1 baseline.
- [ ] Open the PR `development` → `main` titled "Wave 1: measurement and the cheap P0s".
