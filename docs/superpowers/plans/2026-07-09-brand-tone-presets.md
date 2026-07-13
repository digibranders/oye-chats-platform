# Brand Tone v2 — Presets + Auto-Detect + Live Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Phases are ordered by dependency; **Phase 1 (backend foundation) must land before Phase 4 (frontend)**. Design source of truth: `docs/superpowers/specs/2026-07-09-brand-tone-presets-design.md`.

**Goal:** Turn the free-form Brand Tone field into a guided, preset-driven, fully-functional feature: 8 curated tone presets the crawler auto-classifies into, a one-click **Detect from website** re-classify, and a live **Preview voice** sample — while keeping the editable free text as the prompt source of truth and reusing the `manual_field_overrides` lock shipped 2026-07-09.

**Architecture:** `brand_tone` (Text) stays the source of truth injected into the prompt (`BRAND TONE: {brand_tone[:300]}`). A new nullable `brand_tone_preset` column records which chip to highlight. Presets are defined **once** in `api/app/services/brand_tone.py` and served to the frontend, so there is no JS/Python drift. The crawler classifies into the nearest preset (replacing free-form `extract_brand_tone`) and writes both fields under the existing lock guard. Two new LLM-backed endpoints power on-demand detect and preview.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Alembic + LiteLLM (`api/`); React 19 + Vite (`app/`). Gates: `cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest` (run inside conda `oye`); `cd app && npm run lint && npm run build`.

**Branch:** `development` (verify `git branch --show-current` before every commit). PR `development → main` at the end.

---

## File Structure

**Backend**
- **Create** `api/app/services/brand_tone.py` — `BRAND_TONE_PRESETS`, `PRESET_KEYS`, `preset_text(key)`.
- **Create** alembic revision `*_bot_brand_tone_preset.py` (down_revision = `b3d1c5e7a9f2`).
- **Modify** `api/app/db/models.py` — add `Bot.brand_tone_preset` column.
- **Modify** `api/app/db/repository.py` — add `get_content_sample_for_bot(session, bot_id, max_chars=4000)`.
- **Modify** `api/app/services/llm_service.py` — add `classify_brand_tone`, `generate_tone_sample`; remove `extract_brand_tone`.
- **Modify** `api/app/services/crawl_orchestrator.py` — classify → preset key; write `brand_tone` + `brand_tone_preset` under the existing override guard.
- **Modify** `api/app/api/bot_routes.py` — `UpdateBotRequest`/`BotResponse` fields; `GET /bots/brand-tone-presets`; `POST /bots/{id}/brand-tone/detect`; `POST /bots/{id}/brand-tone/preview`.
- **Create** `api/tests/test_brand_tone.py` — pure-logic + mocked-LLM + endpoint tests.

**Frontend**
- **Modify** `app/src/services/api.js` — `getBrandTonePresets`, `detectBrandTone`, `previewBrandTone`.
- **Modify** `app/src/pages/BotSettings.jsx` — draft field, save payload, `handleDetectTone`, `handleTonePreview`, preset load, prop plumbing.
- **Modify** `app/src/pages/bot-settings/PersonalityTab.jsx` — chip row, Detect button, Preview button, preview bubble.

---

# PHASE 1 — Backend foundation: presets module + schema + migration

**Definition of done:** `brand_tone_preset` column exists; presets module importable; `UpdateBotRequest`/`BotResponse` round-trip the new field; migration is a single linear head. Gates green.

### Task 1.1: Presets module
**Files:** Create `api/app/services/brand_tone.py`
- [ ] Define `BRAND_TONE_PRESETS: list[dict]` — the 8 presets from spec §5 (`key`, `label`, `text`). Author every `text` ≤ 280 chars.
- [ ] Define `PRESET_KEYS: frozenset[str]` and `preset_text(key: str) -> str | None`.
- [ ] Add a module docstring pointing at the spec. No LLM imports here (pure data + lookup).

