# Answer Gate Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the chatbot refusing questions its knowledge base can answer, by making every judge deterministic, calibrating the relevance gate, keeping wrong verdicts out of the cache, letting on-scope questions reach generation, and giving owners a way to answer pricing from their own documents.

**Architecture:** All changes sit in the gate layer (`relevance_gate.py`, `groundedness_gate.py`, `intent_router.py`, `pricing_gate.py`) and the two pipeline call sites in `rag_service.py`. The main system prompt is untouched in this plan. The pricing opt-out is a new Bot column, default off, so platform default behaviour is unchanged until an owner flips it.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2.0, Alembic, LiteLLM, pytest; React 19 + TypeScript + vitest for the one dashboard toggle.

**Evidence base:** `docs/` companion reports "OyeChats Answer Pipeline Review" and "OyeChats Engineering Balance Review" (2026-09-09). Baseline eval dispatched on CI before any change (run 34338091702).

**Checks after every task:** `cd api && uv run ruff check . && uv run ruff format .` then the task's pytest selection. Commit on `development` only.

---

### Task 1: Every judge and extractor runs at temperature 0

**Files:**
- Modify: `api/app/services/relevance_gate.py:271-304`
- Modify: `api/app/services/groundedness_gate.py:167-202`
- Modify: `api/app/services/rag_service.py:3425-3436` (BANT), `:6389` (paraphrase), `:6586` (rewrite)
- Modify: `api/app/services/llm_service.py:490-505` (brand tone), `:553-565` (seed questions), `:610-620` (tone preview), `:674-685` (company context)
- Modify: `api/app/ingestion/enrichment.py:55-80`
- Modify: `api/app/ingestion/event_extractor.py:213-230`
- Test: `api/tests/test_judges_are_deterministic.py`

- [ ] **Step 1: Write the failing test**

```python
"""Every classification, judge and extractor call must be deterministic.

None of these calls set ``temperature``. Gemini 2.5 Flash defaults to 1.0, so
the relevance judge scored the same question against the same chunks
differently on different runs, and the first verdict was then cached for an
hour. A judge is a classifier: it wants temperature 0, always.
"""

from types import SimpleNamespace

from app.ingestion import enrichment
from app.services import groundedness_gate, relevance_gate


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content
        self.document_name = "doc.md"


def _fake_completion(captured: dict):
    def completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"score": 0.9}'), finish_reason="stop")]
        )

    return completion


def test_relevance_judge_is_deterministic(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", lambda key: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda *a, **k: None)
    monkeypatch.setattr(relevance_gate.litellm, "completion", _fake_completion(captured))

    relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1)

    assert captured["temperature"] == 0


def test_groundedness_judge_is_deterministic(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(groundedness_gate, "GROUNDEDNESS_CHECK_ENABLED", True)
    monkeypatch.setattr(groundedness_gate.litellm, "completion", _fake_completion(captured))

    groundedness_gate.check_groundedness("q", "a", [_Chunk("c")], bot_id=1)

    assert captured["temperature"] == 0


def test_enrichment_is_deterministic_bounded_and_reasoning_off(monkeypatch):
    """Enrichment was a silent no-op: gemini spent its 80-token cap thinking
    and returned ''. Same fix as the judges plus a timeout and temperature."""
    captured: dict = {}

    def completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="About X."))])

    monkeypatch.setattr(enrichment, "ENRICHMENT_MODEL", "gemini/gemini-2.5-flash")
    monkeypatch.setattr(enrichment.litellm, "completion", completion)

    out = enrichment.enrich_chunk("chunk text", "document summary")

    assert out.startswith("[Context: About X.]")
    assert captured["temperature"] == 0
    assert captured["reasoning_effort"] == "disable"
    assert captured["timeout"] > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_judges_are_deterministic.py -v`
Expected: 3 FAIL with `KeyError: 'temperature'`

- [ ] **Step 3: Add `temperature=0` to every call**

In `relevance_gate.py` and `groundedness_gate.py`, inside `litellm.completion(...)`, add the line `temperature=0,` directly after `reasoning_effort="disable",`.

In `rag_service.py` BANT `_kwargs` dict (line ~3425) add `"temperature": 0,` after `"max_tokens": 2048,`. At `:6389` and `:6586` add `temperature=0,` to the `generate_response(` call (the function already accepts it).

