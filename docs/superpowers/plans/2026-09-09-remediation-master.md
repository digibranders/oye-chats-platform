# Session Remediation: Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the wave plans task-by-task. This file is the register and the sequencing; the executable tasks live in the wave plans it links to.

**Goal:** Close every open finding from the 2026-09-09 reviews: the prompt library, the answer pipeline architecture, and the over- and under-engineering in the platform.

**Architecture:** Eight waves, each independently shippable and each ending green on the same checks. Measurement comes first, because every prompt change after it is unverifiable otherwise. Money and durability come second, because they are the findings that lose data or money silently. Structural simplification comes last, because it is the only category where the cost of being wrong is a rollback rather than a customer incident.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2.0, Alembic, pgvector, LiteLLM, ARQ on Redis, pytest; React 19 + TypeScript + Vite + vitest; GitHub Actions.

---

## Where the findings came from

Three reviews on 2026-09-09, all with file:line evidence:

1. **Answer Pipeline Review** (artifact) plus 14 live probes against the CleanStart bot.
2. **Engineering Balance Review** (artifact), from five parallel audits.
3. **Pre-landing review of PR #455**, from six specialists.

## What is already shipped

PR #455 on `development`, seven commits, all green. Do not re-do these.

| ID | Finding | Commit |
|---|---|---|
| G-1 | No judge, extractor or classifier set a temperature | `704124e2` |
| G-2 | Gate pass mark sat above the judge's own "related" anchor | `a57eac6c` |
| G-3 | Judge saw half of each chunk | `a57eac6c` |
| G-4 | Groundedness judge truncated an unranked CAG-lite bundle | `a57eac6c` |
| G-5 | Judge was handed the raw question, retrieval used the rewrite | `72f7af4e` |
| G-6 | A refusal was cached for an hour, nothing invalidated on ingest | `72f7af4e` |
| G-7 | On-scope questions with chunks were refused | `a015427f` |
| G-8 | Intent router hijacked real questions | `216b8998` |
| G-9 | Pricing gate had no opt-out | `e345a405` |
| G-10 | Relaxation used a fail-soft predicate as an enforcement bypass | `faac8026` |
| G-11 | Guard swallowed privacy answers | `faac8026` |
| G-12 | Superadmin threshold knob left on the old scale | `faac8026` |
| G-13 | `gate_prefix_for_bot` never matched a real key | `faac8026` |
| G-14 | Judge prompt unbounded on a wide bundle | `faac8026` |
| P-1 | Chunk enrichment was a silent no-op | `704124e2` |


## Executed on 2026-09-09 (after the register was written)

These are closed on `development`. The register above is the state as found; this
is the state as left.

| ID | Finding | Commit |
|---|---|---|
| M-1 | Nightly eval never ran: the target was passed by in-process env lookup that arrived empty | `d0a86e7f` |
| P-2 | Length, bold, follow-ups and unknown-phrasing each stated twice, style block winning | `ed553fbd` |
| P-3 | Every customer's bot told it sells B2B SaaS | `ed553fbd` |
| P-4 | 32,218-char media rulebook, injected with the bot-wide catalog | `ed553fbd` |
| P-5 | Every pricing answer required a billing cadence | `ed553fbd` |
| P-6 | Brand tone injected raw, below the rule it can contradict | `a446eb64` |
| P-7 | Custom prompt and tone truncated below what the API accepts | `a446eb64` |
| P-12 | No-info pivot said the words RULE 9 forbids | `e9888154` |
| P-11 | Widget greeted twice on turn one | `e9888154` |
| P-13 | Any reply under 1000 chars became COMPANY CONTEXT | `e9888154` |
| P-14 | Event URLs persisted from crawled text unvalidated | `e9888154` |
| P-15 | Handoff classifier: unfenced message, `"YES" in reply` | `e9888154` |
| P-19 | New accounts seeded with "an advanced AI consultant" | `e9888154` |
| E-1 | Booking card promised with no scheduler URL | `a446eb64` |
| E-2 | Free plan told to offer a team its prompt forbids | `a446eb64` |
| E-3 | Live handoff promised outside business hours | `a446eb64` |
| U-1 | Qualification lost on every deploy | `fa7a84cf` |
| U-3 | Production could boot with no durable queue | `fa7a84cf` |
| U-10 | Two owner filters matched every tenant when unscoped | `22ba4142` |
| U-11 | Hard-coded affiliate salt | `22ba4142` |
| O-11 | Dev gallery mounted in production with no auth | `22ba4142` |
| O-1 | Sync pipeline: 1,676 duplicate lines, no product caller | `93a32082` |
| O-3 | Dead `GATE_MODEL` constant and its contradictory comments | `4f6d643c` |
| O-14 | `CAG_LITE_THRESHOLD` read from the environment every turn | `4f6d643c` |
| R-4 | Groundedness preview stayed 500 while relevance moved to 1000 | `4f6d643c` |
| U-15 | Superadmin console lint did not typecheck | `oyechats-admin b0ffe09` |

