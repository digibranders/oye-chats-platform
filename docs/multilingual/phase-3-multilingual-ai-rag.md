# Phase 3 — Multilingual AI/RAG

> **Revision note (2026-08-24).** This plan was corrected after a dedicated
> Phase 3 architecture audit against the live code. Ten corrections were folded
> in. The four most consequential: the audit found four code paths that return
> hardcoded English while bypassing the LLM entirely (`route_intent`,
> `_off_topic_refusal`, `_no_info_pivot`, and the `bant_cta_options` served from
> the public settings endpoint), so a prompt directive alone cannot make those
> paths speak the visitor's language. Line references below were verified
> against the current `rag_service.py`, `repository.py`, `intent_router.py`,
> `cache.py`, and `config.py`. The audit's verdict was APPROVE WITH FIXES: the
> architecture is sound and needs no redesign, unified multilingual retrieval is
> proven viable on the existing pgvector index, and the AI path stays
> generation-only with no translation service.

## Objective

Make the AI's response language an explicit, configurable, cache-correct
behaviour instead of the current implicit best-effort mirroring, and make every
visitor-facing string the backend can emit (LLM-generated answers, canned
greetings, canned refusals, qualification pill labels) respect the active
conversation language. This phase consumes the `ChatSession` language state
Phase 2 persists. It adds no new schema.

## Scope

- Thread a resolved `LanguageContext` from `chat_routes.py` into **both**
  `rag_pipeline_stream` and `rag_pipeline`, and into `build_hybrid_prompt`.
- Add a `_language_directive` to the system prompt, modelled on the existing
  `currency_directive`, gated on `bot.language_config.enabled`.
- Resolve the direct conflict between the new directive and
  `response_style.py`'s Section 10 ("mirror the visitor's language").
- Make the QA response cache key language-aware without changing the key format
  for disabled bots.
- Localize or language-gate the four LLM-bypassing English paths:
  `route_intent`, `_off_topic_refusal`, `_no_info_pivot`, and `bant_cta_options`.
- Localize the in-RAG `cta_prompt` pill copy where a session language is known.
- Implement `detect_message_language` (Phase 1 stub) for the first-turn
  unresolved case only.
- Calibrate retrieval for cross-lingual queries (distance threshold; document
  the English-only keyword arm; force-disable FlashRank for non-English).
- Surface `locale` in the SSE `METADATA` frame so the widget can reconcile.

## Non-scope

- Message-level detection beyond the first-turn unresolved case. If the session
  already has a language, or any explicit/site/html_lang/browser signal
  arrived, detection does not run.
- Operator translation (Phase 4).
- Admin UI to configure `supported_locales`/`default_locale` (Phase 5). This
  phase assumes `bot.language_config` is already populated for QA bots.
- Any `TranslationService` or external translation API. The AI path is
  generation-only. Requirement 17 is a hard constraint.
- Per-language vector indexes or duplicated knowledge bases. Requirement 16.
  Unified retrieval is proven viable below.
- Switching embedding models. `gemini-embedding-001` (768-dim, symmetric, no
  `task_type`) is retained; adopting `gemini-embedding-2` would require
  re-embedding the whole corpus and is a separate decision.

## Retrieval strategy: why unified retrieval works (requirement 16)

No per-language index is needed. Three verified facts:

1. **The embedding model is multilingual and symmetric.**
   `gemini-embedding-001` is called in `api/app/services/gemini_embedding.py`
   (`batchEmbedContents` around lines 92-96) with **no `task_type`**. Queries
   and documents therefore share one symmetric space, so a Hindi query vector
   lands near the English chunk vector for the same concept, and there is no
   `RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT` asymmetry to reconcile.
2. **Cosine distance is order-equivalent to L2** for the L2-normalized unit
   vectors used here (`repository.py:802-807`), so no metric change is needed.
3. **`Document` already has no language column**, and `metadata_info` (JSONB)
   exists if optional per-document language tagging is ever wanted, so no
   migration is required for the unified strategy.

Two calibration items the original plan treated as free:

