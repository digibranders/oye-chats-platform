# Brand Tone v2 — Preset Templates + Auto-Detect + Live Preview

**Status:** Approved design · **Date:** 2026-07-09 · **Area:** Admin dashboard → Bot Settings → AI & Personality tab
**Depends on:** the crawl auto-fill lock (`manual_field_overrides`) shipped 2026-07-09 (migration `b3d1c5e7a9f2`).

---

## 1. Problem & Goal

`brand_tone` is today a single free-form textarea. The website crawl auto-extracts a
free-form description via `llm_service.extract_brand_tone` and (now) writes it only when
the field isn't locked. Free-form text is expressive but gives the customer a blank page,
produces inconsistent quality, and offers no guided starting point.

**Goal:** make Brand Tone guided, consistent, and tangible without losing expressiveness:

- Offer a curated set of **preset tone templates** the customer can pick with one click.
- Have the **crawler classify** the site into the closest preset automatically.
- Let the customer **re-detect** tone on demand (no full re-crawl).
- Let the customer **preview** how the bot will actually sound before saving.
- Keep the **editable free text as the source of truth** so nuance is never lost, and so
  everything downstream (prompt injection, the lock mechanism) is unchanged.

## 2. Non-Goals (YAGNI)

- Super-admin-editable preset catalog (presets are a fixed curated list in code).
- Multi-select trait modifiers (`+Concise`, `+Empathetic`) layered on a base preset.
- Per-message / A-B tone experimentation.
- Any change to how `company_name` / `company_description` behave.

## 3. Key Constraint (grounds the whole design)

`brand_tone` reaches the LLM as free text, truncated to 300 chars:

```
# api/app/services/rag_service.py:3535
tone_section = f"\n\nBRAND TONE: {brand_tone[:300]}" if brand_tone else ""
```

Therefore a "preset" must ultimately resolve to good prompt-ready text ≤ ~280 chars.
Presets are a UI/authoring convenience on top of the existing text field — **not** a
replacement for it. No change to prompt construction is required.

## 4. Data Model

Keep `Bot.brand_tone` (Text) exactly as-is — the prompt source of truth, already
lock-protected. Add **one** metadata column:

| Column | Type | Meaning |
|---|---|---|
| `brand_tone_preset` | `String`, nullable | Which chip to highlight. One of the 8 preset keys, `"custom"` (text edited away from any preset), or `NULL` (empty / never set). |

`brand_tone_preset` is **descriptive metadata only** — it never feeds the prompt and is
never independently locked. It is written alongside `brand_tone` and follows it: when the
crawl/detect writes `brand_tone`, it writes the matching key; when the user edits the text,
the frontend sets `"custom"`; when cleared, `NULL`.

Migration: new alembic revision on top of `b3d1c5e7a9f2`, adds the nullable column
(`server_default` NULL — existing rows read as `NULL` = "no chip highlighted", which is
correct and non-breaking).

## 5. The Presets (single source of truth)

Defined **once** in a new backend module `api/app/services/brand_tone.py` and served to the
frontend via a static endpoint (§7). No duplicated copy in JS → no drift.

```python
# api/app/services/brand_tone.py  (illustrative)
BRAND_TONE_PRESETS: list[dict] = [
    {"key": "professional", "label": "Professional",
     "text": "Professional and polished. Clear, competent, and businesslike. "
             "Avoids slang and filler; stays respectful and confident without being stiff."},
    {"key": "friendly", "label": "Friendly",
     "text": "Warm, friendly, and approachable. Conversational and personable, like a "
             "helpful teammate. Uses plain language and a positive, encouraging tone."},
    {"key": "playful", "label": "Playful",
     "text": "Playful and lighthearted. Casual, witty, and upbeat, with the occasional "
             "tasteful emoji. Keeps things fun while still being genuinely helpful."},
    {"key": "concise", "label": "Concise & Direct",
     "text": "Concise and direct. Gets to the point fast with short sentences and no "
             "filler. Prioritizes clear answers over pleasantries."},
    {"key": "empathetic", "label": "Empathetic",
     "text": "Empathetic and reassuring. Patient, understanding, and supportive. "
             "Acknowledges the visitor's concern and offers calm, caring guidance."},
    {"key": "technical", "label": "Technical / Expert",
     "text": "Technical and precise. Speaks with domain expertise and correct "
             "terminology, assuming a knowledgeable audience. Prioritizes accuracy over simplification."},
    {"key": "luxury", "label": "Luxury / Premium",
     "text": "Refined and premium. Elegant, polished, and aspirational language that "
             "conveys quality and exclusivity. Understated confidence, never pushy."},
    {"key": "bold", "label": "Bold / Confident",
     "text": "Bold and confident. Assertive, punchy, and opinionated. Makes strong, "
             "direct statements and champions the brand with energy."},
]

PRESET_KEYS: frozenset[str] = frozenset(p["key"] for p in BRAND_TONE_PRESETS)

def preset_text(key: str) -> str | None: ...   # key -> canonical text, or None
```