`rag_service.py` went from 10,572 lines to 8,905. The assembled prompt went from
15,233 tokens to 8,120 for a bot with media, and two ratchet tests now fail if
either grows back.

### Corrections to the register

- **O-3 was partly wrong.** `task_migrate_embedding_profile` is not dead: it is
  how `api/scripts/migrate_embedding_profile.py` runs a migration through the
  worker. `EMBED_PROVIDER` is not dead either; it exists to reject an
  unsupported value, which is a guard rather than a dead branch. Only
  `GATE_MODEL` was genuinely dead.
- **U-16 cannot be done as written.** Wiring `verify-html.mjs` into the website
  build turns a passing deploy into a failing one: the verifier exits non-zero
  on six pre-existing content failures (four blog posts with too few inbound
  links, and `/features` and `/solutions` with no `h3` at all). Those six are
  content decisions, so the gate goes in after they are fixed, not before.

## Executed on 2026-09-09, waves 4 to 6

| ID | Finding | Commit |
|---|---|---|
| U-8 | Credit refund failure after a failed answer was log-only | `f12305a6` |
| E-4 | Meeting booking had no per-bot plan gate at chat time | `99f8eb55` |
| E-5 | Quotation gating disagreed across UI, API and pipeline | `eb789ded` |
| E-6 | Workspace entitlements gated per-bot settings in the UI | `f12305a6` |
| U-13 | Extraction failure returned (0,0) and skipped billing silently | `175a00f2` |
| O-6 | Six of fourteen "dead" endpoints deleted; the other eight are live | `9de93520` |
| U-5 | Email dead letter for enqueue failure, provider rejection, exhausted retries | `7c811cee` |
| U-7 | Invoices stuck un-numbered for an hour are counted and paged | `7c811cee` |
| U-12 | Liveness probe is tri-state; undetermined no longer reports as alive | `7c811cee` |
| O-5 | One super-admin write gate, one UTC coercer, no private cross-imports | `8544159a` |
| O-7 | 770 lines of demo-page HTML out of `bot_routes.py`; two dead symbols | `8544159a` |
| E-7 | Welcome greeting and subtitle now patch the columns the widget reads | `be984949` |
| O-9 | Audit-log index, retention for two unbounded tables, dead reader, double write | `1e4f3607` |
| O-8 | The two untested AR behaviours now have tests; AR-35's stale narrative fixed | `1e4f3607` |
| U-16 | Six content failures fixed; `verify-html` is a build gate | `oyechats-website b74dec8` |
| O-13 | Four dated audits moved to `docs/audits/` | `oyechats-website b74dec8` |
| O-10 | ChatWindow's pure helpers extracted and tested; hooks reverted on budget | `186823e1` |
| O-12 | Mobile app status written down; the decision is stated, not taken | `oyechats-mobile-app 2b4968d` |

### Corrections to the register, waves 4 to 6

Four findings were wrong on their premise. The defects each one led to are
fixed; the finding as written is not what was there.