### Task 1.2: Model column
**Files:** Modify `api/app/db/models.py` (`class Bot`, next to `brand_tone` ~L223)
- [ ] Add `brand_tone_preset = Column(String, nullable=True)` with a comment: preset key / `"custom"` / NULL; descriptive metadata for chip highlight, never fed to the prompt.

### Task 1.3: Migration
**Files:** Create `api/alembic/versions/<rev>_bot_brand_tone_preset.py`
- [ ] `revision` new; `down_revision = "b3d1c5e7a9f2"`. `upgrade`: `op.add_column("bots", sa.Column("brand_tone_preset", sa.String(), nullable=True))`. `downgrade`: `op.drop_column`.
- [ ] Verify single head: `uv run alembic heads` → exactly one.

### Task 1.4: Schema fields
**Files:** Modify `api/app/api/bot_routes.py`
- [ ] `UpdateBotRequest`: add `brand_tone_preset: str | None = None` + a `field_validator` that accepts only `value in (PRESET_KEYS | {"custom"})` or `None`; raise `ValueError` otherwise (import from `brand_tone`).
- [ ] `BotResponse`: add `brand_tone_preset: str | None = None`; populate in **both** constructors (list ~L1024, detail ~L1390).

**Gate:** `uv run ruff check . && uv run ruff format --check . && uv run pytest -q` (pytest may hit the coverage floor when run narrowly — run the full suite for the real gate).
- [ ] Commit: `feat(bot): add brand_tone_preset column + schema + presets module`.

---

# PHASE 2 — LLM functions: classify + preview sample

**Definition of done:** `classify_brand_tone` returns a valid preset key or `None`; `generate_tone_sample` returns a short string or `None`; `extract_brand_tone` removed with no dangling callers.

### Task 2.1: `classify_brand_tone`
**Files:** Modify `api/app/services/llm_service.py`
- [ ] Add `classify_brand_tone(content_sample, *, metadata=None) -> str | None`, mirroring `extract_brand_tone`'s gate-tier / Langfuse / fail-safe shape (spec §8.1). Prompt lists the 8 keys+labels; ask for the single best **key** only. `max_tokens ≈ 10`.
- [ ] Normalize model output (lowercase/strip) and return it only if `in PRESET_KEYS`, else `None`. Return `None` on empty input / any exception. Langfuse name `brand-tone-classification`.

### Task 2.2: `generate_tone_sample`
**Files:** Modify `api/app/services/llm_service.py`
- [ ] Add `generate_tone_sample(brand_tone, question, *, metadata=None) -> str | None` (spec §8.2): 1–2 sentence reply strictly in the given voice; `max_tokens ≈ 80`; trim + cap output; `None`/raise on failure. Langfuse name `brand-tone-preview`.

### Task 2.3: Remove `extract_brand_tone`
- [ ] `grep -rn "extract_brand_tone" api/app` → confirm the crawl orchestrator is the only caller (updated in Phase 3). Remove the function after Phase 3 wiring, or in this task guard by leaving it until 3.1 lands (either order; end state = deleted, no callers).

**Gate:** ruff + targeted mocked-LLM tests (added in Phase 5). Commit: `feat(llm): classify_brand_tone + generate_tone_sample; drop free-form extract`.

---

# PHASE 3 — Crawler + repository

**Definition of done:** a full crawl (and re-crawl) sets `brand_tone` to a preset's canonical text and `brand_tone_preset` to the key, **only when unlocked**; `company_*` behavior unchanged. Content sampling helper available for the detect endpoint.

### Task 3.1: Crawler classify + guarded write
**Files:** Modify `api/app/services/crawl_orchestrator.py` (metadata block ~L457–L499)
- [ ] Replace the `extract_brand_tone` call in the `asyncio.gather` with `classify_brand_tone` → yields a preset **key**.
- [ ] Under the existing `if ... "brand_tone" not in overrides` guard, set both `bot_db.brand_tone = preset_text(key)` and `bot_db.brand_tone_preset = key` when `key` is valid. Leave `company_*` logic as-is.
- [ ] Update the summary log line to record the key.