In `llm_service.py` at each of the four helper `kwargs: dict = {` literals add `"temperature": 0,` after `"max_tokens": ...,`.

In `enrichment.py` replace the completion call with:

```python
        kwargs: dict = {
            "model": ENRICHMENT_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": _SUMMARY_MAX_TOKENS,
            "temperature": 0,
            "timeout": _ENRICHMENT_TIMEOUT_S,
            "metadata": {"generation_name": "chunk-enrichment"},
        }
        _apply_model_family_kwargs(kwargs, ENRICHMENT_MODEL)
        with langfuse_generation("chunk-enrichment", model=ENRICHMENT_MODEL, prompt=prompt) as gen:
            response = litellm.completion(**kwargs)
```

with `from app.services.llm_service import _apply_model_family_kwargs` at the top and `_ENRICHMENT_TIMEOUT_S = float(os.getenv("ENRICHMENT_TIMEOUT_S", "10.0"))` beside `_SUMMARY_MAX_TOKENS`.

In `event_extractor.py` add `"temperature": 0,` to the `kwargs` dict.

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_judges_are_deterministic.py tests/test_relevance_gate_strict_schema.py tests/test_groundedness_gate.py tests/test_chunk_enrichment*.py tests/test_event_extractor*.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/app api/tests/test_judges_are_deterministic.py
git commit -m "fix(gates): run every judge and extractor at temperature 0"
```

---

### Task 2: Calibrate the relevance gate

**Files:**
- Modify: `api/app/services/relevance_gate.py:84-107` (threshold 0.3, preview 1000, prompt version 3)
- Modify: `api/app/services/runtime_config.py:163` (default 0.3)
- Modify: `api/app/config.py:659` (comment)
- Modify: `api/app/api/bot_routes.py:701` (comment)
- Modify: `api/app/services/groundedness_gate.py:113` (`max_chunks`), `:140-150` (signature)
- Modify: `api/app/services/rag_service.py:3540-3568` (`_background_groundedness_check` gains `max_chunks`), `:8655`, `:10679` (call sites)
- Modify: `app/src/features/agents/advanced/behaviour.config.ts:52-60` (default constant)
- Test: `api/tests/test_relevance_gate_calibration.py`, `api/tests/test_relevance_gate_env_default.py`, `api/tests/test_relevance_gate_runtime_knobs.py`

- [ ] **Step 1: Write the failing tests**

```python
"""The gate refuses only what no chunk bears on.

The judge's own rubric defines 0.5 as "related enough to help". A pass mark of
0.55 sat above that, so a judge following its rubric failed the gate on every
broad company question ("what does cleanstart do" scored 0.5 and was refused
3 of 3 times on the live bot). The gate exists to refuse "what's the weather",
not to grade retrieval, so it fires only at the "no chunk bears on it" end.

The judge also saw 500 characters of each chunk while generation saw 1,000, so
an answer in the back half of a chunk was invisible to the judge and visible
to the model, and the judge's verdict won.
"""

from app.services import relevance_gate, runtime_config
from app.services.groundedness_gate import _build_groundedness_prompt


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content


def test_default_threshold_sits_below_the_related_anchor():
    assert relevance_gate.RELEVANCE_THRESHOLD == 0.3
    assert runtime_config.get_relevance_threshold.__defaults__ == (0.3,)


def test_judge_sees_a_whole_default_chunk():
    assert relevance_gate.GATE_CHUNK_PREVIEW_CHARS >= 1000
    prompt = relevance_gate._build_gate_prompt("q", [_Chunk("a" * 600 + "PRICE-TABLE" + "b" * 300)])
    assert "PRICE-TABLE" in prompt


def test_prompt_version_bumped_so_old_verdicts_expire():
    assert relevance_gate._GATE_PROMPT_VERSION >= 3


def test_groundedness_judge_widens_under_cag_lite():
    chunks = [_Chunk(f"chunk-{i}") for i in range(12)]
    assert "chunk-11" not in _build_groundedness_prompt("q", "a", chunks)
    assert "chunk-11" in _build_groundedness_prompt("q", "a", chunks, max_chunks=12)
```

Also in `test_relevance_gate_env_default.py` change any `0.55` expectation to `0.3`; in `test_relevance_gate_runtime_knobs.py` the tests monkeypatch `RELEVANCE_THRESHOLD` to 0.55 explicitly, so they stay as they are.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_relevance_gate_calibration.py -v`
Expected: 4 FAIL

