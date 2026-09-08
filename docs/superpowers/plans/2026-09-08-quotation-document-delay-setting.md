# Per-Bot Quotation Document Delay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each client choose, from the quotation editor in the admin dashboard, how long after a visitor accepts a quote the priced "Your quotation" document email is deferred — replacing the current hardcoded 10-minute (`QUOTATION_EMAIL_DELAY_SECONDS`) global constant with a per-bot, per-catalog setting.

**Architecture:** `Bot.quotation_catalog` is already a loose JSONB blob validated end-to-end by a Pydantic model (`QuotationCatalog` in `api/app/api/quotation_routes.py`) and mirrored field-for-field by a TypeScript model (`quotation.model.ts`). The delay becomes one more field on that same catalog — `document_delay_seconds` — so it needs **no new database column and no migration**. `_schedule_quotation_emails` reads the value off the bot's own normalized catalog instead of the global constant when it computes the ARQ `_defer_by` window. The global constant `QUOTATION_EMAIL_DELAY_SECONDS` stays: it becomes the field's default, so every bot saved before this change keeps behaving exactly as it does today (10 minutes) until an admin picks something else. The admin UI adds one `Select` (a fixed set of presets, not a freeform number field) next to the existing Currency card.

**Tech Stack:** FastAPI + Pydantic (validation), SQLAlchemy/JSONB (no schema change), ARQ (`_defer_by` deferred job), React 19 + TypeScript (admin dashboard), Vitest (frontend tests), pytest (backend tests), the project's flat-key i18n dictionaries (`en.ts` canonical, `hi.ts` + `ar.ts` must carry the exact same key set — enforced by `dictionary-parity.test.ts` and `keys-exist.test.ts`).

---

## File Structure

| File | Responsibility |
|---|---|
| `api/app/api/quotation_routes.py` | `QuotationCatalog.document_delay_seconds` field + `_schedule_quotation_emails` reads it instead of the global constant |
| `api/app/worker/tasks.py` | Docstring only — `task_send_quotation_visitor_email` no longer runs on a fixed ~10 min window |
| `api/tests/test_quotation_routes.py` | New/extended tests: field validation, admin CRUD round-trip, scheduling honours the bot's own delay |
| `app/src/features/agents/quotation/quotation.model.ts` | `document_delay_seconds` on the `QuotationCatalog` interface, delay presets, clamp/default logic in `parseCatalog`/`toPayload` |
| `app/src/features/agents/quotation/quotation.model.test.ts` | Round-trip, default, and clamp tests for the new field |
| `app/src/features/agents/quotation/QuotationPage.tsx` | New "When to send the quotation" card with a `Select` |
| `app/src/i18n/locales/en.ts`, `hi.ts`, `ar.ts` | New translation keys for the card title, field label, hint, and the six delay-option labels |

---

## Task 1: Backend — `document_delay_seconds` field on `QuotationCatalog`

**Files:**
- Modify: `api/app/api/quotation_routes.py:265-296` (the `QuotationCatalog` class)
- Test: `api/tests/test_quotation_routes.py` (inside `class TestCatalogValidation`, after `test_negative_price_rejected`, ~line 270)

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/test_quotation_routes.py`, inside `class TestCatalogValidation` (right after `test_negative_price_rejected`, before `test_choice_requirement_needs_options`):

```python
    def test_document_delay_defaults_to_the_platform_constant(self):
        cat = QuotationCatalog.model_validate({"services": []})
        assert cat.document_delay_seconds == quotation_routes.QUOTATION_EMAIL_DELAY_SECONDS

    def test_document_delay_seconds_out_of_range_rejected(self):
        with pytest.raises(ValueError):
            QuotationCatalog(document_delay_seconds=-1, services=[])
        with pytest.raises(ValueError):
            QuotationCatalog(document_delay_seconds=86401, services=[])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && conda run -n oye --no-capture-output uv run pytest tests/test_quotation_routes.py -k document_delay -v`
Expected: FAIL — `test_document_delay_defaults_to_the_platform_constant` raises `AttributeError: 'QuotationCatalog' object has no attribute 'document_delay_seconds'`; `test_document_delay_seconds_out_of_range_rejected` fails with `DID NOT RAISE <class 'ValueError'>` (the model's `extra="ignore"` config silently drops the unknown field today).

- [ ] **Step 3: Add the field**

In `api/app/api/quotation_routes.py`, inside `class QuotationCatalog` (around line 267-271), change:

```python
    enabled: bool = False
    currency: str = "INR"
    required_categories: list[str] = Field(default_factory=list)
    threshold: int = Field(default=2, ge=1, le=4)
    services: list[Service] = Field(default_factory=list)