- **U-5 was wrong.** "22 synchronous sends from request code" does not exist.
  All 42 call sites already go through `send_email_async` into ARQ, and no
  request-path code touches Brevo. The real hole was that a send which failed
  left no record anywhere: a failed enqueue, a provider rejection (deliberately
  never retried, because a retry can deliver an OTP twice), or an exhausted
  retry budget. A dead-letter table, not an outbox.
- **O-8 was stale.** Not 2,437 comment lines and 38 AR narratives: 1,849 and
  25, across 20 blocks. Nineteen of twenty-one already have a test that fails
  if the behaviour regresses, so there was almost nothing to convert. Two
  genuine gaps existed and are closed.
- **O-9 was wrong.** None of the five event tables can be merged. Every one has
  a distinct reader, a distinct retention rule, or a distinct write cardinality;
  the closest pair is disqualified four separate ways. The analysis did surface
  five real defects, all fixed.
- **O-5 overcounted.** 105 super-admin endpoints, not 109. Merging them into one
  module would produce a 6,500-line file and was not done; the shared gates were
  the actual defect.
- **U-14 is blocked, and not for the reason recorded.** The live app documents
  all 297 paths including super-admin, so the published-spec gap was not the
  problem. Only 37 of 342 operations declare a `response_model`, so generating
  clients today would replace roughly 150 accurate hand-written interfaces with
  305 `any`s. Response models first, then codegen. A ratchet test now holds the
  floor at 37.

## Open finding register

Severity is (likelihood × blast radius), not effort. **Wave** is where it gets fixed.

### Prompts (P)

| ID | Finding | Evidence | Sev | Wave |
|---|---|---|---|---|
| P-2 | System prompt contradicts itself on length, bold, follow-ups, unknown-phrasing and voice | `response_style.py:86,107,114,203,298` vs `rag_service.py` RULES 1,3,4,7,9 | High | 2 |
| P-3 | Style block hard-codes a B2B SaaS persona for every bot | `response_style.py:55,154` | High | 2 |
| P-4 | 32,221-char media rulebook, injected with the bot-wide catalog every turn | `rag_service.py` media block; `:8261,:10071` | High | 2 |
| P-5 | Style block demands a billing cadence on every pricing answer | `response_style.py:121` | High | 2 |
| P-6 | Brand tone injected raw, unsanitised, after the grounding rule | `rag_service.py:6028` | High | 2 |
| P-7 | Custom prompt and brand tone silently truncated (2000→1500, 500→300) | `bot_routes.py:677-678` vs `rag_service.py` | Med | 2 |
| P-8 | Mandatory flattery in the authority block | `rag_service.py` AUTHORITY ACKNOWLEDGMENT | Med | 2 |
| P-9 | Name ask intercepts every first turn, not a setting | `rag_service.py:resolve_name_flow` | Med | 2 |
| P-10 | Two refusal registers; the prompt bans the shapes the code emits | `rag_service.py:1392-1425` vs RULE 0 | Med | 2 |
| P-11 | Widget greets twice on turn one | `ChatWindow.jsx:238` + `_NAME_REQUEST_MESSAGE` | Med | 2 |
| P-12 | No-info pivot says the words RULE 9 forbids | `rag_service.py:1932-1936` | Med | 2 |
| P-13 | Company-context extractor: any reply under 1000 chars becomes COMPANY CONTEXT | `llm_service.py:697-699` | High | 2 |
| P-14 | Event extractor: crawled text unfenced, event URLs unvalidated | `event_extractor.py:142,213-226` | High | 2 |
| P-15 | Handoff classifier: `"YES" in text` parse, visitor text unfenced | `intent_service.py:98,110-111` | Med | 2 |
| P-16 | BANT rubric: unfenced spans, em-dashes, OyeChats-specific examples | `rag_service.py:3282-3381` | Med | 2 |
| P-17 | Enrichment prefix `[Context: …]` enters quotable chunk text | `enrichment.py:74` | Med | 2 |
| P-18 | Qualification chip copy off-voice and English-only | `qualification_service.py:395,410,418` | Low | 2 |
| P-19 | New-account seed prompt is "an advanced AI consultant" | `scripts/add_client.py:41` | Med | 2 |
| P-20 | Public docs teach instructions the platform forbids the bot to follow | `oyechats-website/src/lib/docs/content/chatbot.ts:270-281` | Med | 2 |
| P-21 | Docs claim the widget has no translation layer; it ships 19 locales | `oyechats-website/src/lib/docs/content/widget.ts:315` | Low | 2 |
| P-22 | No leak/URL guard on LLM output persisted for later prompting | `llm_service.py`, `event_extractor.py` | Med | 2 |