- [ ] **Step 3: Implement**

`relevance_gate.py`:
```python
RELEVANCE_THRESHOLD: float = float(os.getenv("RELEVANCE_THRESHOLD", "0.3"))
_GATE_PROMPT_VERSION = 3
GATE_CHUNK_PREVIEW_CHARS: int = max(1, int(os.getenv("GATE_CHUNK_PREVIEW_CHARS") or "1000"))
```
Replace the paragraph comment above `GATE_MAX_CHUNKS` with three lines explaining that the preview covers a whole default chunk (`CHUNK_SIZE=1000`) so the judge and the generator read the same text.

`runtime_config.py:163`: `def get_relevance_threshold(default: float = 0.3) -> float:`

`config.py:659` and `bot_routes.py:701`: change `0.55`/`0.5` mentions to `0.3`.

`groundedness_gate.py`:
```python
def _build_groundedness_prompt(question: str, answer: str, chunks: list, max_chunks: int | None = None) -> str:
    limit = max_chunks if max_chunks and max_chunks > 0 else GROUNDEDNESS_MAX_CHUNKS
    chunk_previews = []
    for i, doc in enumerate(chunks[:limit], 1):
```
and `check_groundedness(..., client_id=None, max_chunks: int | None = None)` passing `max_chunks` through to the builder.

`rag_service.py` `_background_groundedness_check` gains `max_chunks: int | None = None` as its last parameter and passes it: `check_groundedness(question, answer, chunks, bot_id=bot_id, client_id=client_id, max_chunks=max_chunks)`. Both `submit_background(_background_groundedness_check, ...)` sites append `len(final_results) if _use_cag_lite else None` after `_bot_msg_trace_id`.

`behaviour.config.ts`: set `DEFAULT_RELEVANCE_THRESHOLD = 0.3` and adjust the three `STRICTNESS_LEVELS` values so the middle one equals 0.3 (read the existing help strings and keep them; only the numbers move: lenient 0.15, balanced 0.3, strict 0.5).

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_relevance_gate_calibration.py tests/test_relevance_gate_env_default.py tests/test_relevance_gate_runtime_knobs.py tests/test_relevance_gate_cag_lite_window.py tests/test_groundedness_gate.py tests/test_groundedness_background_detach.py -v`
Expected: PASS. Then `cd app && npx vitest run src/features/agents/advanced` PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app api/tests app/src/features/agents/advanced/behaviour.config.ts
git commit -m "fix(gates): calibrate the relevance gate and widen the groundedness judge under CAG-lite"
```

---

### Task 3: The judge sees the rewritten query, and the cache forgets fast

**Files:**
- Modify: `api/app/services/relevance_gate.py:86, 128-131, 250-340`
- Modify: `api/app/db/repository.py:524-532` (add `knowledge_state_for_bot`)
- Modify: `api/app/services/rag_service.py:7660-7662, 7995-8006, 9434-9436, 9827-9837`
- Test: `api/tests/test_relevance_gate_cache_policy.py`, update `api/tests/test_relevance_gate_cag_lite_window.py:80-115`

- [ ] **Step 1: Write the failing tests**