Every `text` is authored ≤ 280 chars so it survives the `[:300]` truncation intact.

## 6. Behavior Matrix (reuses the existing lock)

The lock stays keyed on the `brand_tone` field in `Bot.manual_field_overrides`
(`_reconcile_manual_overrides` already covers it — no change there). `brand_tone_preset`
rides along.

| Action | `brand_tone` | `brand_tone_preset` | Lock (`manual_field_overrides`) |
|---|---|---|---|
| Full crawl, field **unlocked** | ← classified preset's text | ← detected key | unchanged (stays unlocked = auto) |
| Full crawl, field **locked** | untouched | untouched | untouched |
| Click a chip → **Save** | ← preset's canonical text | ← that key | **locks** (value changed to non-empty) |
| Edit the textarea → **Save** | user's text | `"custom"` (set by FE on edit) | **locks** |
| Clear textarea → **Save** | empty → `NULL` | `NULL` | **unlocks** → next crawl re-detects |
| **✨ Detect from website** | ← re-classified text | ← key | **unlocks** (explicit "make it auto") |

Rationale for Detect → unlock: the user is explicitly asking for the auto value, so future
crawls should keep refreshing it until they edit again. This mirrors the "auto value present
but unlocked" state the company fields already use after a crawl.

## 7. API Contracts

All three live in `api/app/api/bot_routes.py`. Auth: reuse `get_current_client_or_operator`
+ `_require_bot_management_access` (same as `update_bot`). Rate-limit the two LLM endpoints
via the existing SlowAPI limiter.

### 7.1 `GET /bots/brand-tone-presets`
Static catalog for rendering chips + prefilling text on click. No auth-sensitive data;
still behind the standard client auth for consistency. Cacheable.
**Routing note:** the router already defines `GET /{bot_id}` (int path param). A literal
segment like `brand-tone-presets` fails int-validation and would 422 under `/{bot_id}`.
Register this static route **before** the `/{bot_id}` route so FastAPI matches it first
(route registration order wins). The `/{bot_id}/brand-tone/...` endpoints don't collide.
```json
{ "presets": [ { "key": "professional", "label": "Professional", "text": "Professional and polished. ..." }, ... ] }
```

