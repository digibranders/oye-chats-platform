# Phase 3 — Multilingual AI/RAG

## Objective

Make the AI's response language an explicit, configurable, cache-correct
behavior instead of the current implicit best-effort mirroring, and localize
the qualification (BANT) pill-prompt copy. This phase consumes the
`ChatSession` language state Phase 2 persists — it adds no new schema.

## Scope

- Thread `visitor_language`/`LanguageContext` from `chat_routes.py` into
  `rag_pipeline_stream` and `build_hybrid_prompt` in `rag_service.py`.
- Fix the QA response cache key so it's language-aware.
- Formalize the existing implicit "mirror the visitor's language" instruction
  in `response_style.py` into an explicit, bot-configurable directive.
- Localize `qualification_service.py`'s hardcoded `cta_prompt` strings.
- Confirm multilingual retrieval works correctly against the existing unified
  (non-per-language) pgvector index — no new indexes.

## Non-scope

- Message-level language *detection* implementation is finished here (Phase 1
  stubbed `detect_message_language`; Phase 3 implements and invokes it), but
  only for the case where Phase 2's resolution chain reaches "message
  detection" (i.e., no explicit/site/browser/persisted signal was available).
- Operator translation (Phase 4).
- Admin UI to configure `supported_locales`/`default_locale` (Phase 5) — this
  phase assumes those are already correctly populated in
  `bot.language_config` for QA bots.
- Switching embedding models. `gemini-embedding-001` (current, per root
  `CLAUDE.md`'s tech stack table) is retained; `gemini-embedding-2` is
  explicitly out of scope since adopting it would require re-embedding the
  entire corpus — not a multilingual-feature decision.

## Existing files/components affected

| File | Change |
|---|---|
| `api/app/api/chat_routes.py` — `chat_stream_endpoint` (lines 1279-1404), specifically the `rag_pipeline_stream(...)` call (lines 1379-1388) | Add `visitor_language=` kwarg, sourced from the `LanguageContext` Phase 2's `_resolve_visitor_language` already computed and persisted to `ChatSession`. |
| `api/app/services/rag_service.py` — `rag_pipeline_stream` (signature at lines 6827-6845) | Add `visitor_language: str | None = None` parameter. |
| `api/app/services/rag_service.py` — QA cache check (lines 7040-7084, cache key via `qa_response_key(bid, _q_hash)`) | Fold language into the cache key: `qa_response_key(bid, _q_hash, lang)`. Without this, a cached English answer would be served verbatim to a Spanish-language question hitting the same `_q_hash` bucket (the hash is presumably question-text-derived, so different-language questions naturally produce different hashes for *different* questions — but the real risk is the same underlying intent asked in two languages, or a bot with `enabled` toggled after cache entries exist, serving a stale-language cached response for what should now be a live regeneration). |
| `api/app/services/rag_service.py` — `build_hybrid_prompt` (signature lines 3669-3709, region-aware pricing precedent at lines 4923-4943 building `currency_directive`, spliced in at line 4980; `response_style_block` appended at line 5053) | Add `visitor_language: str | None = None` parameter. Build a `_language_directive` block using the exact same pattern as `currency_directive` — computed from `visitor_language` (and `bot.language_config` if an enforced/restricted language set is configured), spliced into `hybrid_system_prompt` near `{currency_directive}` (line 4980) or immediately before `{response_style_block}` (line 5053). |
| `api/app/services/response_style.py` — `RESPONSE_STYLE_BLOCK` (lines 50-435), Section 10 "LANGUAGE & LOCALE" (lines 267-278), Section 13 "DECISION RULE" (line 426, `✓ Did I match the visitor's language?`) | **Keep this block as the fallback/default behavior** for bots that never configure `language_config` (i.e., `enabled=false`, matching Phase 1's default). It already does the right thing for the common case — Phase 3 does not remove or weaken it. The new `_language_directive` in `build_hybrid_prompt` only fires when `bot.language_config.enabled=true`, and either strengthens the existing instruction (visitor-declared language takes precedence over the LLM's own inference) or, if the bot restricts to specific `supported_locales`, adds an explicit constraint ("respond only in one of: English, Hindi") that the static `response_style.py` block can't express since it's bot-agnostic. |
| `api/app/services/qualification_service.py` — `cta_prompt` string literals (lines 39, 60, 73, 86, 105, 118, 131, 144, 157, 170, 196, 209, 222, 235, 253, 265, 277, 289, 301, 313, 325) | These are static quick-reply pill labels, not LLM-generated — they need a translation lookup, not a prompt directive. Add a `_localize_cta_prompt(text: str, language: str) -> str` helper that either (a) looks up a pre-translated string table for the finite, known set of preset `cta_prompt` values, or (b) calls `TranslationService` (Phase 4) if the bot uses a custom (non-preset) `cta_prompt`. For Phase 3 (which predates `TranslationService`), ship option (a) only — a static translation table for the ~20 known preset strings in the pilot locale set (en/hi), and leave custom `cta_prompt` overrides untranslated until Phase 4's `TranslationService` exists (documented as a known gap, not silently ignored — surface the untranslated custom prompt as-is, in the customer's original language, which is the safe default). |