```

to:

```python
    enabled: bool = False
    currency: str = "INR"
    required_categories: list[str] = Field(default_factory=list)
    threshold: int = Field(default=2, ge=1, le=4)
    # How long after `accept` the priced "Your quotation" document email is
    # deferred. The owner notification and the visitor's plain acknowledgement
    # ("Your quote request") both fire immediately regardless of this value —
    # only the priced document follows the delay. Defaults to the
    # platform-wide QUOTATION_EMAIL_DELAY_SECONDS so every bot saved before
    # this field existed keeps its current behaviour unchanged. 0 sends the
    # document alongside the other two; 86400 (24h) is the admin UI's outer
    # bound.
    document_delay_seconds: int = Field(default=QUOTATION_EMAIL_DELAY_SECONDS, ge=0, le=86400)
    services: list[Service] = Field(default_factory=list)
```

(`QUOTATION_EMAIL_DELAY_SECONDS` is already imported at the top of the file from `app.config`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && conda run -n oye --no-capture-output uv run pytest tests/test_quotation_routes.py -k document_delay -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd platform && git add api/app/api/quotation_routes.py api/tests/test_quotation_routes.py
git commit -m "feat: add per-bot document_delay_seconds to the quotation catalog"
```

---

## Task 2: Backend — admin CRUD round-trips the new field

**Files:**
- Test: `api/tests/test_quotation_routes.py` (inside `class TestAdminCatalogCrud`, after `test_put_then_get_roundtrips`, ~line 823)

- [ ] **Step 1: Write the tests**

No production code changes are needed for this task — `put_quotation_catalog` already does `bot.quotation_catalog = payload.model_dump()` and returns `payload` as-is, so once Task 1 lands, the new field already flows through the existing admin GET/PUT. This task exists to pin that contract with an explicit test rather than relying on it being incidentally true.

Add to `api/tests/test_quotation_routes.py`, inside `class TestAdminCatalogCrud` (right after `test_put_then_get_roundtrips`):

```python
    def test_document_delay_seconds_roundtrips(self, db):
        client = _make_client(db, email="a4@example.com", api_key="a4")
        bot = _make_bot(db, client.id, bot_key="bot-a4")
        api = _client_api(_app(), client)
        with _patch_session(db):
            r = api.put(f"/bots/{bot.id}/quotation-catalog", json=_catalog(document_delay_seconds=1800))
            assert r.status_code == 200
            assert r.json()["document_delay_seconds"] == 1800
            r = api.get(f"/bots/{bot.id}/quotation-catalog")
            assert r.json()["document_delay_seconds"] == 1800

    def test_document_delay_seconds_out_of_range_is_a_422(self, db):
        client = _make_client(db, email="a5@example.com", api_key="a5")
        bot = _make_bot(db, client.id, bot_key="bot-a5")
        api = _client_api(_app(), client)
        with _patch_session(db):
            r = api.put(f"/bots/{bot.id}/quotation-catalog", json=_catalog(document_delay_seconds=86401))
            assert r.status_code == 422
```

- [ ] **Step 2: Run the tests**