### Answer safety and measurement (M)

| ID | Finding | Evidence | Sev | Wave |
|---|---|---|---|---|
| M-1 | Nightly eval reads `EVAL_API_URL`/`EVAL_BOT_KEY` as **secrets**; they exist as repo **variables**, so the job errors in 15s | `.github/workflows/eval-nightly.yml:10-11` | High | 1 |
| M-2 | Golden set has no "company overview" category, the class that failed live | `api/eval/golden_set.jsonl` | High | 1 |
| M-3 | No unit eval for the relevance judge itself | none exists | High | 1 |
| M-4 | Refusal reason not persisted: no `answer_status`, no `gate_score` on a message | `models.py` ChatMessage | High | 1 |
| M-5 | Groundedness is metric-only and fails open with no counter | `groundedness_gate.py:209-212` | High | 3 |
| M-6 | Judge fail-open has no alert; a provider outage silently disables scope enforcement | `relevance_gate.py`, `rag_service.py:2081` | High | 3 |
| M-7 | Per-bot cost lives in a 26-hour Redis counter | `core/metrics.py:25,88` | Med | 3 |
| M-8 | No request-id middleware, no structured logs | `main.py:93` | Med | 3 |
| M-9 | Translation and event extraction are untraced | `translation_service.py`, `event_extractor.py` | Low | 3 |

### Under-engineering (U)

| ID | Finding | Evidence | Sev | Wave |
|---|---|---|---|---|
| U-1 | BANT extraction, the tier webhook and the qualified-lead email exist only on a 3-thread pool shut down with `wait=False` | `thread_pool.py:20,138`, `rag_service.py:8637` | Critical | 1 |
| U-2 | Enrichment credits charged before the vendor call and before persist | `chat_routes.py:1014-1023` | Critical | 1 |
| U-3 | `WORKER_ENABLED` defaults false; unset, webhooks become fire-and-forget | `worker/enqueue.py:35` | High | 1 |
| U-4 | `enqueue_sync` swallows Redis failures and returns None | `worker/enqueue.py:104-115` | High | 1 |
| U-5 | No email outbox; 22 synchronous sends from request code | `email_service.py` call sites | High | 4 |
| U-6 | Add-on cancel failure logs "mandate is STILL LIVE" and returns | `razorpay_service.py:1668-1675` | High | 4 |
| U-7 | Invoice finalize failure leaves a legacy row for an unscheduled pass | `invoice_service.py:376-392` | High | 4 |
| U-8 | Credit refund failure after a failed answer is log-only | `chat_routes.py:1260` | Med | 4 |
| U-9 | `bant_config` and three other JSONB columns are raw dicts; junk crashes every turn | `bot_routes.py:699`, `rag_service.py:6963` | Critical | 1 |
| U-10 | `_session_owner_filter` / `_doc_owner_filter` fall through to `client_id IS NULL` | `repository.py:964,978` | High | 1 |
| U-11 | `AFFILIATE_HASH_SALT` has a hard-coded default | `affiliate_service.py:174` | Med | 1 |
| U-12 | HEAD liveness failure reports every URL alive, so deleted pages persist | `document_routes.py:1420-1433` | Med | 4 |
| U-13 | Extraction failure returns `(0,0)` and skips billing silently | `document_routes.py:885-895` | Low | 4 |
| U-14 | No OpenAPI codegen; ~150 hand-mirrored TS interfaces across three consumers | app, admin, mobile | Med | 6 |
| U-15 | Superadmin console has no tests and no typecheck step | `oyechats-admin` | Med | 6 |
| U-16 | Website's 19-assertion HTML verifier is not wired into `build` | `oyechats-website/package.json` | Med | 6 |