## New files/components required

- None — this phase modifies existing service modules; it introduces no new
  files. (`language_service.py` from Phase 1 is imported here, not created.)

## Database/schema changes

None. This phase reads `ChatSession.language_code`/`locale` (Phase 2 columns)
and `Bot.language_config` (Phase 1 column) — no new columns.

## API/WebSocket changes

None beyond what Phase 2 already added to `ChatRequest`. This phase is purely
about how the backend *uses* the already-transmitted language signal.

## Frontend changes

None. The AI response text itself changes language, but no widget code
changes in this phase (Phase 2 already built the UI that would display it).

## Backend/service changes

Full call chain for this phase's core change:

```
chat_routes.py: chat_stream_endpoint
  → visitor_language = session.language_code (persisted by Phase 2)
  → rag_pipeline_stream(..., visitor_language=visitor_language)
      → build_hybrid_prompt(..., visitor_language=visitor_language)
          → if bot.language_config.get("enabled"):
                _language_directive = f"""
                CONVERSATION LANGUAGE
                Language: {language_name(visitor_language)}
                Locale: {session.locale}

                RULES
                - Respond in {language_name(visitor_language)}.
                - Do not switch language automatically.
                - Preserve product names, URLs, and plan names exactly.
                - Follow an explicit language request from the visitor.
                """
            else:
                _language_directive = ""  # response_style.py's existing
                                           # Section 10 instruction still applies
          → hybrid_system_prompt = f"...{currency_directive}...{_language_directive}...{response_style_block}"
```

`qualification_service.py`'s `build_qualification_response` (line 696) and the
dimension-selection logic (`select_next_probe_dimension`, line 604) are
unaffected in structure — only the `cta_prompt` *text* returned to the widget
changes, via the new `_localize_cta_prompt` lookup applied at the point where
`cta_prompt` is read for display (need to confirm the exact read site during
implementation — the research pass found the string definitions but not every
call site that surfaces them to the widget; treat this as an implementation-
time grep, not a guess).

## Dependencies on previous phases

- **Phase 1**: `language_service.py`, `Bot.language_config`.
- **Phase 2**: `ChatSession.language_code`/`locale`/`language_locked` must be
  populated before this phase has anything meaningful to consume. Phase 3
  cannot ship independently of Phase 2 — it has no signal source otherwise.

## Exact implementation steps

1. Add `visitor_language` parameter to `rag_pipeline_stream` signature.
2. Add `visitor_language` parameter to `build_hybrid_prompt` signature.
3. Implement `_language_directive` construction, gated on
   `bot.language_config.get("enabled")`, mirroring the `currency_directive`
   pattern exactly (same file, same function, same splice style).
4. Update the QA cache key construction (`qa_response_key`) to include
   language.
5. Update `chat_stream_endpoint`'s call to `rag_pipeline_stream` to pass
   `visitor_language=session.language_code`.