- **The keyword arm is English-only.** `search_keyword_documents`
  (`api/app/db/repository.py:777-791`) hardcodes the text-search config twice:
  `func.plainto_tsquery("english", query)` at line 779 and
  `.match(query, postgresql_regconfig="english")` at line 784. A pure-Devanagari
  query has no lexical overlap with English documents, so the keyword arm
  contributes near-zero hits and hybrid search silently degenerates to
  vector-only (RRF loses half its signal). **Decision for V1: keep `'english'`.**
  Postgres ships no Hindi dictionary, and `'simple'` would drop English stemming
  for the majority of traffic. **Corrected against a real Postgres integration
  test** (`tests/test_cross_lingual_retrieval.py`, added during Phase 3
  implementation): a code-switched query ("मुझे pricing चाहिए") does **not**
  get partial credit on its embedded English term. `plainto_tsquery` ANDs
  together every extracted lexeme, including the untranslated Devanagari
  words, so the match fails whenever any of them is absent from the
  document's tsvector, which it always will be for an English-only knowledge
  base. The degradation is effectively total for any multi-word non-English
  query, not partial, and log keyword-arm hit counts by language confirm this
  in production. This is a documented, deliberate degradation, not a defect.
- **The vector distance threshold was tuned on English.**
  `search_similar_documents` (`repository.py:795`) defaults `max_distance=0.78`,
  chosen against an English corpus where on-topic queries cluster at cosine
  distance below 0.70 (docstring at `repository.py:809-812`). Cross-lingual
  embedding pairs sit at systematically lower similarity, so 0.78 will
  over-filter valid Hindi-to-English matches and push conversations into
  `_no_info_pivot`. **Required: revalidate the threshold per language before
  rollout**, using the per-bot `relevance_threshold` override
  (`rag_service.py:6110, 7234`) as the escape hatch.

Reranking and gating:

- **`RERANK_ENABLED` (default false) uses an English-centric FlashRank
  cross-encoder.** If a customer enables it, cross-lingual reranking will
  actively harm results. **Required: force-disable or bypass FlashRank when the
  conversation language is not English.**
- **`RELEVANCE_GATE_ENABLED` (default false) uses Gemini Flash** and is
  multilingual-safe. No change needed.
- **`CAG_LITE_THRESHOLD=20`**: bots with 20 or fewer chunks skip retrieval and
  inject everything, so they carry zero multilingual retrieval risk. They are
  the ideal first rollout cohort.

## Existing files/components affected

### Language plumbing

| File | Change |
|---|---|
| `api/app/api/chat_routes.py` — `_resolve_visitor_language_and_update_session` (243-336) | **Change return type from `None` to `LanguageContext \| None`.** It already resolves and holds the context; returning it is the only way to thread language downstream without a second DB read (see correction 5). Returns `None` when multilingual is disabled for the bot. |
| `api/app/api/chat_routes.py` — `chat_stream_endpoint`, `rag_pipeline_stream(...)` call (1490-1497) | Add `language=ctx` kwarg alongside `visitor_country`. |
| `api/app/api/chat_routes.py` — `chat_endpoint`, `rag_pipeline(...)` call (1334-1341) | **Same `language=ctx` kwarg. The non-streaming `/chat` path exists and must be threaded too** (correction 6). |
| `api/app/services/rag_service.py` — `rag_pipeline_stream` (6827) | Add `language: LanguageContext \| None = None`. |
| `api/app/services/rag_service.py` — `rag_pipeline` (5807) | **Same parameter. Second pipeline, same QA cache call site** (correction 6). |
| `api/app/services/rag_service.py` — `build_hybrid_prompt` (signature 3669-3709; `visitor_country` param at 3708; returns at 3709) | Add `language: LanguageContext \| None = None`; build `_language_directive`. |

### Prompt construction

| File | Change |
|---|---|
| `api/app/services/rag_service.py` — `currency_directive` precedent (built 4929-4936, spliced at 4980) and `response_style_block` splice (5053) | Model `_language_directive` on `currency_directive`. **Splice it immediately before `{response_style_block}` at 5053, not after**, so the static, prompt-cached style block stays at the end of the prefix and keeps its ~100% cache hit rate (`response_style.py:23-26`). |
| `api/app/services/response_style.py` — Section 10 "LANGUAGE & LOCALE" (267-278), Section 13 decision rule | **Do not modify this file.** It stays the fallback for disabled bots. The conflict (Section 10 says "mirror the visitor's message language", which contradicts a locked session language on a code-switched message) is resolved inside `_language_directive` with an explicit superseding clause (see correction 4). |

