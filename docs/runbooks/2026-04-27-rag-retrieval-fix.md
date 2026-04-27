# RAG retrieval fix — three layered bugs blocking on-topic answers

**Date:** 2026-04-27 (afternoon, post-hardening) · **Operator:** infra · **Severity:** P1 (chat product silently broken on common phrasings) · **Downtime:** none (rolling restart)

User reported the bot refusing legitimate on-topic queries on
fynix.digital ("tell me about your services", "tell me services from
fynix"). Diagnosis surfaced three independent bugs that compounded.
Fixes verified live: **10/10 on-topic answered, 1/1 off-topic still
correctly refused.**

## Bug 1 — `litellm.drop_params` not set; `temperature=0` rejected by gpt-5

**Symptom:** every chat triggered

```
litellm.UnsupportedParamsError: gpt-5 models (including gpt-5-codex)
don't support temperature=0. Only temperature=1 is supported. ...
To drop unsupported params set `litellm.drop_params = True`
```

`app/services/intent_service.py` calls `generate_response(prompt,
temperature=0, max_tokens=3)` for deterministic intent classification
(e.g. handoff detection). `openai/gpt-5.4-mini` (current `LLM_MODEL`)
rejects `temperature=0`; the entire fallback chain failed too.

**Fix:** set `litellm.drop_params = True` once at app startup —
silently drop provider-unsupported params instead of erroring.
Applied in both processes:

- `app/main.py` — sets it before FastAPI app creation.
- `app/worker/settings.py` — sets it at module load, before
  `app.worker.tasks` is imported (because tasks transitively import
  `llm_service`).

This is the fix the error message itself recommends.

## Bug 2 — Moderation API model name had wrong format

**Symptom:**

```
Moderation check failed (non-blocking): Error code: 400 -
"Invalid value for 'model' = openai/omni-moderation-latest"
```

LiteLLM's `moderation()` endpoint only routes to OpenAI and rejects
the `openai/`-prefixed form. The completions endpoint requires the
prefix; the moderation endpoint forbids it.

**Fix:** dropped the prefix in `MODERATION_MODEL` default:
`openai/omni-moderation-latest` → `omni-moderation-latest`. Comment
added so future contributors don't unify the two formats again.

This was non-blocking (moderation fails open by design), but it
spammed warnings on every chat and meant moderation wasn't actually
running.

## Bug 3 — `max_distance=0.65` (L2) blocked **all** retrieval

The dominant bug. Retrieval returned 0 chunks for normal phrasings of
"what services do you offer" against bot 2 (Fynix Digital, 50 chunks
crawled from website).

### Empirical investigation

```sql
-- Distance is L2 (the `<->` operator), not cosine
SELECT embedding <-> CAST(:e AS vector) AS l2_dist
FROM documents WHERE bot_id = 2 ORDER BY l2_dist LIMIT 5
```

| query | category | best L2 | top-5 max L2 |
|---|---|---|---|
| tell me about your services | on-topic | 1.1144 | 1.1322 |
| what does Fynix Digital do | on-topic | 0.9007 | 0.9241 |
| who is on your team | on-topic | 1.1851 | 1.2259 |
| what kind of work have you done | on-topic | 1.1887 | 1.2063 |
| **what is the capital of France** | **OFF-TOPIC** | 1.3492 | 1.3593 |
| **how do I bake bread** | **OFF-TOPIC** | 1.2915 | 1.3126 |
| **write me a python function** | **OFF-TOPIC** | 1.3136 | 1.3357 |

**On-topic top-5 max = 1.23. Off-topic top-5 min = 1.29.** Clean gap.
The previous threshold of 0.65 sat well below ALL real queries —
nothing ever passed, the gate downstream never even ran (it returns
`(True, 1.0)` when the chunks list is empty), so retrieval failure
was being misreported as "off-topic" via the empty-context guard.

### Why earlier "what does Fynix Digital do" worked despite this

The keyword (TSVECTOR) path runs in parallel with the vector path
and is merged via reciprocal-rank-fusion. For queries containing the
literal company name, keyword search picked up the chunks and rescued
the result. Phrasings without "Fynix" went via the broken vector path
only and returned nothing.

### Fix

Raised the default in `app/db/repository.py:search_similar_documents`:

- before: `max_distance: float = 0.65`
- after:  `max_distance: float = 1.25`

The 1.25 sits in the on-topic / off-topic gap. The CRAG relevance
gate (0.55 default, lowered to 0.45 per-bot for Fynix) still runs
downstream as a second filter on the chunks that pass, so loosening
the primary cut-off doesn't make the bot answer truly off-topic
queries.

Comment added with the empirical numbers and reasoning for whoever
revisits this.

## Per-bot threshold tuning (defence-in-depth)

While diagnosing, also set the Fynix bot's `relevance_threshold` to
`0.45` (down from the env default 0.55) via direct SQL:

```sql
UPDATE bots SET relevance_threshold = 0.45 WHERE id = 2;
```

Then invalidated:
- `oyechats:bot:bot-ab5fc5ab79c0` (bot config cache)
- `oyechats:gate:b2:*` (CRAG gate score cache)
- `oyechats:qa:2:*` (QA response cache)

This was actually unnecessary once Bug 3 was found — the gate wasn't
even running because retrieval returned 0. But it's a sensible
default for a bot whose KB is small/dense.

## Verification (live on fynix.digital)

10 service-related phrasings + 1 off-topic control. Outcome
extracted from `journalctl -u oyechats-api`:

| # | Query | Verdict |
|---|---|---|
| 1 | tell me about your services | ✅ ANSWERED · chunks=15 |
| 2 | tell me services from fynix | ✅ ANSWERED · chunks=15 |
| 3 | what services do you offer | ✅ ANSWERED · chunks=15 |
| 4 | list your services | ✅ ANSWERED · chunks=15 |
| 5 | what kind of work do you do | ✅ ANSWERED · chunks=15 |
| 6 | show me your offerings | ✅ ANSWERED · chunks=15 |
| 7 | what can you help me with | ✅ ANSWERED · chunks=15 |
| 8 | tell me about your team | ✅ ANSWERED · chunks=15 |
| 9 | what are your prices | ✅ ANSWERED · chunks=15 |
| 10 | how do I work with you | ✅ ANSWERED · chunks=15 |
| C | what is the capital of France | ✅ correctly REFUSED (empty_retrieval) |

10/10 on-topic answered, 1/1 off-topic refused. The off-topic refusal
proves the threshold isn't so loose it lets random queries through —
"capital of France" embeds at L2 ≥ 1.34 against this KB, comfortably
beyond the 1.25 cutoff.

## Files changed

| File | What |
|---|---|
| `api/app/main.py` | `import litellm; litellm.drop_params = True` before Sentry init |
| `api/app/worker/settings.py` | same; before `app.worker.tasks` import |
| `api/app/services/rag_service.py` | `MODERATION_MODEL` default: drop `openai/` prefix |
| `api/app/db/repository.py` | `search_similar_documents` default `max_distance` 0.65 → 1.25, with empirical comment |

## Hotfix path

For the immediate user-facing fix, the four file edits were `scp`'d
to `/opt/oyechats/platform/...` on the droplet and `systemctl restart
oyechats-api oyechats-worker` was run. The same files are committed
to `development` so the next merge to `main` rolls them in
durably; the in-place hotfix will then be reaffirmed by the deploy
script.

## Follow-ups

- ☐ When admin UI for `Bot.relevance_threshold` lands (P2.2 work
  pending merge), revert the per-bot 0.45 SQL and let customers tune
  via the dashboard.
- ☐ Consider making `max_distance` env-tunable
  (`VECTOR_MAX_DISTANCE`) so it can be raised/lowered without a
  redeploy if a different KB shows different distance distributions.
- ☐ Add a prod test that triggers a real `temperature=0` call so the
  drop_params behaviour is verified by CI (otherwise a future
  litellm version bump that changes drop_params semantics goes
  undetected until users complain).