6. Implement `language_service.detect_message_language` for real (Phase 1 left
   it stubbed) — a lightweight heuristic/classifier, invoked from
   `_resolve_visitor_language` (Phase 2's helper) only in the "no other signal
   available" branch, per the source plan's cost-control rule ("skip detection
   when session language already known").
7. Add a static translation table for the ~20 preset `cta_prompt` strings
   (en/hi pilot pair) and wire `_localize_cta_prompt` into
   `qualification_service.py`'s response-surfacing path.
8. Regression-test that `bot.language_config.enabled=false` bots produce
   byte-identical prompts to pre-Phase-3 behavior (empty `_language_directive`,
   unchanged cache key shape if language is `None`/omitted for those bots —
   confirm the cache-key change doesn't alter the *existing* cache-key format
   for unconfigured bots, to avoid a mass cache invalidation on deploy).

## Acceptance criteria

- [ ] With `language_config.enabled=true` and a Hindi `ChatSession`, AI
      responses are in Hindi, retrieval still hits the existing (English-only
      or mixed-language) knowledge base unified index.
- [ ] BANT qualification follow-up questions are generated in the active
      session language (per the source plan's example: "What is your expected
      implementation timeline?" → "आपकी अपेक्षित implementation timeline क्या
      है?").
- [ ] Preset `cta_prompt` pill labels render in the active session language
      for the en/hi pilot pair; custom (bot-overridden) `cta_prompt` values
      render in their original (untranslated) text with no error.
- [ ] QA cache does not serve a wrong-language cached response across the
      language boundary.
- [ ] Bots with `language_config.enabled=false` (the default) show zero
      change in prompt construction, cache-key format, or response content
      versus pre-Phase-3 behavior.
- [ ] Stored BANT dimension values (numeric scores, tier) remain canonical/
      language-independent — only user-facing phrasing changes.

## Testing/QA requirements

- RAG test matrix (source plan §33.4): English/English, Hindi/English,
  Spanish/English, French/English, German/English, Hindi/mixed-English-Hindi
  KB → verify expected response language in each row.
- Prompt-construction unit test: `build_hybrid_prompt` with
  `visitor_language="hi"` and `language_config.enabled=true` includes the
  `_language_directive` block; with `enabled=false`, does not (and
  `response_style.py`'s Section 10 is still present, since it's unconditional).
- Cache-key regression test: confirm existing cache entries for unconfigured
  bots remain valid after deploy (no forced invalidation), and that the same
  question asked with different `visitor_language` values misses the cache
  correctly.
- Qualification test: preset `cta_prompt` strings render correctly for en/hi;
  a custom `cta_prompt` renders unchanged (no crash, no partial translation).

## Risks and edge cases

- **Cache-key backward compatibility.** The QA cache key format change is the
  highest-risk item in this phase — get the exact hashing scheme right so
  `enabled=false` bots don't silently get a 100% cache-miss rate on deploy
  (a latency/cost regression, not a correctness bug, but worth avoiding).
- **Mixed-language messages.** "Hi, mujhe pricing ke baare mein batao" should
  not flip the resolved session language on every turn — Phase 2 already
  avoids re-resolving once a session language is set; Phase 3's
  `detect_message_language` is only invoked on the *first* unresolved turn,
  not every turn, so this risk is largely mitigated by Phase 2's design, but
  verify the interaction explicitly in testing.
- **Custom `cta_prompt` values staying English while everything else is
  Hindi** is a known, accepted V1 gap (documented above) — surface this
  clearly to the product team rather than silently shipping half-translated
  qualification UI.
- **Preserving exact product/plan/URL names** — the `_language_directive`'s
  "preserve product names, URLs, and plan names exactly" rule needs the same
  QA attention the source plan calls out; verify with a test case that
  includes a plan name and a URL in a non-English conversation.

## Rollback considerations

- All changes in this phase are gated behind `bot.language_config.enabled`
  (Phase 1's default-false flag) — disabling that flag for a specific bot (or
  never enabling it) is a complete, instant rollback with no code revert
  needed.
- If a full code rollback is needed: reverting `rag_service.py`/
  `response_style.py`/`qualification_service.py` changes is safe since no
  schema changed in this phase; the QA cache may need a manual flush if the
  key format reverted mid-flight (stale-format keys from the rolled-back
  version would simply miss under the reverted key scheme, which is safe but
  wastes cache).