```python
"""A wrong verdict must not be pinned, and a re-train must not serve stale ones.

The cache key was (bot, question) with a one-hour TTL and nothing invalidated
it on ingest. A randomly low score refused every visitor who typed the same
words for an hour, and a freshly uploaded answer was refused until the entry
expired. Now: failing verdicts are never cached, the TTL is five minutes, and
the key carries the knowledge base's (count, max id) so any ingest or delete
re-keys it.
"""

from types import SimpleNamespace

from app.services import relevance_gate
from app.services.relevance_gate import _gate_cache_key


class _Chunk:
    def __init__(self, content: str) -> None:
        self.content = content


def _completion(score: float):
    def completion(**kwargs):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"score": %s}' % score), finish_reason="stop")]
        )

    return completion


def test_key_carries_the_knowledge_version():
    assert _gate_cache_key(8, None, "q", kb_version="14:900") != _gate_cache_key(8, None, "q", kb_version="15:901")
    assert _gate_cache_key(8, None, "q", kb_version="14:900") == _gate_cache_key(8, None, "q", kb_version="14:900")


def test_ttl_is_short():
    assert relevance_gate._GATE_TTL <= 300


def test_failing_verdicts_are_not_cached(monkeypatch):
    writes: list = []
    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", lambda key: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda key, value, ttl: writes.append((key, value)))
    monkeypatch.setattr(relevance_gate.litellm, "completion", _completion(0.1))

    ok, score = relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1, threshold=0.3)

    assert ok is False and writes == []


def test_passing_verdicts_are_cached(monkeypatch):
    writes: list = []
    monkeypatch.setattr(relevance_gate, "RELEVANCE_GATE_ENABLED", True)
    monkeypatch.setattr(relevance_gate, "cache_get", lambda key: None)
    monkeypatch.setattr(relevance_gate, "cache_set", lambda key, value, ttl: writes.append((key, value)))
    monkeypatch.setattr(relevance_gate.litellm, "completion", _completion(0.9))

    relevance_gate.check_relevance("q", [_Chunk("c")], bot_id=1, threshold=0.3, kb_version="3:77")

    assert len(writes) == 1 and writes[0][0].endswith(":" + _gate_cache_key(1, None, "q", kb_version="3:77").split(":")[-1])


class TestBothPipelinesJudgeTheRewrittenQuery:
    def test_each_gate_call_passes_search_query_and_kb_version(self):
        import inspect

        from app.services import rag_service as rs

        for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
            src = inspect.getsource(fn)
            call = src.index("check_relevance,") if "check_relevance," in src else src.index("check_relevance(")
            args = src[call : call + 900]
            assert "search_query" in args, f"{fn.__name__} must judge the query retrieval actually ran"
            assert "kb_version=_kb_version" in args, f"{fn.__name__} must key the verdict on knowledge state"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_relevance_gate_cache_policy.py -v`
Expected: FAIL (`kb_version` unexpected keyword; TTL 3600; failing verdict cached; source assertions)

- [ ] **Step 3: Implement**

`repository.py`, after `count_documents_for_bot`:
```python
def knowledge_state_for_bot(session, bot_id: int = None, client_id: int = None) -> tuple[int, int | None]:
    """``(chunk count, highest chunk id)`` for a bot: a cheap fingerprint of its
    knowledge base that changes on every ingest, re-ingest and delete. The
    relevance gate keys its verdict cache on it so a re-train never serves a
    verdict judged against the old documents."""
    stmt = select(func.count(), func.max(Document.id)).select_from(Document).where(_owner_filter(Document, bot_id, client_id))
    count, max_id = session.execute(stmt).one()
    return int(count), max_id
```

`relevance_gate.py`:
```python
_GATE_TTL = 300  # 5 minutes. A verdict is cheap to re-judge and expensive to get wrong for long.
```
```python
def _gate_cache_key(bot_id: int | None, client_id: int | None, question: str, kb_version: str | None = None) -> str:
    scope = f"b{bot_id}" if bot_id else f"c{client_id}"
    q_hash = hashlib.sha256(question.lower().strip().encode()).hexdigest()[:16]
    kb = kb_version or "0"
    return f"oyechats:gate:v{_GATE_PROMPT_VERSION}:{scope}:{kb}:{q_hash}"
```
`check_relevance(..., max_chunks=None, kb_version: str | None = None)`; build the key with `kb_version`; at the end:
```python
    is_relevant = score >= active_threshold
    logger.info(...)
    # Only a passing verdict is worth remembering. A failing one is what refused
    # every visitor who typed the same words for an hour when the judge was
    # merely unlucky; re-judging it costs one gate-tier call.
    if is_relevant:
        cache_set(cache_key, {"score": score}, _GATE_TTL)
    return is_relevant, score
```