Run: `cd api && conda run -n oye --no-capture-output uv run pytest tests/test_quotation_routes.py -k document_delay -v`
Expected: PASS (4 tests total, including Task 1's two)

- [ ] **Step 3: Commit**

```bash
cd platform && git add api/tests/test_quotation_routes.py
git commit -m "test: pin document_delay_seconds through the admin catalog CRUD round-trip"
```

---

## Task 3: Backend — `_schedule_quotation_emails` uses the bot's own delay

**Files:**
- Modify: `api/app/api/quotation_routes.py:769-816` (`_schedule_quotation_emails`)
- Modify (docstrings only): `api/app/worker/tasks.py:2136-2156` (`task_send_quotation_visitor_email`)
- Test: `api/tests/test_quotation_routes.py` (inside `class TestQuotationEmailScheduling`, after `test_owner_and_ack_now_document_deferred`, ~line 1045)

- [ ] **Step 1: Write the failing test**

Add to `api/tests/test_quotation_routes.py`, inside `class TestQuotationEmailScheduling` (right after `test_owner_and_ack_now_document_deferred`):

```python
    def test_document_email_deferred_by_the_bots_own_configured_delay(self, db, monkeypatch):
        from datetime import timedelta

        import app.worker.enqueue as enqueue_mod

        client = _make_client(db, email="sch3@example.com", api_key="sch3")
        bot = _make_bot(
            db,
            client.id,
            bot_key="bot-sch3",
            catalog=_catalog(document_delay_seconds=120),
            notification_email="owner@acme.com",
        )
        _make_session(
            db,
            session_id="sch3s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state=dict(_QUOTING_STATE),
        )
        _make_message(db, session_id="sch3s")
        _make_lead(db, session_id="sch3s", bot_id=bot.id, email="jason@buyer.com", name="Jason")

        calls = []
        monkeypatch.setattr(enqueue_mod, "WORKER_ENABLED", True)
        monkeypatch.setattr(enqueue_mod, "enqueue_sync", lambda name, *a, **kw: calls.append((name, a, kw)))
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_visitor_email", lambda *a, **k: None)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_document_email", lambda *a, **k: None)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_client_email", lambda *a, **k: None)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.post("/chat/quotation/accept", json={"session_id": "sch3s"})

        assert len(calls) == 1
        _, args, kwargs = calls[0]
        assert args == ("sch3s", bot.id)
        assert kwargs["_defer_by"] == timedelta(seconds=120)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && conda run -n oye --no-capture-output uv run pytest tests/test_quotation_routes.py -k bots_own_configured_delay -v`
Expected: FAIL — `assert kwargs["_defer_by"] == timedelta(seconds=120)` fails because `_defer_by` is still `timedelta(seconds=600)` (the global `QUOTATION_EMAIL_DELAY_SECONDS`).

- [ ] **Step 3: Wire the catalog's delay into the scheduler**

In `api/app/api/quotation_routes.py`, change `_schedule_quotation_emails` (around line 769) from:

```python
    # Owner + visitor acknowledgement: immediate.
    _send_quotation_owner_email(db, bot, session)
    _send_quotation_visitor_email(db, bot, session)

    # Visitor quotation document (priced PDF): deferred ~10 min.
    from app.worker.enqueue import WORKER_ENABLED, enqueue_sync

    if WORKER_ENABLED:
        try:
            enqueue_sync(
                "task_send_quotation_visitor_email",
                session.id,
                bot.id,
                _defer_by=timedelta(seconds=QUOTATION_EMAIL_DELAY_SECONDS),
            )
            return
```

to:

```python
    # Owner + visitor acknowledgement: immediate.
    _send_quotation_owner_email(db, bot, session)
    _send_quotation_visitor_email(db, bot, session)

    # Visitor quotation document (priced PDF): deferred by the bot's own
    # configured delay (admin-set; defaults to QUOTATION_EMAIL_DELAY_SECONDS).
    catalog = _normalize(bot.quotation_catalog)
    from app.worker.enqueue import WORKER_ENABLED, enqueue_sync

    if WORKER_ENABLED:
        try:
            enqueue_sync(
                "task_send_quotation_visitor_email",
                session.id,
                bot.id,
                _defer_by=timedelta(seconds=catalog.document_delay_seconds),
            )
            return
```

Also update the function's docstring, changing:

```python
    * **Visitor quotation** ("Your quotation", priced PDF) — deferred by
      ``QUOTATION_EMAIL_DELAY_SECONDS`` (default 10 min).
```

to:

```python
    * **Visitor quotation** ("Your quotation", priced PDF) — deferred by the
      bot's own ``quotation_catalog.document_delay_seconds`` (admin-configurable;
      defaults to ``QUOTATION_EMAIL_DELAY_SECONDS``, 10 min, for any bot that has
      never touched the setting).
```

- [ ] **Step 4: Update the now-stale docstrings around it**

Three other docstrings in the same file describe the delay as a fixed "~10 min" and should read as bot-configurable instead:

In `_send_quotation_visitor_email` (~line 664), change:
```python
    the priced "Your quotation" document follows ~10 min later. Reply-To routes
```
to:
```python
    the priced "Your quotation" document follows later, after the bot's own
    configured delay. Reply-To routes
```

In `_send_quotation_document_email` (~line 700), change:
```python
    Deferred ~10 min after accept. Carries the full pricing (per-requirement
```
to:
```python
    Deferred after accept, by the bot's own configured delay. Carries the full
    pricing (per-requirement
```

In `dispatch_quotation_document_email_for_session` (~line 740), change:
```python
    "Your quotation" document email. Entry point for the deferred ARQ task
    ``task_send_quotation_visitor_email``, which runs ~10 minutes after the
    visitor accepts the quote.
```
to:
```python
    "Your quotation" document email. Entry point for the deferred ARQ task
    ``task_send_quotation_visitor_email``, which runs after the bot's own
    configured delay (``quotation_catalog.document_delay_seconds``) once the
    visitor accepts the quote.
```

In `api/app/worker/tasks.py`, in `task_send_quotation_visitor_email` (~line 2136), change:
```python
    """Send the priced "Your quotation" document email (with PDF) to the
    **visitor**, deferred ~10 min after the visitor accepted the quote. The
    owner notification and the visitor's "Your quote request" acknowledgement
    both fire immediately at accept time and are not handled here.

    (The task name is kept for scheduler/registration compatibility; its job is
    now the deferred document email rather than the plain acknowledgement.)

    Scheduled by ``quotation_routes._schedule_quotation_emails`` with an
    ``_defer_by`` window (``QUOTATION_EMAIL_DELAY_SECONDS``). The dispatcher
```
to:
```python
    """Send the priced "Your quotation" document email (with PDF) to the
    **visitor**, deferred after the visitor accepted the quote by the bot's
    own configured delay. The owner notification and the visitor's "Your quote
    request" acknowledgement both fire immediately at accept time and are not
    handled here.

    (The task name is kept for scheduler/registration compatibility; its job is
    now the deferred document email rather than the plain acknowledgement.)

    Scheduled by ``quotation_routes._schedule_quotation_emails`` with an
    ``_defer_by`` window taken from ``quotation_catalog.document_delay_seconds``
    (default ``QUOTATION_EMAIL_DELAY_SECONDS``). The dispatcher
```

- [ ] **Step 5: Run the full quotation test file to verify nothing regressed**

Run: `cd api && conda run -n oye --no-capture-output uv run pytest tests/test_quotation_routes.py -v`
Expected: PASS — all tests including the pre-existing `test_owner_and_ack_now_document_deferred`, which still asserts `timedelta(seconds=quotation_routes.QUOTATION_EMAIL_DELAY_SECONDS)` and keeps passing because `_catalog()` (no override) validates through `QuotationCatalog.model_validate` with the field's default.

- [ ] **Step 6: Commit**

```bash
cd platform && git add api/app/api/quotation_routes.py api/app/worker/tasks.py api/tests/test_quotation_routes.py
git commit -m "feat: defer the quotation document email by the bot's own configured delay"
```

---

## Task 4: Backend — full check

- [ ] **Step 1: Run the full backend test suite**

Run: `cd api && conda run -n oye --no-capture-output uv run pytest`
Expected: PASS

- [ ] **Step 2: Lint and format**

Run: `cd api && conda run -n oye --no-capture-output uv run ruff check .`
Run: `cd api && conda run -n oye --no-capture-output uv run ruff format --check .`
Expected: both clean. If `ruff format --check` reports files, run `uv run ruff format .` and re-stage.

- [ ] **Step 3: Commit any formatting fixes (only if Step 2 changed files)**

```bash
cd platform && git add -u api/
git commit -m "style: ruff format"
```

---

## Task 5: Frontend — `document_delay_seconds` on the TypeScript model

**Files:**
- Modify: `app/src/features/agents/quotation/quotation.model.ts`
- Test: `app/src/features/agents/quotation/quotation.model.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `app/src/features/agents/quotation/quotation.model.test.ts`, inside `describe('reading a stored blob back', ...)` (after `test('ignores the pre-requirement schema...')`):

```ts
  it('defaults document_delay_seconds to 600 seconds when the field is missing', () => {
    const parsed = parseCatalog({ services: [] });
    expect(parsed.document_delay_seconds).toBe(600);
  });

  it('clamps an out-of-range document_delay_seconds into [0, 86400]', () => {
    expect(parseCatalog({ services: [], document_delay_seconds: -5 }).document_delay_seconds).toBe(0);
    expect(parseCatalog({ services: [], document_delay_seconds: 999999 }).document_delay_seconds).toBe(86400);
  });
```

Add to `describe('the payload the server actually stores', ...)` (after `test('clamps a quantity to at least one...')`):

```ts
  it('clamps document_delay_seconds the same way on save', () => {
    const catalog = catalogWith({ document_delay_seconds: -5 });
    expect(toPayload(catalog).document_delay_seconds).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/features/agents/quotation/quotation.model.test.ts`
Expected: FAIL — `parsed.document_delay_seconds` is `undefined`, not `600`; `toPayload(catalog).document_delay_seconds` is `undefined`, not `0`.

- [ ] **Step 3: Add the field, presets, and clamp logic**

In `app/src/features/agents/quotation/quotation.model.ts`, add the interface field. Change:

```ts
export interface QuotationCatalog {
  enabled: boolean;
  currency: string;
  /** Empty means "any of the four dimensions counts", not "none of them". */
  required_categories: BantDimension[];
  threshold: number;
  services: Service[];
}
```

to:

```ts
export interface QuotationCatalog {
  enabled: boolean;
  currency: string;
  /** Empty means "any of the four dimensions counts", not "none of them". */
  required_categories: BantDimension[];
  threshold: number;
  /**
   * Seconds after `accept` before the priced "Your quotation" document email
   * goes out. The owner notification and the visitor's plain acknowledgement
   * both fire immediately regardless of this value. Mirrors
   * `QuotationCatalog.document_delay_seconds` server-side, clamped the same
   * way: `[MIN_DOCUMENT_DELAY_SECONDS, MAX_DOCUMENT_DELAY_SECONDS]`.
   */
  document_delay_seconds: number;
  services: Service[];
}
```

Add the presets and default/bounds constants, and a label helper, right after the existing `CURRENCIES` block (after the closing `];` of `CURRENCIES`, before `export function requirementTypeLabel`):

```ts
export const DEFAULT_DOCUMENT_DELAY_SECONDS = 600;
export const MIN_DOCUMENT_DELAY_SECONDS = 0;
export const MAX_DOCUMENT_DELAY_SECONDS = 86400;

/** A delay preset for the "when to send the quotation" select. */
export function documentDelayLabel(d: { key: string; label: string }): string {
  return translateNow(`agents.documentDelayOption.${d.key}`) || d.label;
}

// @i18n-exempt: fallbacks, read through documentDelayLabel above.
export const DOCUMENT_DELAY_OPTIONS: { value: number; key: string; label: string }[] = [
  { value: 0, key: 'immediate', label: 'Immediately' },
  { value: 300, key: 'min5', label: '5 minutes' },
  { value: 600, key: 'min10', label: '10 minutes' },
  { value: 1800, key: 'min30', label: '30 minutes' },
  { value: 3600, key: 'hour1', label: '1 hour' },
  { value: 86400, key: 'hour24', label: '24 hours' },
];
```

Update `EMPTY_CATALOG`. Change:

```ts
export const EMPTY_CATALOG: QuotationCatalog = {
  enabled: false,
  currency: 'INR',
  required_categories: [],
  threshold: 2,
  services: [],
};
```

to:

```ts
export const EMPTY_CATALOG: QuotationCatalog = {
  enabled: false,
  currency: 'INR',
  required_categories: [],
  threshold: 2,
  document_delay_seconds: DEFAULT_DOCUMENT_DELAY_SECONDS,
  services: [],
};
```

Update `parseCatalog`'s return statement. Change:

```ts
  return {
    enabled: record.enabled === true,
    currency: (asString(record.currency) || 'INR').toUpperCase(),
    required_categories: categories,
    threshold: Math.min(thresholdCeiling(categories), Math.max(1, Math.floor(asNumber(record.threshold)) || 2)),
    services,
  };
```

to:

```ts
  return {
    enabled: record.enabled === true,
    currency: (asString(record.currency) || 'INR').toUpperCase(),
    required_categories: categories,
    threshold: Math.min(thresholdCeiling(categories), Math.max(1, Math.floor(asNumber(record.threshold)) || 2)),
    document_delay_seconds:
      record.document_delay_seconds === undefined
        ? DEFAULT_DOCUMENT_DELAY_SECONDS
        : Math.min(
            MAX_DOCUMENT_DELAY_SECONDS,
            Math.max(MIN_DOCUMENT_DELAY_SECONDS, Math.floor(asNumber(record.document_delay_seconds))),
          ),
    services,
  };
```

Update `toPayload`'s return statement. Change:

```ts
export function toPayload(catalog: QuotationCatalog): QuotationCatalog {
  return {
    enabled: catalog.enabled,
    currency: (catalog.currency || 'INR').toUpperCase(),
    required_categories: [...catalog.required_categories],
    threshold: Math.min(catalog.threshold, thresholdCeiling(catalog.required_categories)),
    services: catalog.services.map((service) => ({
```

to:

```ts
export function toPayload(catalog: QuotationCatalog): QuotationCatalog {
  return {
    enabled: catalog.enabled,
    currency: (catalog.currency || 'INR').toUpperCase(),
    required_categories: [...catalog.required_categories],
    threshold: Math.min(catalog.threshold, thresholdCeiling(catalog.required_categories)),
    document_delay_seconds: Math.min(
      MAX_DOCUMENT_DELAY_SECONDS,
      Math.max(MIN_DOCUMENT_DELAY_SECONDS, Math.floor(asNumber(catalog.document_delay_seconds))),
    ),
    services: catalog.services.map((service) => ({
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/features/agents/quotation/quotation.model.test.ts`
Expected: PASS (all tests, including the pre-existing round-trip test, which now round-trips the new field too since it is part of `EMPTY_CATALOG`)

- [ ] **Step 5: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no new errors (`QuotationPage.tsx` does not read `document_delay_seconds` yet, so nothing else should break)

- [ ] **Step 6: Commit**

```bash
cd platform && git add app/src/features/agents/quotation/quotation.model.ts app/src/features/agents/quotation/quotation.model.test.ts
git commit -m "feat: add document_delay_seconds to the quotation TypeScript model"
```

---

## Task 6: Frontend — i18n keys

**Files:**
- Modify: `app/src/i18n/locales/en.ts`
- Modify: `app/src/i18n/locales/hi.ts`
- Modify: `app/src/i18n/locales/ar.ts`

Nine new flat keys are needed inside the `agents` namespace in all three files, with **identical key names** and locale-appropriate values (`dictionary-parity.test.ts` requires the exact same key set across `en`/`hi`/`ar`; `keys-exist.test.ts` requires every key a component asks for to exist in `en.ts`, which Task 7 will ask for).

- [ ] **Step 1: Add keys to `en.ts`**

In `app/src/i18n/locales/en.ts`, inside the `agents` object, insert four new top-level keys at their alphabetical slots among the existing ones:

Right after `document: 'Document',` and before `documents: 'Documents',` (~line 1294), insert:
```ts
    documentDelayHint: 'The acknowledgement email goes out immediately. This is when the priced quotation follows it.',
    documentDelayOption: {
      hour1: '1 hour',
      hour24: '24 hours',
      immediate: 'Immediately',
      min10: '10 minutes',
      min30: '30 minutes',
      min5: '5 minutes',
    },
```

Right after `sendPreviewMessage: 'Send preview message',` (~line 1664, immediately before `sendingAgainIsFineThis`), insert:
```ts
    sendThePricedQuote: 'Send the priced quote',
```

Right after `whenToOfferAQuote: 'When to offer a quote',` (~line 1869) — `whenToSendTheQuotation` sorts after it (`Offer` < `Send`) — insert:
```ts
    whenToSendTheQuotation: 'When to send the quotation',
```

The full set of NEW keys added to `en.ts`'s `agents` object (9 leaf keys across 4 top-level entries):
```ts
    documentDelayHint: 'The acknowledgement email goes out immediately. This is when the priced quotation follows it.',
    documentDelayOption: {
      hour1: '1 hour',
      hour24: '24 hours',
      immediate: 'Immediately',
      min10: '10 minutes',
      min30: '30 minutes',
      min5: '5 minutes',
    },
    sendThePricedQuote: 'Send the priced quote',
    whenToSendTheQuotation: 'When to send the quotation',
```

- [ ] **Step 2: Add the same keys to `hi.ts`**

In `app/src/i18n/locales/hi.ts`, inside the `agents` object, at the same alphabetical slots, add:
```ts
    documentDelayHint: 'पुष्टि ईमेल तुरंत भेज दी जाती है। यह वह समय है जब कीमत वाला कोटेशन उसके बाद भेजा जाता है।',
    documentDelayOption: {
      hour1: '1 घंटा',
      hour24: '24 घंटे',
      immediate: 'तुरंत',
      min10: '10 मिनट',
      min30: '30 मिनट',
      min5: '5 मिनट',
    },
    sendThePricedQuote: 'कीमत वाला कोटेशन भेजें',
    whenToSendTheQuotation: 'कोटेशन कब भेजें',
```

- [ ] **Step 3: Add the same keys to `ar.ts`**

In `app/src/i18n/locales/ar.ts`, inside the `agents` object, at the same alphabetical slots, add:
```ts
    documentDelayHint: 'يتم إرسال بريد التأكيد فورًا. هذا هو الوقت الذي يصل بعده عرض السعر النهائي بالتفصيل.',
    documentDelayOption: {
      hour1: 'ساعة واحدة',
      hour24: '24 ساعة',
      immediate: 'فورًا',
      min10: '10 دقائق',
      min30: '30 دقيقة',
      min5: '5 دقائق',
    },
    sendThePricedQuote: 'إرسال عرض السعر النهائي',
    whenToSendTheQuotation: 'متى يتم إرسال عرض السعر',
```

- [ ] **Step 4: Run the i18n contract tests**

Run: `cd app && npx vitest run src/i18n/dictionary-parity.test.ts src/i18n/keys-exist.test.ts`
Expected: PASS. `dictionary-parity` passes because all three files now carry the exact same 4 new key paths (`agents.documentDelayHint`, `agents.documentDelayOption.{hour1,hour24,immediate,min10,min30,min5}`, `agents.sendThePricedQuote`, `agents.whenToSendTheQuotation`) — 9 leaf keys total. `keys-exist` will only start checking these once Task 7 references them from `QuotationPage.tsx`; it passes now because the keys already exist in `en.ts` (a superset never fails that test).

- [ ] **Step 5: Commit**

```bash
cd platform && git add app/src/i18n/locales/en.ts app/src/i18n/locales/hi.ts app/src/i18n/locales/ar.ts
git commit -m "i18n: add quotation document-delay strings (en, hi, ar)"
```

---

## Task 7: Frontend — the "When to send the quotation" card

**Files:**
- Modify: `app/src/features/agents/quotation/QuotationPage.tsx`

- [ ] **Step 1: Import the new model exports**

In `app/src/features/agents/quotation/QuotationPage.tsx`, change the import block (lines 34-49) from:

```ts
import {
  BANT_DIMENSIONS,
  bantDimensionHelp,
  bantDimensionLabel,
  CURRENCIES,
  currencyLabel,
  MAX_SERVICES,
  type BantDimension,
  type QuotationCatalog,
  type Service,
  blockedReason,
  newServiceId,
  parseCatalog,
  thresholdCeiling,
  toPayload,
} from './quotation.model';
```

to:

```ts
import {
  BANT_DIMENSIONS,
  bantDimensionHelp,
  bantDimensionLabel,
  CURRENCIES,
  currencyLabel,
  DOCUMENT_DELAY_OPTIONS,
  documentDelayLabel,
  MAX_SERVICES,
  MAX_DOCUMENT_DELAY_SECONDS,
  MIN_DOCUMENT_DELAY_SECONDS,
  type BantDimension,
  type QuotationCatalog,
  type Service,
  blockedReason,
  newServiceId,
  parseCatalog,
  thresholdCeiling,
  toPayload,
} from './quotation.model';
```

- [ ] **Step 2: Add the card**

In `app/src/features/agents/quotation/QuotationPage.tsx`, inside the `aside={<Stack>...</Stack>}` block, right after the closing `</Card>` of the "Currency" card (~line 279) and before the "When to offer a quote" `<Card>` (~line 281), insert:

```tsx
              <Card>
                <CardHeader
                  title={t('agents.whenToSendTheQuotation') || 'When to send the quotation'}
                  titleAs="h2"
                />
                <CardBody>
                  <Field
                    label={t('agents.sendThePricedQuote') || 'Send the priced quote'}
                    disabled={configDisabled}
                    hint={
                      t('agents.documentDelayHint') ||
                      'The acknowledgement email goes out immediately. This is when the priced quotation follows it.'
                    }
                  >
                    <Select
                      label={t('agents.sendThePricedQuote') || 'Send the priced quote'}
                      value={String(catalog.document_delay_seconds)}
                      options={DOCUMENT_DELAY_OPTIONS.map((option) => ({
                        value: String(option.value),
                        label: documentDelayLabel(option),
                      }))}
                      disabled={configDisabled}
                      onValueChange={(value) =>
                        update((previous) => ({
                          ...previous,
                          document_delay_seconds: Math.min(
                            MAX_DOCUMENT_DELAY_SECONDS,
                            Math.max(MIN_DOCUMENT_DELAY_SECONDS, Number(value) || 0),
                          ),
                        }))
                      }
                    />
                  </Field>
                </CardBody>
              </Card>

```

- [ ] **Step 3: Typecheck and lint**

Run: `cd app && npx tsc --noEmit`
Expected: no errors

Run: `cd app && npm run lint`
Expected: clean

- [ ] **Step 4: Run the i18n contract tests again**

Run: `cd app && npx vitest run src/i18n/keys-exist.test.ts src/i18n/dictionary-parity.test.ts`
Expected: PASS — `QuotationPage.tsx` now literally calls `t('agents.whenToSendTheQuotation')`, `t('agents.sendThePricedQuote')`, and `t('agents.documentDelayHint')`, all present in `en.ts` since Task 6.

- [ ] **Step 5: Manual verification in the browser**

Run: `cd app && npm run dev` (port 5174), sign in with a Professional-plan (or trial) bot, open its Quotation page, confirm:
- A new "When to send the quotation" card renders in the right-hand column, between Currency and "When to offer a quote".
- Its select defaults to "10 minutes" for a bot that has never touched the setting.
- Changing it to another preset and saving persists across a page reload (confirms the PUT/GET round-trip from Task 2 end-to-end).
- The field is disabled when quoting itself is switched off, matching every other field in that column.

- [ ] **Step 6: Commit**

```bash
cd platform && git add app/src/features/agents/quotation/QuotationPage.tsx
git commit -m "feat: add a delay picker for the quotation document email"
```

---

## Task 8: Full project verification

- [ ] **Step 1: Backend**

```bash
cd api && conda run -n oye --no-capture-output uv run ruff check .
cd api && conda run -n oye --no-capture-output uv run ruff format --check .
cd api && conda run -n oye --no-capture-output uv run pytest
```
Expected: all clean/passing.

- [ ] **Step 2: Frontend**

```bash
cd app && npm run lint
cd app && npx tsc --noEmit
cd app && npx vitest run
cd app && npm run build
```
Expected: all clean/passing.

- [ ] **Step 3: Confirm branch**

```bash
git branch --show-current
```
Expected: `development`. If it prints `main`, stop and run `git checkout development` before any further commit — per this repo's strict git workflow, `main` is never committed to locally.

- [ ] **Step 4: Report**

Summarize in the final message: "lint ✓ · format ✓ · typecheck ✓ · tests ✓ · build ✓", per this repo's Mandatory Pre-Completion Checks.

---

## Self-Review Notes

- **Spec coverage:** default stays 10 min for existing bots (Task 1 field default + Task 3's unchanged pre-existing test) ✓; admin-configurable via a dropdown, not freeform text (Task 7's `Select`, not an `Input`) ✓; bounded 0–24h so it cannot be set to something unreachable or absurd (Task 1's `ge=0, le=86400`, mirrored in Task 5's clamp) ✓; no DB migration (JSONB field only) ✓; owner + acknowledgement emails stay immediate regardless of the new setting (untouched code path, called out in every updated docstring) ✓.
- **Placeholder scan:** every step above shows the literal before/after code or the literal new file content; no "add validation" or "similar to Task N" placeholders.
- **Type consistency:** `document_delay_seconds: number` (TS) / `document_delay_seconds: int` (Python) used identically in every task; `DOCUMENT_DELAY_OPTIONS`, `documentDelayLabel`, `MIN_DOCUMENT_DELAY_SECONDS`, `MAX_DOCUMENT_DELAY_SECONDS`, `DEFAULT_DOCUMENT_DELAY_SECONDS` are defined once in Task 5 and only ever imported (never redefined) in Task 7.