### Task 3.2: Content-sample repository helper
**Files:** Modify `api/app/db/repository.py`
- [ ] Add `get_content_sample_for_bot(session, bot_id, max_chars=4000) -> str`: select the first few `Document` rows for the bot (ownership via existing `_owner_filter`), join `.text`, truncate to `max_chars`. Return `""` when the bot has no documents.

**Gate:** ruff + `uv run pytest -q`. Commit: `feat(crawl): classify brand tone into presets under override guard`.

---

# PHASE 4 — API endpoints: presets, detect, preview

**Definition of done:** the three endpoints behave per spec §7; presets route is not shadowed by `/{bot_id}`; LLM endpoints are rate-limited and ownership-checked.

### Task 4.1: `GET /bots/brand-tone-presets`
**Files:** Modify `api/app/api/bot_routes.py`
- [ ] Register **before** the `GET /{bot_id}` route (registration order wins) so the literal path isn't captured by the int path param. Return `{"presets": BRAND_TONE_PRESETS}`. Standard client auth.

### Task 4.2: `POST /bots/{bot_id}/brand-tone/detect`
- [ ] Auth + `_require_bot_management_access`; load workspace bot. Sample via `get_content_sample_for_bot`; empty → `400 "Crawl your website first to detect its tone."`.
- [ ] `key = classify_brand_tone(sample)`; if `None` → `422 "Could not detect a tone; pick one manually."`.
- [ ] Set `bot.brand_tone = preset_text(key)`, `bot.brand_tone_preset = key`; remove `"brand_tone"` from `bot.manual_field_overrides` (reassign a new list so SQLAlchemy sees the change). Commit; `cache_delete(bot_config_key(bot.bot_key))`.
- [ ] Return `{"brand_tone": ..., "brand_tone_preset": key}`. SlowAPI rate limit.

### Task 4.3: `POST /bots/{bot_id}/brand-tone/preview`
- [ ] Body model `{brand_tone: str}` (`max_length=500`, non-empty). Ownership check only (no write).
- [ ] `sample = generate_tone_sample(brand_tone, "Can you tell me about your services?")`; `None` → `503 "Preview unavailable, try again."`.
- [ ] Return `{"sample": sample}`. Tight SlowAPI rate limit (LLM cost).

**Gate:** ruff + `uv run pytest -q`. Commit: `feat(bot): brand-tone presets, detect, and preview endpoints`.

---

# PHASE 5 — Backend tests

**Definition of done:** new tests pass under the full suite; coverage floor satisfied by the full run.

### Task 5.1: Pure-logic tests
**Files:** Create `api/tests/test_brand_tone.py`
- [ ] `preset_text` returns text for each key, `None` for unknown; all 8 `text` ≤ 280 chars; keys unique.
- [ ] `UpdateBotRequest` validator: accepts a valid key / `"custom"` / `None`; rejects `"bogus"`.

### Task 5.2: Mocked-LLM tests
- [ ] `classify_brand_tone` (patch `litellm.completion`): valid key passes; out-of-set output → `None`; empty input → `None`.
- [ ] `generate_tone_sample`: returns trimmed sample; exception → `None`.

### Task 5.3: Endpoint tests
- [ ] `detect`: no docs → 400; with docs (patched classify) → both fields written + `"brand_tone"` removed from overrides.
- [ ] `preview`: valid → sample; empty body → 422; LLM `None` → 503.
- [ ] `GET presets` → 8 presets.

**Gate:** `cd api && uv run pytest` (full suite) green. Commit: `test(bot): brand tone presets, detect, preview`.

---

# PHASE 6 — Frontend

**Definition of done:** the Brand Tone card shows chips + Detect + Preview; picking a chip fills text and highlights; editing marks `custom`; Detect re-classifies and unlocks; Preview shows a sample; save round-trips `brand_tone_preset`. Lint + build clean.

### Task 6.1: API client
**Files:** Modify `app/src/services/api.js`
- [ ] `getBrandTonePresets()` → `GET /bots/brand-tone-presets`.
- [ ] `detectBrandTone(botId)` → `POST /bots/{botId}/brand-tone/detect`.
- [ ] `previewBrandTone(botId, brandTone)` → `POST /bots/{botId}/brand-tone/preview` with `{brand_tone}`.