`rag_service.py` both pipelines: import `knowledge_state_for_bot` beside `count_documents_for_bot`; replace
```python
_total_chunks = count_documents_for_bot(session, bot_id=bid, client_id=cid) if bid or cid else 0
```
with
```python
_total_chunks, _kb_max_id = knowledge_state_for_bot(session, bot_id=bid, client_id=cid) if bid or cid else (0, None)
_kb_version = f"{_total_chunks}:{_kb_max_id or 0}"
```
(the streaming path wraps this in its isolated-session block at `:9410-9435`; keep that wrapper and change the call inside it). Then change the non-stream gate call's first argument from `question` to `search_query` and add `kb_version=_kb_version,`; change the stream call to keyword form:
```python
                _is_relevant, _gate_score = await asyncio.to_thread(
                    check_relevance,
                    search_query,
                    final_results,
                    bot_id=bid,
                    client_id=cid,
                    threshold=_bot_threshold,
                    max_chunks=len(final_results) if _use_cag_lite else None,
                    kb_version=_kb_version,
                )
```
Update the existing source-level test in `test_relevance_gate_cag_lite_window.py` so its 800-char window still finds `len(final_results) if _use_cag_lite else None` (it will; the string is unchanged).

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_relevance_gate_cache_policy.py tests/test_relevance_gate_cache_version.py tests/test_relevance_gate_cag_lite_window.py tests/test_relevance_gate_strict_schema.py tests/test_rag_pipeline_defects.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/app api/tests
git commit -m "fix(gates): judge the rewritten query, key verdicts on knowledge state, never cache a refusal"
```

---

### Task 4: An on-scope question with retrieved chunks always reaches generation

**Files:**
- Modify: `api/app/services/rag_service.py:8046-8067` (non-stream) and `:9860-9885` (stream): add `_relax_on_scope` beside `_relax_topical`
- Test: `api/tests/test_on_scope_relax.py`

- [ ] **Step 1: Write the failing test**

```python
"""A question about the company that retrieved chunks is answered, not pivoted.

"what does cleanstart do" retrieved fifteen chunks and was still refused with
"I don't have that specific detail on hand" because the judge scored the
bundle low. When the question already looks on-scope (company name, "your",
"services", "pricing"...) and retrieval returned anything, the right move is
to generate and let RULE 5a phrase any gap; the canned pivot is reserved for
the empty-retrieval case.
"""

import inspect

from app.services import rag_service as rs


def test_both_pipelines_relax_the_gate_for_on_scope_questions_with_chunks():
    for fn in (rs.rag_pipeline, rs.rag_pipeline_stream):
        src = inspect.getsource(fn)
        assert "_relax_on_scope = (" in src, fn.__name__
        block = src[src.index("_relax_on_scope = (") : src.index("_relax_on_scope = (") + 600]
        assert "bool(final_results)" in block
        assert "_question_looks_on_scope(question, _company_name)" in block
        # The refusal branch must consult it.
        assert "and not _relax_on_scope" in src, fn.__name__
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_on_scope_relax.py -v`
Expected: FAIL

- [ ] **Step 3: Implement**

In both pipelines, immediately after the `_relax_topical` block (and its metric), add:

```python
            # On-scope question, chunks in hand: generate. The judge grades how
            # well the bundle answers the phrasing, and on a broad company
            # question ("what does X do") it sits at its own "related" anchor
            # and fails the gate. Refusing there sends a visitor who asked the
            # most common question on the site to a canned pivot while the
            # model holds fifteen chunks about the company. RULE 5a already
            # phrases a genuine gap honestly; the pivot stays for the case where
            # retrieval returned nothing at all.
            _relax_on_scope = (
                not _is_relevant
                and not _trusted_cta
                and not _answering_probe
                and not _relax_topical
                and bool(final_results)
                and _question_looks_on_scope(question, _company_name)
            )
            if _relax_on_scope:
                _safety_net_metric(
                    "gate_relaxed_on_scope",
                    path="nonstream",  # "stream" in the streaming copy
                    gate_score=f"{_gate_score:.2f}",
                    session=session_id,
                    bot_id=bid,
                )
```
and add `and not _relax_on_scope` to the `if (not _is_relevant and ...)` refusal condition in both copies.

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_on_scope_relax.py tests/test_topical_followup_gate.py tests/test_rag_pipeline_defects.py tests/test_pricing_gate_pipeline.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/services/rag_service.py api/tests/test_on_scope_relax.py
git commit -m "fix(gates): on-scope questions with retrieved chunks always reach generation"
```

---

### Task 5: The intent router only hijacks pure identity questions

**Files:**
- Modify: `api/app/services/intent_router.py:112-135, 233-246`
- Test: `api/tests/test_intent_router.py`

- [ ] **Step 1: Write the failing test** (append to `test_intent_router.py`)

