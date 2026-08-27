# Phase 1 — Language Foundation & Data Model

## Objective

Create a single source of truth for language/locale metadata and per-bot language
configuration, with zero behavior change for existing bots. This is pure
foundation: no widget UI, no AI behavior change, no operator UI. Every later
phase depends on the service module and DB column this phase adds.

## Scope

- New `language_service.py` with locale normalization, a supported-locale
  catalog, RTL/direction metadata, and stub message-language detection.
- New `schemas/language.py` (`LocaleInfo`, `LanguageContext`).
- One new JSONB column on `Bot`: `language_config`.
- Expose `language_config` (with backward-compatible defaults) on the existing
  `GET /bots/settings/public` response.

## Non-scope

- No `ChatSession`/`ChatMessage`/`Operator` schema changes (Phase 2 and Phase 4).
- No widget code (Phase 2).
- No RAG/prompt changes (Phase 3).
- No admin UI (Phase 5).
- Message-level language detection is defined as a function signature only;
  its real implementation (a lightweight classifier or heuristic) is a Phase 3
  concern, invoked from the chat route.

## Existing files/components affected

| File | Change |
|---|---|
| `api/app/db/models.py` (`Bot` class, currently lines 274-569) | Add `language_config` column, alongside the existing `feature_flags` (lines 443-447) and `widget_messages` (lines 450-454) JSONB columns — same pattern: `nullable=False`, `server_default` of a sensible default dict. |
| `api/app/api/bot_routes.py` (`get_bot_settings_public`, route at line 845, response dict lines 955-1004) | Add one key: `"language_config": bot.language_config or {}`, next to the existing `"widget_messages": bot.widget_messages or {}` (line 975) and `"widget_config": bot.widget_config or {}` (line 976). |

## New files/components required

- `api/app/services/language_service.py`
- `api/app/schemas/language.py`
- `api/alembic/versions/<new_revision>_bot_language_config.py`

## Database/schema changes

Add to `Bot` (`api/app/db/models.py`), following the existing `feature_flags`
pattern exactly:

```python
language_config = Column(
    JSONB,
    nullable=False,
    server_default=(
        '{"enabled": false, "default_locale": "en-IN", '
        '"supported_locales": ["en-IN"], "auto_detect": true, '
        '"allow_visitor_language_switch": false, '
        '"operator_translation_enabled": false}'
    ),
)
```

`enabled: false` by default is the backward-compatibility switch — Phase 3/4
code must check `bot.language_config.get("enabled")` before changing any
generation or translation behavior. Old bots get this column via
`server_default` with no application-level migration risk (matches the
`bant_config`/`answer_links` precedent: additive, nullable-or-defaulted,
zero read-path changes for rows that never set it).

Migration file, following the idempotent-guard template used by
`api/alembic/versions/c9e2a4f7b1d3_bot_answer_links.py` (the most recent
JSONB-column-on-`bots` migration):

```python
TABLE = "bots"
COLUMN = "language_config"

def _columns() -> set[str] | None:
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}

def upgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN not in existing:
        op.add_column(
            TABLE,
            sa.Column(
                COLUMN,
                postgresql.JSONB(),
                nullable=False,
                server_default=sa.text(
                    "'{\"enabled\": false, \"default_locale\": \"en-IN\", "
                    "\"supported_locales\": [\"en-IN\"], \"auto_detect\": true, "
                    "\"allow_visitor_language_switch\": false, "
                    "\"operator_translation_enabled\": false}'::jsonb"
                ),
            ),
        )

def downgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN in existing:
        op.drop_column(TABLE, COLUMN)
```

**Before creating this migration, run `alembic heads` inside `api/` and confirm
a single head.** A merge migration was needed as recently as 2026-08-22
(`e8bf7678526d_merge_chat_session_probe_branch_with_.py`) — verify the head is
still singular before branching `down_revision`.

## API changes

`GET /bots/settings/public` (`api/app/api/bot_routes.py:845`) response dict
gains one key. No breaking change — additive field, existing widget builds
that don't read it are unaffected. Note the file's existing static-route
ordering constraint (comment at lines 840-841: static sub-paths must be
defined before `/{bot_id}`) — this phase doesn't add new routes, so it doesn't
apply here, but later phases (Phase 2's `POST /chat/language`, Phase 4's
`POST /live-chat/translate`) must respect it.

## WebSocket changes

None in this phase.

## Frontend changes

None in this phase (widget and admin both read the new field starting in
Phase 2/5, but Phase 1 ships no frontend code).

## Backend/service changes

`api/app/services/language_service.py` — new module:

```python
SUPPORTED_LANGUAGE_CODES = {
    "en", "hi", "es", "fr", "de", "pt", "it", "nl", "ja", "ko",
    "zh-CN", "zh-TW", "ar", "tr", "id", "vi", "th", "pl", "ru", "uk",
}

RTL_LANGUAGES = {"ar", "he", "fa", "ur"}

def normalize_locale(value: str | None) -> str | None: ...
def language_from_locale(locale: str | None) -> str | None: ...
def is_supported_locale(locale: str, supported: list[str]) -> bool: ...
def get_locale_direction(locale: str) -> str:  # "ltr" | "rtl"
    ...
def resolve_initial_locale(
    *, explicit=None, site=None, html_lang=None, browser=None,
    persisted=None, supported: list[str], default: str,
) -> "LanguageContext": ...
def detect_message_language(text: str) -> tuple[str | None, float]:
    # Phase 1: stub returning (None, 0.0). Real implementation lands in
    # Phase 3 when it's actually invoked from chat_routes.py.
    ...
```

`api/app/schemas/language.py`:

```python
class LocaleInfo(BaseModel):
    code: str
    locale: str
    name: str
    native_name: str
    direction: str  # "ltr" | "rtl"
    enabled: bool = True

class LanguageContext(BaseModel):
    language: str
    locale: str
    source: str  # explicit|site|html_lang|browser|persisted|message_detected|geo|default
    confidence: float
    direction: str
    locked: bool = False
```

These are plain importable modules — no route wiring yet. `chat_routes.py` and
`rag_service.py` start importing `LanguageContext` in Phase 2/3.

## Dependencies on previous phases

None — this is the first phase.

## Exact implementation steps

1. `alembic heads` (inside `api/`, conda env `oye`) — confirm single head.
2. Add `language_config` column to `Bot` in `api/app/db/models.py`, directly
   below `feature_flags` (line ~447) for locality with the other JSONB config
   columns.
3. Write the Alembic migration using the idempotent-guard template above.
   `uv run alembic upgrade head` against the local dev DB.
4. Create `api/app/services/language_service.py` with the functions listed
   above. Unit-testable in isolation — no DB/request dependency.
5. Create `api/app/schemas/language.py`.
6. Add `"language_config": bot.language_config or {}` to the response dict in
   `get_bot_settings_public` (`bot_routes.py`, near line 975).
7. Run the full backend test suite (`uv run pytest`) to confirm no existing
   test asserts an exact key-set on the public settings response (if one does,
   update it to allow the new key).

## Acceptance criteria

- [ ] `Bot.language_config` exists, is `NOT NULL`, defaults to the disabled
      config shown above, for both new and pre-existing rows.
- [ ] `GET /bots/settings/public` includes `language_config` in its response
      for every bot, old and new.
- [ ] `language_service.normalize_locale`/`language_from_locale`/
      `is_supported_locale`/`get_locale_direction` are unit tested and pass for
      the locale examples in the source plan (`en-US`, `en-GB`, `en-IN`,
      `hi-IN`, `fr-FR`, `fr-CA`, `pt-BR`, `pt-PT`, `es-ES`, `es-MX`, `ar-SA`).
- [ ] Migration `upgrade()`/`downgrade()` both run cleanly against a fresh copy
      of the dev DB schema.
- [ ] No existing bot's widget, chat, or admin behavior changes (manual spot
      check: load an existing bot's widget, confirm identical UI/behavior to
      pre-migration).

## Testing/QA requirements

- Unit tests for every `language_service.py` function (locale normalization
  matrix from the source plan's §33.1, RTL matrix `ar→rtl, he→rtl, fa→rtl,
  ur→rtl, en→ltr`).
- Backend test: `GET /bots/settings/public` for a bot created before this
  migration returns `language_config.enabled == false`.
- Migration test: `alembic upgrade head` then `alembic downgrade -1` then
  `alembic upgrade head` again, on a scratch DB, must not error.

## Risks and edge cases

- **JSONB `server_default` string escaping.** The default dict must be valid
  JSON inside a SQL string literal — the `bant_config`/`feature_flags`
  precedents in `models.py` use plain Python dict `server_default` strings
  (not `sa.text(...)`) at the ORM level, but the Alembic migration itself uses
  `sa.text("'...'::jsonb")`. Copy the exact quoting style from
  `c9e2a4f7b1d3_bot_answer_links.py` to avoid a mismatch between the ORM-level
  default and the migration-level default (ORM default only applies to
  post-migration `INSERT`s from the app; the migration's `server_default`
  applies to the `ALTER TABLE ADD COLUMN` backfill for existing rows — both
  must agree).
- **Two Alembic heads.** If a second head has appeared since 2026-08-22, this
  migration will need a merge migration first (see `e8bf7678526d_merge_chat_
  session_probe_branch_with_.py` as the template).

## Rollback considerations

- `downgrade()` drops the column — safe as long as no later-phase code has
  shipped yet that reads `bot.language_config` (true by construction, since
  this is Phase 1).
- If rolled back after Phase 2+ has shipped and started reading
  `language_config`, those reads must be guarded (`bot.language_config or {}`)
  so a missing column doesn't 500 — but rolling back a column that later code
  depends on should be avoided; prefer disabling via the `enabled: false`
  config flag instead of a schema rollback once Phase 2+ ships.