### Task 6.2: Shell wiring
**Files:** Modify `app/src/pages/BotSettings.jsx`
- [ ] `DEFAULT_DRAFT`: add `brand_tone_preset: null`. `fetchSettings`: `brand_tone_preset: settings.brand_tone_preset ?? null`. `handleSave` payload: `brand_tone_preset: draft.brand_tone_preset || null`.
- [ ] Load presets once (`useState` + effect calling `getBrandTonePresets`, tolerate failure → empty list).
- [ ] `handleDetectTone()`: `detectBrandTone(selectedBot?.id)`; on success `setDraft` with new `brand_tone`, `brand_tone_preset`, and `manual_field_overrides` minus `"brand_tone"`; toast success. 400 → info toast "Crawl your website first". Track `detecting` state.
- [ ] `handleTonePreview()`: guard empty `draft.brand_tone`; `previewBrandTone(selectedBot?.id, draft.brand_tone)`; store `tonePreviewSample`; track `previewing`; 503 → error toast.
- [ ] Pass `presets`, `onDetectTone`, `detecting`, `onPreviewTone`, `previewing`, `tonePreviewSample` into `PersonalityTab`.

### Task 6.3: Brand Tone card
**Files:** Modify `app/src/pages/bot-settings/PersonalityTab.jsx`
- [ ] Header: keep title, add right-aligned **✨ Detect from website** button (disabled without `selectedBot`/website or while `detecting`; spinner while running).
- [ ] Chip row: map `presets` to single-select chips; active = `draft.brand_tone_preset`; click → `set('brand_tone', p.text)` + `set('brand_tone_preset', p.key)`. Show a subtle "Custom" pill when `brand_tone_preset === 'custom'`.
- [ ] Textarea `onChange`: `set('brand_tone', v)`; set `brand_tone_preset` to `'custom'` unless `v` exactly equals a preset's text (then set that key).
- [ ] Footer: keep counter; **reuse `AutoFillHint field="brand_tone"`**; add **Preview voice** button (disabled when empty/`previewing`).
- [ ] Render `tonePreviewSample` as a bot bubble under the card (inline is acceptable for v1; wiring the right-side preview pane is optional polish).

**Gate:** `cd app && npm run lint && npm run build`. Commit: `feat(app): brand tone presets, detect, and voice preview UI`.

---

# PHASE 7 — Verify, docs, PR

- [ ] Manual smoke (dev stack per CLAUDE.md — API + worker + admin): fresh bot → crawl → chip auto-highlights + text filled + `AutoFillHint` shows "auto"; pick a different chip → text swaps, save → locked; edit text → `Custom` + save → locked; clear + save → unlocks; **Detect** on a crawled bot → re-classifies + unlocks; **Preview voice** → sample bubble.
- [ ] Re-run all gates (API ruff/format/pytest; app lint/build). Fix until clean.
- [ ] Update `docs/` if the AI & Personality tab is documented anywhere; note the new endpoints.
- [ ] Deploy order reminder: **API before admin app** (frontend calls new endpoints). Apply migration (`alembic upgrade head` / `dev.sh`).
- [ ] Open PR `development → main`.

---

## Risks & Mitigations
- **Route shadowing** (`/bots/brand-tone-presets` vs `/{bot_id}`) → register static route first (Task 4.1). Covered by a `GET presets` test.
- **LLM cost/abuse on preview** → gate-tier model, `max_tokens ≈ 80`, SlowAPI limit, no persistence.
- **Classifier drift** (model returns non-key) → strict `PRESET_KEYS` membership; `None` leaves tone untouched (crawl) or 422 (detect).
- **Preset text > 300 chars** → author ≤ 280; a unit test asserts the cap.
- **Existing bots** → `brand_tone_preset` NULL = no chip highlighted; free text still works. No backfill (can't reliably reverse-map text → key).