```python
@pytest.mark.parametrize(
    "msg",
    [
        "who are you and what do you offer",
        "are you a bot? what services do you provide",
        "what's your name and what does the company do",
        "who made you and what is your pricing",
    ],
)
def test_identity_phrasing_that_also_asks_about_the_business_falls_through(msg):
    """Live: "who are you and what do you offer" was answered by a canned
    greeting with no content. Identity patterns only short-circuit when the
    whole message is about the bot itself."""
    assert route_intent(msg, "Acme") is None


@pytest.mark.parametrize("msg", ["who are you", "are you a bot?", "what is your name"])
def test_pure_identity_questions_still_short_circuit(msg):
    assert route_intent(msg, "Acme") is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_intent_router.py -v -k "falls_through or short_circuit"`
Expected: the four fall-through cases FAIL

- [ ] **Step 3: Implement**

Add after `_BOT_NAME_RE`:
```python
# A message that ALSO asks about the business is a knowledge question wearing
# an identity opener. "who are you and what do you offer" was answered by the
# canned greeting with no content; the canned identity replies are only right
# when the whole message is about the bot itself.
_ASKS_ABOUT_BUSINESS_RE = re.compile(
    r"(?ix)\b(?:"
    r"offer|offers|offering|provide|provides|sell|sells"
    r"|services?|products?|pricing|prices?|cost|costs|plans?"
    r"|what\s+do\s+you\s+do|what\s+does\s+(?:the\s+)?company|about\s+(?:the\s+)?company"
    r")\b"
)
```
and change section 2 of `route_intent` to:
```python
    # 2) Identity / meta. Match before length gate so longer phrasings work,
    #    unless the message also asks about the business (then it is a
    #    knowledge question and belongs to retrieval).
    if not _ASKS_ABOUT_BUSINESS_RE.search(norm):
        if _IS_AI_RE.search(norm):
            ...
        if _BOT_NAME_RE.search(norm):
            return _bot_name(company_name)
```
(indent the five existing `if` blocks under the new guard).

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_intent_router.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/services/intent_router.py api/tests/test_intent_router.py
git commit -m "fix(intent-router): identity openers that also ask about the business reach retrieval"
```

---

### Task 6: Owners can answer pricing from their own documents

**Product note:** `pricing_gate.py` and two tests pin "no opt-out" as a deliberate decision. This task reverses it with a per-bot setting that defaults OFF, so every existing bot behaves exactly as before. The pin tests are rewritten to pin the new invariant (default off; when off, the gate is byte-for-byte unchanged).

**Files:**
- Modify: `api/app/db/models.py:625` (new column next to `pricing_url`)
- Create: `api/alembic/versions/b1000008pricingkb.py`
- Modify: `api/app/services/pricing_gate.py:412-497` (`answer_from_knowledge_base` kwarg, `owner_optout` outcome)
- Modify: `api/app/services/rag_service.py:7530-7535, 7835-7842, 9253-9258, 9628-9635` (pass the flag; cache-bypass predicate stands down)
- Modify: `api/app/api/bot_routes.py:806, 965, 1110, 2427` (request, response, two constructors)
- Modify: `api/app/api/auth.py:957-1130` (`_bot_to_cache_dict` / `_bot_from_cache_dict`)
- Modify: `app/src/features/agents/advanced/behaviour.config.ts:338-400`, `ScopeSection.tsx`, `BehaviourPage.tsx:87-161`
- Test: `api/tests/test_pricing_gate.py:595-618`, `api/tests/test_pricing_gate_routes.py:33-45`, `api/tests/test_pricing_gate_optout.py`, `app/src/features/agents/advanced/behaviour.config.test.ts`

- [ ] **Step 1: Write the failing tests**

`api/tests/test_pricing_gate_optout.py`:
```python
"""An owner may tell the bot to answer pricing from the knowledge base.

The gate had no opt-out: a bot with no pricing page escalated every pricing
question to the team even when the uploaded documents state the price. The
setting defaults off, so a bot that never touches it is gated exactly as
before; when on, the gate stands down and the knowledge base answers.
"""

from app.api.auth import _bot_from_cache_dict, _bot_to_cache_dict
from app.api.bot_routes import BotResponse, UpdateBotRequest
from app.db.models import Bot
from app.services.pricing_gate import evaluate_pricing_gate


class _Chunk:
    def __init__(self, document_name, content):
        self.document_name, self.content = document_name, content


_KB = _Chunk("http://acme.com/about", "Our Pro plan costs $49 per month.")