### LLM-bypassing English paths (the audit's core finding)

| File | Change |
|---|---|
| `api/app/services/intent_router.py` — `route_intent` (198), `_greeting` (261), `_ack` (269); English keyword sets `_GREETING_TERMS`, `_ACK_TERMS`, `_NEG_ACK_TERMS`. Called from `rag_service.py:5926, 6976` | **In scope (correction 1).** These return hardcoded English (`"Hey. Happy to help..."`) and bypass the prompt layer entirely. A Hindi-session visitor typing "hi" or "thanks" gets an English reply. Options: (a) when a session language is set and is not English, skip `route_intent` and let the LLM handle the turn, or (b) localize the canned answers from a static table. Recommendation: **(a) skip for non-English sessions** (simpler, no new translation surface, and the LLM already handles greetings gracefully). |
| `api/app/services/rag_service.py` — `_off_topic_refusal` (1215), `_no_info_pivot` (1306), `OFF_TOPIC_REFUSAL_VARIANTS`, `OFF_TOPIC_ESCALATION_VARIANTS`; returned directly as bot content at 6193, 6239, 7294, 7336 | **In scope (correction 2).** Hardcoded English returned as the bot answer, no LLM involved. Combined with the over-strict cross-lingual distance threshold, `_no_info_pivot` fires *more* often for non-English visitors, so this is the failure mode they hit most. Localize from a static en/hi table keyed by session language, or route these through a minimal LLM rewrite. Recommendation: **static table** (deterministic, no latency, no cost). |
| `api/app/api/bot_routes.py` — `bant_cta_options` in `GET /bots/settings/public` (997, 1031) | **In scope (correction 3).** This endpoint is fetched once at widget bootstrap and **has no session context**, so per-session language is unavailable here. A static server-side table cannot know which language to serve. Pill labels delivered through this path must be localized **client-side from the widget dictionary**, or delivered per-turn in the SSE stream instead. This is a real change to the plan's original "static table in `qualification_service.py`" approach, which only works for the in-RAG call sites below. |
| `api/app/services/rag_service.py` — in-RAG `cta_prompt` reads (3550, 3863) | These DO have session context. A static en/hi translation table for the ~20 preset `cta_prompt` strings works here. Custom (bot-overridden) `cta_prompt` values stay in their authored language until Phase 4's `TranslationService` (documented gap, surfaced not silently swallowed). |

### Streaming and cache

| File | Change |
|---|---|
| `api/app/core/cache.py` — `qa_response_key(bot_id, question_hash)` (142) | Add an optional language segment. Call sites: `rag_service.py:5997` (non-streaming) and `7041` (streaming). `_q_hash` is built from `_normalize_question_for_cache` (1947). **The key format for disabled bots must not change**, or every existing bot takes a 100% cache miss on deploy. |
| `api/app/services/rag_service.py` — SSE `METADATA` frames (6949, 6986), currently `{session_id, sources}` | Add `locale` (correction 9), so the widget can reconcile when the backend resolves a different locale than the widget guessed (closes the H7-class divergence at the AI boundary). |

### Structured output reached by language

| File | Change |
|---|---|
| `api/app/services/qualification_service.py` — BANT extraction (invoked post-stream in the ARQ worker over the transcript) | **The extraction prompt must instruct the model to read the visitor's language but emit canonical English enum values** (dimension keys, tier names). If it starts emitting Hindi tier names, `dimension_scores`/`bant_tier` become unqueryable and analytics break silently. Highest-risk structured-output surface (correction covered under Risks Q13). |

## New files/components required

None. This phase modifies existing modules and adds static translation tables
(en/hi) for the canned strings. `language_service.py` (Phase 1) is imported,
not created.

## Database/schema changes

None. Reads `ChatSession.language_code`/`locale`/`language_locked` (Phase 2) and
`Bot.language_config` (Phase 1).

## API/WebSocket changes

- SSE `METADATA` frame gains a `locale` field (additive; old widgets ignore it).
- No new routes. `ChatRequest` already carries the language fields from Phase 2.

## Frontend changes

Widget must localize the `bant_cta_options` pill labels client-side from its own
dictionary (correction 3), because the public settings endpoint that serves them
has no session context. Otherwise no widget change: the AI answer text simply
arrives in the visitor's language.