### Over-engineering (O)

| ID | Finding | Evidence | Sev | Wave |
|---|---|---|---|---|
| O-1 | Sync `rag_pipeline` (1,676 lines, 74% duplicate) has no product caller | `rag_service.py:7182-8858`; widget uses `/chat/stream` | High | 5 |
| O-2 | 29 predicates + 4 regex gates + the intent router make 4 decisions | `rag_service.py` | High | 5 |
| O-3 | 13 boolean flags never set off their default; `GATE_MODEL`, `EMBED_PROVIDER` dead; 2 ARQ tasks never enqueued | `config.py`, `relevance_gate.py:83`, `worker/tasks.py:133,187` | Med | 3 |
| O-4 | Threshold and seat price each have three different defaults in three files | `relevance_gate.py`, `runtime_config.py`, `credit_service.py:205` | Med | 3 |
| O-5 | 109 superadmin endpoints over 6 routers split by fragment; two discount systems | `superadmin_routes*.py` | Med | 5 |
| O-6 | 14 endpoints with no caller in any frontend | see wave 5 plan | Med | 5 |
| O-7 | `bot_routes.py` carries checkout, three HTML page builders and an inline LLM call | `bot_routes.py:1582,1730,1981,2741,3354` | Med | 5 |
| O-8 | 2,437 comment lines and 38 AR-NN narratives inline in one file | `rag_service.py` | Med | 5 |
| O-9 | Five event tables with 2 to 7 writers each | `models.py` | Low | 5 |
| O-10 | `ChatWindow.jsx` is 4,658 lines with 67 `useState` and 30 `useEffect` | `widget/src/components/ChatWindow.jsx` | Med | 6 |
| O-11 | `/dev/ui` mounts a 3,663-line gallery in production with no auth | `app/src/app/routes.tsx:78,121-126` | High | 1 |
| O-12 | Mobile app duplicates the inbox and the entitlement model, zero tests, no ship evidence | `oyechats-mobile-app` | Med | 6 |
| O-13 | Website tracks 2,535 lines of dated audits and a 1.3 MB `graphify-out/` | `oyechats-website` | Low | 6 |
| O-14 | Config in three layers with 68 `os.getenv` outside `config.py`, some per request | `config.py`, `middleware.py:311-313` | Med | 3 |

### Deferred from the PR #455 review (R)

| ID | Finding | Sev | Wave |
|---|---|---|---|
| R-1 | Extract the duplicated `_relax_on_scope` block into one helper | Med | 5 (with O-1) |
| R-2 | Knowledge fingerprint moves per chunk, so a re-crawl misses the cache throughout | Low | 3 |
| R-3 | `_apply_model_family_kwargs` is private-by-convention with four external importers | Low | 3 |
| R-4 | Groundedness preview stayed 500 while the relevance preview moved to 1000 | Med | 3 |
| R-5 | `knowledge_state_for_bot` has no repository unit test | Med | 1 |
| R-6 | Dashboard threshold constants can drift from the backend with no tripwire | Med | 1 |

### Plan and entitlement truth (E)