### 7.2 `POST /bots/{bot_id}/brand-tone/detect`
Re-classify from the bot's **already-crawled** documents — no re-crawl.
- Load bot (ownership-checked). Sample content from stored `Document` rows for the bot
  (new repository helper `get_content_sample_for_bot(session, bot_id, max_chars=4000)`:
  first N chunks' `.text`, joined, truncated).
- If no crawled content → `400 {"detail": "Crawl your website first to detect its tone."}`.
- Run `llm_service.classify_brand_tone(sample)` → preset key (§8).
- Set `bot.brand_tone = preset_text(key)`, `bot.brand_tone_preset = key`; discard
  `"brand_tone"` from `bot.manual_field_overrides` (unlock). Commit. Invalidate
  `bot_config_key(bot.bot_key)` cache (same as `update_bot`).
- Response: `{ "brand_tone": "...", "brand_tone_preset": "professional" }`.

Note: this commits immediately (an explicit user action, like an upload), independent of the
form's Save button — matching the existing logo-upload pattern.

### 7.3 `POST /bots/{bot_id}/brand-tone/preview`
Generate a sample bot reply in the **current draft** tone (unsaved, so the user can iterate).
- Request body: `{ "brand_tone": "<current textarea text>" }` (≤ 500 chars, validated).
- Sample question: fixed default **"Can you tell me about your services?"** (v1 — not
  pulled from `services`).
- Call `llm_service.generate_tone_sample(brand_tone, question)` → 1–2 sentence string
  (gate-tier model, `max_tokens ≈ 80`).
- Response: `{ "sample": "..." }`. On LLM failure → `503 {"detail": "Preview unavailable, try again."}`.
- Reads nothing from and writes nothing to the DB except the ownership check → cheap, safe
  to rate-limit tightly.

### 7.4 Schema additions (`bot_routes.py`)
- `UpdateBotRequest`: add `brand_tone_preset: str | None = None` with a validator that
  accepts only a value in `PRESET_KEYS ∪ {"custom"}` or `None` (reject unknown strings).
- `BotResponse`: add `brand_tone_preset: str | None = None`; populate in both constructors
  (list at ~L1024 and detail at ~L1390) as `b.brand_tone_preset` / `bot.brand_tone_preset`.

## 8. LLM Service Functions (`api/app/services/llm_service.py`)

Mirror the existing gate-tier, fail-safe, Langfuse-wrapped pattern of `extract_brand_tone`.

### 8.1 `classify_brand_tone(content_sample, *, metadata=None) -> str | None`
- Prompt lists the 8 preset keys+labels and asks for the single best-matching **key**.
- Constrained output → parse/normalize to a known key; if the model returns anything not in
  `PRESET_KEYS`, return `None` (caller then leaves tone untouched). Returns `None` on empty
  input or any error (non-blocking), exactly like the current extractor.
- `max_tokens ≈ 10`. Gate model via `runtime_config.get_gate_model()`.

### 8.2 `generate_tone_sample(brand_tone, question, *, metadata=None) -> str | None`
- Prompt: "Reply to the visitor question in 1–2 short sentences, strictly in this brand
  voice: `<brand_tone>`. Return only the reply." + the question.
- `max_tokens ≈ 80`; trims/caps output length; returns `None`/raises→503 on failure.

### 8.3 `extract_brand_tone`
**Retired** from the crawl path in favor of `classify_brand_tone`. Delete the function (no
other callers — verify with grep before removing) to avoid dead code. Its Langfuse
generation name `brand-tone-extraction` is replaced by `brand-tone-classification`.

## 9. Crawler Change (`api/app/services/crawl_orchestrator.py`)

In the metadata-write block (currently ~L457–L499, already guarded by
`overrides = set(bot_db.manual_field_overrides or [])`):

- Replace the `extract_brand_tone` call in the `asyncio.gather` with `classify_brand_tone`,
  yielding a preset **key** instead of free text.
- Under the existing `"brand_tone" not in overrides` guard, set **both**:
  `bot_db.brand_tone = preset_text(key)` and `bot_db.brand_tone_preset = key` (only when
  `key` is a valid preset). `company_*` handling is unchanged.
- Update the summary log to record the detected key.

Both API and worker crawl paths run through `run_full_crawl`, and `recrawl` also routes
here — so this is the single write site.

## 10. Frontend

### 10.1 `services/api.js`
Add: `getBrandTonePresets()` → `GET /bots/brand-tone-presets`;
`detectBrandTone(botId)` → `POST /bots/{id}/brand-tone/detect`;
`previewBrandTone(botId, brandTone)` → `POST /bots/{id}/brand-tone/preview`.

### 10.2 `BotSettings.jsx` (shell owns orchestration, per existing pattern)
- `DEFAULT_DRAFT`: add `brand_tone_preset: null`.
- `fetchSettings`: map `brand_tone_preset: settings.brand_tone_preset ?? null`.
- `handleSave` payload: add `brand_tone_preset: draft.brand_tone_preset || null`.
- New `handleDetectTone()`: calls `detectBrandTone`, on success sets `draft.brand_tone`,
  `draft.brand_tone_preset`, and removes `"brand_tone"` from
  `draft.manual_field_overrides`; toasts success; 400 → info toast "Crawl your website first".
- New `handleTonePreview()`: calls `previewBrandTone(botId, draft.brand_tone)`, returns the
  sample string (state held for the preview pane); guards empty tone.
- Pass `onDetectTone`, `onPreviewTone`, `presets`, `detecting`, `previewing`,
  `tonePreviewSample` (+ `selectedBot` gating) into `PersonalityTab`. Load presets once on
  mount (or lazily when the tab opens).

### 10.3 `PersonalityTab.jsx` (Brand Tone card)
Layout, top → bottom:
1. Header: "Brand Voice & Tone" + right-aligned **✨ Detect from website** button
   (disabled when no `selectedBot`/website or while `detecting`; spinner while running).
2. **Chip row**: one chip per preset, single-select. Active chip = `draft.brand_tone_preset`.
   Click → `set('brand_tone', preset.text)` + `set('brand_tone_preset', preset.key)`.
   When `brand_tone_preset === 'custom'` no chip is highlighted (a subtle "Custom" pill shows).
3. **Textarea** (existing, max 500). `onChange` → `set('brand_tone', v)` **and**
   `set('brand_tone_preset', 'custom')` (unless the new value exactly equals a preset's text).
4. Footer: existing counter + **reuse `AutoFillHint field="brand_tone"`** (built in the prior
   fix) + a **Preview voice** button that calls `onPreviewTone`.
5. Preview output: render the returned sample as a bot bubble — reuse the right-side live
   preview pane (preferred) or an inline bubble under the card. v1: inline bubble under the
   card is acceptable if wiring the preview pane is heavier.

The `AutoFillHint` from the previous fix already renders the auto/locked/empty states, so the
"edits are kept on re-crawl / clear to re-enable" messaging is inherited for free.

## 11. Testing

**Backend (pure logic, no DB — mirrors `test_bot_manual_field_overrides.py`):**
- `brand_tone.py`: `preset_text` returns canonical text for each key and `None` for unknown;
  every preset `text` is ≤ 280 chars; keys are unique.
- `UpdateBotRequest` validator: accepts a valid key, `"custom"`, `None`; rejects garbage.
- `classify_brand_tone` (mocked `litellm.completion`): valid key passes through; out-of-set
  model output → `None`; empty input → `None`.
- `generate_tone_sample` (mocked): returns trimmed sample; LLM error → `None`.

**Backend (endpoint, mocked LLM / test session):**
- `detect`: no crawled docs → 400; with docs → writes both fields + unlocks.
- `preview`: returns sample; empty `brand_tone` → 422/400; LLM failure → 503.
- `GET presets`: returns all 8.

**Frontend:** `npm run lint` (0 new errors) + `npm run build` succeeds.

## 12. Migration & Rollout

- Alembic revision adds `brand_tone_preset` (nullable, default NULL). Backward-compatible:
  existing bots show no highlighted chip until their next crawl / detect / manual pick.
- No backfill: we can't reliably reverse-map existing free-text tone to a preset key, and the
  free text keeps working unchanged as `"custom"`-equivalent (NULL → no chip, text still used).
- Deploy order: API (schema + endpoints) before the admin app that calls the new endpoints.
- Follows repo workflow: branch off `development`; run baseline checks (ruff/format/pytest for
  API; lint/build for `app/`); PR `development → main`.

## 13. Edge Cases & Decisions

- **Detect with a locked field:** Detect intentionally overrides the lock (it *is* the user
  asking for auto) — it unlocks and rewrites. This differs from a background crawl, which
  respects the lock. Documented in the button's behavior.
- **Preset text vs user text drift:** After picking a preset the user may tweak one word →
  becomes `"custom"`; that's expected and locks on save. We do not try to "re-snap" edited
  text back to a preset.
- **Truncation:** all canonical preset texts are authored < 280 chars; a `custom` value is
  still capped at 500 by the field and truncated to 300 at prompt build — unchanged behavior.
- **Preview cost/abuse:** gate-tier model, `max_tokens ≈ 80`, SlowAPI rate limit, ownership
  check. Preview never persists.
- **Stale `brand_tone_preset` after Save:** the prior fix already re-pulls settings after a
  successful save, so the chip highlight and lock state reconcile to server truth immediately.

## 14. Files Touched (summary)

**Backend:** `app/services/brand_tone.py` (new) · `db/models.py` (+col) · new alembic
revision · `api/bot_routes.py` (schemas, 3 endpoints) · `services/crawl_orchestrator.py`
(classify + guarded write of both fields) · `services/llm_service.py`
(`classify_brand_tone`, `generate_tone_sample`, remove `extract_brand_tone`) ·
`db/repository.py` (`get_content_sample_for_bot`). **Frontend:** `services/api.js` (3 calls)
· `pages/BotSettings.jsx` · `pages/bot-settings/PersonalityTab.jsx`. **Tests:** new
`tests/test_brand_tone.py` (+ endpoint tests).