## Detection strategy (requirements Q7, Q8, Q9, Q10)

- **`language_locked` is a hard gate.** Phase 2 already short-circuits at
  `chat_routes.py:285` (`if existing_locked and client_source != "explicit":
  return`). Phase 3 must not weaken it. `detect_message_language` runs only when
  multilingual is enabled AND the session has no language AND no
  explicit/site/html_lang/browser signal arrived, i.e. turn 1 of an unresolved
  session. This keeps steady-state latency at zero.
- **Detection results route through `match_supported_locale`**, never written
  directly, so only offered locales are ever persisted (reuses the Phase 2 H4
  remediation).
- **Low-confidence or unsupported detection falls through**, never stored.
  Recommended confidence floor 0.85, configurable. Below it, keep the session
  language, else `default_locale`.
- **Mid-conversation "reply in English" (Q8): do NOT build a keyword detector.**
  A language-switch keyword matcher would itself be a new English-only heuristic
  (the exact bug class this audit found four times) and a prompt-injection
  surface. Instead: the widget language selector stays the only authoritative
  switch; the LLM may honour an in-conversation request for that single reply
  (permitted by the directive's final clause) **without mutating `ChatSession`**;
  optionally show a visitor-confirmed "Switch to English?" affordance. This
  preserves "explicit selection stays locked".

## Prompt strategy

Structured context, modelled on `currency_directive`, spliced before
`{response_style_block}` (5053):

```
CONVERSATION LANGUAGE
Language: {display_name_from_KNOWN_LOCALES}
Locale: {session.locale}

RULES
- Write your entire reply in {display_name}.
- The reference material may be in another language. Use it as source
  material and answer natively in {display_name}. Do not translate it
  sentence by sentence, and do not mention the language it was written in.
- Keep product names, plan names, URLs, and email addresses exactly as written.
- Use number, date, and currency formatting appropriate to {session.locale}.
- This overrides any instruction to mirror the visitor's message language.
  Reply in {display_name} even if the visitor writes in another language,
  unless they explicitly ask you to switch.
```

Three deliberate choices:

- **"answer natively ... do not translate"** (Q15). Framing the task as
  translation produces stilted, calque-heavy output; framing it as generation
  from source material does not. This wording is also what keeps requirement 17
  satisfied with no translation service.
- **The superseding clause (correction 4)** resolves the Section 10 conflict
  explicitly. `response_style.py` is left unmodified and keeps serving disabled
  bots.
- **The language name is looked up server-side from
  `language_service.KNOWN_LOCALES`, keyed by the already-validated locale. Never
  interpolate request-supplied text into the prompt** (see Security).

Note on customer prompts: `bot.system_prompt`, `brand_tone`, and
`company_description` are customer-authored and usually English, injected
upstream in the same prompt. A late directive generally wins on recency, but a
customer prompt containing an explicit "always respond in English" will
conflict. Document this precedence and surface guidance in the Phase 5 admin UI.

## Streaming strategy (Q11)

Language consistency is structurally guaranteed: the directive is fixed in the
system prompt before the first token and there is no mid-stream prompt mutation.
Four things still need attention:

1. **Retry paths reuse the identical prompt**, including the language block, so
   a retry cannot switch language mid-conversation.
2. **UTF-8 chunk boundaries.** Devanagari and Arabic are multi-byte. Chunks are
   concatenated as decoded strings (the SSE path yields `str` today); never
   introduce byte-level slicing, which would corrupt glyphs.
3. **Output token budget.** Non-Latin scripts consume roughly 2 to 3 times more
   tokens per character. Verify `max_tokens` does not truncate Hindi
   mid-sentence; raise if needed.
4. **`METADATA` carries `locale`** (6949, 6986) so the widget reconciles.

Model behaviour is fine: `LLM_MODEL=openai/gpt-5.4-mini`,
`FALLBACK_MODEL=gemini/gemini-2.5-flash` (`config.py:45-46`). Both are strong
multilingual models; the LiteLLM fallback chain needs no language-conditional
routing.

## Backend/service changes

Core call chain:

```
chat_routes.py: chat_stream_endpoint / chat_endpoint
  → ctx = _resolve_visitor_language_and_update_session(...)   # returns LanguageContext | None
  → rag_pipeline_stream(..., language=ctx)   /   rag_pipeline(..., language=ctx)
      → if language is not None and bot.language_config.get("enabled"):
            # skip route_intent for non-English sessions (correction 1)
            # localize _off_topic_refusal / _no_info_pivot from static table (correction 2)
            # language-aware qa_response_key (correction 8 of the review / cache)
            build_hybrid_prompt(..., language=language)
              → _language_directive spliced before response_style_block (5053)
        else:
            # byte-identical to pre-Phase-3 behaviour
```

## Dependencies on previous phases

- **Phase 1**: `language_service.py` (`KNOWN_LOCALES`, `match_supported_locale`,
  `normalize_locale`, `detect_message_language` stub), `Bot.language_config`.
- **Phase 2**: `ChatSession.language_code`/`locale`/`language_locked`, and the
  `_resolve_visitor_language_and_update_session` helper whose return type this
  phase changes. Phase 3 cannot ship without Phase 2.

## Exact implementation steps

1. Change `_resolve_visitor_language_and_update_session` to return
   `LanguageContext | None` (correction 5). Disabled bots return `None`.
2. Thread `language=ctx` into both `rag_pipeline_stream` and `rag_pipeline`
   call sites (corrections 5, 6).
3. Add the `language` parameter to `rag_pipeline_stream` (6827),
   `rag_pipeline` (5807), and `build_hybrid_prompt` (3669).
4. Build `_language_directive` gated on `enabled`, spliced before
   `response_style_block` (5053), with the superseding clause (correction 4).
   Language name from `KNOWN_LOCALES`, never from request text.
5. Make `qa_response_key` language-aware (`cache.py:142`, call sites 5997 and
   7041) without changing the format for disabled bots.
6. Skip `route_intent` for non-English sessions (correction 1); localize
   `_off_topic_refusal` / `_no_info_pivot` from a static en/hi table
   (correction 2).
7. Add a static en/hi table for the ~20 preset `cta_prompt` strings; wire it
   into the in-RAG reads (3550, 3863). Localize `bant_cta_options` **client-side
   in the widget** (correction 3).
8. Add `locale` to the SSE `METADATA` frames (correction 9).
9. Implement `detect_message_language` for the first-turn unresolved case only;
   route through `match_supported_locale`.
10. Calibrate retrieval: revalidate `max_distance` cross-lingually; add
    keyword-arm hit-count logging by language; force-disable FlashRank for
    non-English (corrections 7, 8).
11. Instruct BANT extraction to read any language but emit canonical English
    enum values (Q13).
12. Regression-test that disabled bots produce **byte-identical** prompts and an
    **unchanged cache-key format**.

## Acceptance criteria

- [ ] `enabled=true`, Hindi session: AI answers in Hindi; retrieval hits the
      unified index; no per-language index exists.
- [ ] A Hindi-session visitor typing "hi"/"thanks" does **not** get an English
      canned reply from `route_intent`.
- [ ] `_off_topic_refusal` and `_no_info_pivot` render in the session language.
- [ ] Section 10 conflict: a locked Hindi session with one English user message
      still replies in Hindi.
- [ ] Preset `cta_prompt` pills and `bant_cta_options` render in the session
      language (client-side for the settings-endpoint path); custom `cta_prompt`
      renders unchanged with no error.
- [ ] QA cache never serves a wrong-language cached response; disabled-bot key
      format is unchanged.
- [ ] Disabled bots (`enabled=false`, the default) show byte-identical prompt
      construction, cache-key format, and response content versus pre-Phase-3.
- [ ] BANT extraction over a Hindi transcript still emits canonical English
      dimension keys and tier values; `dimension_scores`/`bant_tier` stay
      queryable.
- [ ] `language_locked` sessions never invoke `detect_message_language`.
- [ ] SSE `METADATA` includes `locale`.

## Testing/QA requirements

**Prompt construction**
- `build_hybrid_prompt(language=hi, enabled=true)` contains the directive;
  `enabled=false` does not, and Section 10 is still present.
- Directive is positioned before `response_style_block` (cache-prefix stability).
- **Disabled-bot prompt is byte-identical to pre-Phase-3. The single most
  important regression test.**

**Cache**
- Same question, two session languages, two distinct keys.
- Disabled bot: key format unchanged (no mass invalidation on deploy).

**Retrieval** — implemented as a real (unmocked) pgvector integration test,
`tests/test_cross_lingual_retrieval.py`, using the existing `pg_engine`/`db`
throwaway-Postgres fixture pattern:
- Cross-lingual vector retrieval returns the expected English chunk for a
  Hindi-equivalent query at a synthetic, precisely-known cosine distance,
  rejected under the English-tuned default (0.78) and admitted under
  `CROSS_LINGUAL_MAX_DISTANCE` (0.85), through both `search_similar_documents`
  directly and `rag_service._vector_search` (the real pipeline call).
- Keyword arm returns 0 for pure Devanagari, **and 0 for code-switched too**
  (corrected: `plainto_tsquery` ANDs every extracted lexeme, so an embedded
  English token gets no partial credit when non-English filler words
  surround it; the one exception is a query that is ONLY the English token,
  which is really the pure-English case, not genuine code-switching).
- A known cross-lingual pair is not filtered at the configured `max_distance`.

**LLM-bypassing paths**
- `route_intent("hi")` in a Hindi session does not emit English.
- `_off_topic_refusal` / `_no_info_pivot` in a Hindi session do not emit English.

**Detection and locking**
- `language_locked=true` never calls `detect_message_language` (assert via mock).
- Low-confidence and unsupported detections are not persisted.

**Qualification**
- BANT extraction over a Hindi transcript emits canonical English enum values.

**Streaming**
- Devanagari response is not corrupted across chunk boundaries.
- Both `rag_pipeline` and `rag_pipeline_stream` accept and honour `language`.

## Cost / latency impact (Q14)

| Path | Impact |
|---|---|
| Disabled bots (all existing) | Zero. Early return before any extra DB or LLM work. Cache-key format unchanged. |
| Enabled, steady state | Zero extra LLM calls. Phase 2's short-circuit already makes turn N a single column-only read, no transaction. |
| Enabled, turn 1 unresolved | One detection call, only if no client signal arrived. |
| Prompt tokens | +80 to 120 for the directive; splicing before the style block preserves the cached prefix. |
| Output tokens | **The real cost driver: 2 to 3x for Devanagari/Arabic.** Output dominates chat billing, so a Hindi-heavy bot sees a material per-conversation increase. Model before pricing (correction 10). |
| QA cache | Language in the key lowers the hit rate for multilingual bots (partitioned per language). Expected, not free. |
| Retrieval | Unchanged call count; cross-lingual queries may return fewer chunks. |

## Risks and edge cases

- **Security (Q12).** The visitor controls `body.locale`. Look up the language
  display name server-side from `KNOWN_LOCALES`; never interpolate
  request-derived text into the prompt (`f"Respond in {body.locale}"` is
  forbidden). Keeping language switches on the UI selector (Q8) means the text
  path never mutates state, removing the injection vector rather than filtering
  it. The existing injection guard is pattern-based and English-oriented, so
  non-English injection may bypass it: a pre-existing condition newly exposed,
  worth naming, not a Phase 3 regression.
- **Structured output / qualification (Q13).** Covered above: BANT extraction
  must emit canonical English enums. CTA pill scoring (`_score_cta_answer`)
  matches a visitor answer against English option labels, so a Hindi answer
  falls back to free-text extraction (degraded, not broken). Citations are
  language-independent.
- **Cache-key backward compatibility** is the highest-risk deploy item. Get the
  format right so disabled bots keep 100% of their cache.
- **Custom `cta_prompt` staying English** while the rest is Hindi is a known,
  accepted V1 gap. Surface it, do not ship it silently.
- **Preserving product/plan/URL names** needs a test case with a plan name and a
  URL in a non-English conversation.
- **Bot enabled mid-conversation**: prior sessions have `language_code = NULL`
  and resolve on their next turn. Correct by construction.

## Rollback considerations

- Everything is gated on `bot.language_config.enabled` (Phase 1 default false).
  Disabling the flag is a complete, instant, code-free rollback.
- A full code rollback is safe (no schema change). The QA cache may need a
  manual flush if the key format was reverted mid-flight; stale-format keys
  simply miss under the reverted scheme (safe, wastes cache).