def test_default_is_gated_exactly_as_before():
    decision = evaluate_pricing_gate(question="how much is pro?", quote_active=False, pricing_url=None, chunks=[_KB])
    assert decision.fired and decision.outcome == "escalate_no_url" and decision.chunks == []


def test_opted_out_bot_answers_from_the_knowledge_base():
    decision = evaluate_pricing_gate(
        question="how much is pro?", quote_active=False, pricing_url=None, chunks=[_KB], answer_from_knowledge_base=True
    )
    assert decision.fired is False and decision.outcome == "owner_optout" and decision.chunks == [_KB]


def test_opt_out_beats_a_configured_pricing_page_too():
    decision = evaluate_pricing_gate(
        question="how much is pro?",
        quote_active=False,
        pricing_url="http://acme.com/pricing",
        chunks=[_KB],
        answer_from_knowledge_base=True,
    )
    assert decision.outcome == "owner_optout"


def test_setting_round_trips_through_api_models_and_cache():
    assert UpdateBotRequest.model_fields["pricing_from_knowledge_base"].default is None
    assert BotResponse.model_fields["pricing_from_knowledge_base"].default is False
    bot = Bot(id=1, client_id=1, bot_key="bot-x", name="X", pricing_from_knowledge_base=True)
    assert _bot_from_cache_dict(_bot_to_cache_dict(bot)).pricing_from_knowledge_base is True
```

Rewrite `test_there_is_no_outcome_that_turns_the_gate_off` in `test_pricing_gate.py` as:
```python
def test_the_only_way_off_is_the_owner_setting():
    """``owner_optout`` is the one outcome that turns the gate off, and it is
    reachable only from ``Bot.pricing_from_knowledge_base``, which defaults to
    False. With the default, the vocabulary and behaviour are unchanged."""
    assert set(get_args(GateOutcome)) == {
        "quote_standdown",
        "no_support_path_standdown",
        "owner_optout",
        "not_pricing",
        "answer",
        "escalate_no_url",
        "escalate_no_content",
    }
```
Rewrite `test_the_write_and_read_contracts_expose_no_gate_toggle` in `test_pricing_gate_routes.py` as:
```python
def test_the_pricing_toggle_defaults_off_on_both_contracts():
    assert UpdateBotRequest.model_fields["pricing_from_knowledge_base"].default is None
    assert BotResponse.model_fields["pricing_from_knowledge_base"].default is False