| ID | Finding | Evidence | Sev | Wave |
|---|---|---|---|---|
| E-1 | Booking card promised when `meeting_booking_enabled` is on but no scheduler URL is set | `rag_service.py:8347,5342-5358`; `:871-894` drops the card | High | 2 |
| E-2 | The no-scheduler prompt branch offers the team on a plan the NO HUMAN HANDOFF block forbids it to | `rag_service.py:5360-5385` vs `:5311-5318` | High | 2 |
| E-3 | Live handoff promised outside business hours; `business_hours` has no reader in the pipeline | `rag_service.py:5321-5323` | High | 2 |
| E-4 | Meeting booking has no per-bot plan gate at chat time | `bot_routes.py:3729`, `IntegrationsPage.tsx:73` | Med | 4 |
| E-5 | Quotation gating disagrees across UI, API and pipeline | `planGates.ts:78-86`, `quotation_routes.py:85`, `rag_service.py:1273` | Med | 4 |
| E-6 | Workspace-level entitlements gate per-bot settings in the UI | `HandoffSection.tsx:69`, `BehaviourPage.tsx:192` | Med | 4 |
| E-7 | Orphan columns: `qualification_flow`, `services_url`, `welcome_title/subtitle` | `models.py:397`, `rag_service.py:4889` | Low | 5 |

---

## Waves

Each wave ends green on: `cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest`, and where the wave touches `app/`: `cd app && npm run lint && npx tsc --noEmit && npx vitest run && npm run build`.

| Wave | Theme | Findings | Plan | Why here |
|---|---|---|---|---|
| 1 | Measurement and the cheap P0s | M-1..M-4, U-1, U-2, U-3, U-4, U-9, U-10, U-11, O-11, R-5, R-6 | [wave-1](2026-09-09-remediation-wave-1.md) | Nothing after this is verifiable without M-1..M-4, and U-1/U-2/U-9 lose data, money or every turn for one bot |
| 2 | The prompt library | P-2..P-22, E-1, E-2, E-3 | [wave-2](2026-09-09-remediation-wave-2.md) | The user-visible half. Measured by wave 1's eval |
| 3 | Config, constants and the safety net | M-5..M-9, O-3, O-4, O-14, R-2, R-3, R-4 | [wave-3](2026-09-09-remediation-wave-3.md) | Small, mechanical, unblocks wave 5 by removing dead branches first |
| 4 | Money and plan truth | U-5..U-8, U-12, U-13, E-4, E-5, E-6 | expand before executing | Independent of the answer path; each item is a billing or entitlement correctness fix |
| 5 | Structural simplification | O-1, O-2, O-5..O-9, E-7, R-1 | expand before executing | Largest and riskiest; do it once waves 1 and 3 have made the surface smaller and measurable |
| 6 | Repo hygiene | U-14, U-15, U-16, O-10, O-12, O-13 | expand before executing | Frontend and tooling; no runtime risk |

Waves 4 to 6 are specified here at task level and get expanded into their own plan files immediately before execution, when the tree they will be applied to is known. Waves 1 to 3 are written out task-by-task now.

## Sequencing rules

1. **Never change a prompt without a before/after eval run.** Wave 1 Task 1 exists so this is possible.
2. **One wave per PR**, `development` → `main`. A wave that grows past ~40 files gets split at a task boundary.
3. **Migrations are additive within a wave.** Any value remap is its own migration with a no-op downgrade, per the pattern in `b1000008recalibrate.py`.
4. **The deploy workflow is part of the code.** Any env default changed in `config.py` is grepped for in `.github/workflows/deploy-api.yml`, `api/.env.example`, and the DB-backed `pricing_config` knobs. This has bitten twice (G-12, and the deploy hardcode found in the first round).
5. **Two pipelines until wave 5.** Every behaviour change lands in both copies with an AST test pinning their equivalence, using `tests/test_on_scope_relax.py` as the pattern.

## Risk register

| Risk | Mitigation |
|---|---|
| Prompt consolidation regresses answer quality in ways pytest cannot see | Wave 1 delivers the eval and the judge set first; every wave-2 task runs it before and after |
| Deleting the sync pipeline breaks the eval harness, its only caller | Wave 5 Task 1 converts `POST /chat` into a collector over the stream and keeps the response shape byte-identical, with a contract test |
| Moving BANT to ARQ silently drops signals if the worker is not running | Wave 1 Task 5 adds a startup guard that refuses to boot in production with `WORKER_ENABLED` unset |
| A typed JSONB model rejects a shape a live bot already stores | Wave 1 Task 8 reads every distinct stored shape from production before writing the model, and the model logs-and-defaults rather than raising |