```

`app/src/features/agents/advanced/behaviour.config.test.ts`: add
```ts
it('round-trips pricingFromKnowledgeBase', () => {
  const draft = parseBehaviour({ pricing_from_knowledge_base: true });
  expect(draft.pricingFromKnowledgeBase).toBe(true);
  expect(toBehaviourPayload(draft).pricing_from_knowledge_base).toBe(true);
  expect(parseBehaviour({}).pricingFromKnowledgeBase).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_pricing_gate_optout.py tests/test_pricing_gate.py tests/test_pricing_gate_routes.py -v`
Expected: FAIL (unknown kwarg / attribute)

- [ ] **Step 3: Implement**

`models.py` after `pricing_url`:
```python
    # Owner opt-out of the pricing answer gate. Default False keeps every bot on
    # the gated behaviour; True lets the general knowledge base answer pricing
    # questions (for owners whose documents carry the prices and who have no
    # separate pricing page).
    pricing_from_knowledge_base = Column(Boolean, nullable=False, default=False, server_default=sa.false())
```
(`import sqlalchemy as sa` if not already present; check how other `server_default` columns in the file spell it and match.)

`alembic/versions/b1000008pricingkb.py`:
```python
"""Let an owner answer pricing from the knowledge base.

``bots.pricing_from_knowledge_base``: default false, so nothing changes for a
bot that never touches it. True stands the pricing gate down for that bot.

Revision ID: b1000008pricingkb
Revises: b1000007waitsince
Create Date: 2026-09-09
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000008pricingkb"
down_revision: str | None = "b1000007waitsince"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("pricing_from_knowledge_base", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("bots", "pricing_from_knowledge_base")
```

`pricing_gate.py`: add `"owner_optout"` to `GateOutcome`; add `answer_from_knowledge_base: bool = False` to `evaluate_pricing_gate` and, right after the `quote_active` check:
```python
    if answer_from_knowledge_base:
        return PricingGateDecision(fired=False, outcome="owner_optout", chunks=chunks)
```
Update the docstring sentence "There is no enable flag to pass, because there is no opt-out" to describe the owner setting.

`rag_service.py`: at both `evaluate_pricing_gate(` calls add `answer_from_knowledge_base=bool(getattr(bot, "pricing_from_knowledge_base", False)) if bot else False,`. In both `_gate_may_intercept` predicates add `and not (bool(getattr(bot, "pricing_from_knowledge_base", False)) if bot else False)` alongside the `no_support_path_standdown` term.

`bot_routes.py`: `UpdateBotRequest`: `pricing_from_knowledge_base: bool | None = None`; `BotResponse`: `pricing_from_knowledge_base: bool = False`; both constructors: `pricing_from_knowledge_base=bool(bot.pricing_from_knowledge_base),` (use `b.` in `list_bots`). The PATCH loop at `:3618-3856` copies every set field with `setattr`, so nothing else is needed.

`auth.py`: add `"pricing_from_knowledge_base": bool(getattr(bot, "pricing_from_knowledge_base", False)),` to `_bot_to_cache_dict` next to `"pricing_url"`, and read it back in `_bot_from_cache_dict` the same way `pricing_url` is read.

`behaviour.config.ts`: add `pricingFromKnowledgeBase: boolean;` to `BehaviourDraft`; in `parseBehaviour`: `pricingFromKnowledgeBase: raw.pricing_from_knowledge_base === true,`; in `toBehaviourPayload`: `pricing_from_knowledge_base: draft.pricingFromKnowledgeBase,`.

`ScopeSection.tsx`: add props `pricingFromKnowledgeBase: boolean; onPricingChange: (next: boolean) => void;` and render, after the existing `SettingRow`:
```tsx
      <SettingRow
        label="Pricing answers"
        description={
          pricingFromKnowledgeBase
            ? 'Answers pricing questions from everything it has learned.'
            : 'Answers pricing only from the pricing page you set under Voice, and otherwise offers the team.'
        }
      >
        <Switch
          aria-label="Answer pricing from my documents"
          checked={pricingFromKnowledgeBase}
          onCheckedChange={(next) => onPricingChange(next === true)}
        />
      </SettingRow>
```
wrapping both rows in a fragment. Import `Switch` from `'../../../ui'` (check `Switch`'s prop name for the change handler in `app/src/ui/primitives/Toggle.tsx` and match it).

`BehaviourPage.tsx`: add `const setPricing = useCallback((pricingFromKnowledgeBase: boolean) => update((previous) => ({ ...previous, pricingFromKnowledgeBase })), [update]);` beside `setThreshold`, and pass `pricingFromKnowledgeBase={draft.pricingFromKnowledgeBase} onPricingChange={setPricing}`.

- [ ] **Step 4: Run tests and checks**

Run: `cd api && uv run alembic upgrade head && uv run pytest tests/test_pricing_gate_optout.py tests/test_pricing_gate.py tests/test_pricing_gate_routes.py tests/test_pricing_gate_pipeline.py tests/test_pricing_gate_e2e.py tests/test_bot_routes*.py -v`
Expected: PASS
Run: `cd app && npm run lint && npx tsc --noEmit && npx vitest run src/features/agents/advanced && npm run build`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add api/app api/alembic api/tests app/src/features/agents/advanced
git commit -m "feat(pricing-gate): owners can answer pricing from their own documents"
```

---

### Task 7: Full checks and hand-off

- [ ] **Step 1:** `cd api && uv run ruff check . && uv run ruff format --check .`
- [ ] **Step 2:** `cd api && uv run pytest -x -q` (whole suite; needs local Postgres on 5432, present)
- [ ] **Step 3:** `cd app && npm run lint && npx tsc --noEmit && npx vitest run && npm run build`
- [ ] **Step 4:** `git push origin development`; open PR `development` → `main` titled "Gate fixes: deterministic judges, calibrated relevance gate, on-scope relax, pricing opt-out" with the eval baseline run id in the body.
- [ ] **Step 5:** After the user merges and deploys, dispatch `gh workflow run eval-nightly.yml` and compare the per-category table with baseline run 34338091702; add a `company` category (5 phrasings) to `api/eval/golden_set.jsonl` in a follow-up.
