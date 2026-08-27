# Phase 4 — Operator Multilingual Live Chat

> **Status: authoritative implementation specification.** This document was
> rewritten on 2026-08-24 after a full architecture/code audit of the previous
> draft against the live repository. The previous draft was assessed
> **REWORK REQUIRED** (blockers C1 to C6, high-priority H1 to H8). Every finding
> is resolved here. See *Audit traceability* at the end for the mapping.
>
> The single largest change: the previous draft treated the WebSocket as the
> only delivery path. It is not. Both clients rebuild their thread from
> `GET /chat/history/{session_id}` on every reconnect, so a wire-only
> translation disappears on refresh. Translation is now **persisted derived
> data**, served over both the socket and REST.

## Objective

Let a visitor converse in their language while an operator works in theirs:
incoming visitor messages are translated for the operator, operator replies are
translated back to the visitor, the original text of every message is immutable
and canonical, and translation failure never blocks or delays message delivery
in either direction.

## Scope

- `TranslationService` + `TranslationProvider` abstraction
  (`api/app/services/translation_service.py`), backed by `litellm.acompletion`.
- `ChatMessage.source_language` and `ChatMessage.translations` columns;
  `Operator.preferred_locale` and `Operator.supported_languages` columns.
- Translation hooks in `ws_routes.py` (after persistence, outside the delivery
  statement) and a new outbound frame in `ConnectionManager`.
- `GET /chat/history/{session_id}` returns `source_language` + `translations`,
  so translations survive a reload on both the visitor and operator side.
- `POST /operators/translate` (preview / on-demand backfill), authed with
  `get_current_client_or_operator`, session-scoped, rate limited.
- Operator preference read/write (`preferred_locale`, `supported_languages`)
  and session language surfaced in `GET /operators/session/{id}/details`.
- Admin inbox UI: original/translated toggle, language badge, RTL-correct
  rendering, in `app/src/features/inbox/*`.
- Widget rendering of translated operator messages, live and restored.
- Credit/feature gating, kill-switch coverage, and metrics for every
  translation call.

## Non-scope

- Language-based operator routing. Phase 5. `Operator.supported_languages`
  ships here so Phase 5's filter has data; the routing change itself does not.
- Any change to `live_chat_queue_service.py`. Pure FIFO, no language surface.
- Language detection on the WebSocket path. Language is resolved on the REST
  `/chat` path only (Phase 2). Phase 4 consumes `ChatSession.language_code` and
  never re-detects. See *Prerequisites and NULL-language fallback*.
- A global (session-level) original/translated default. V1 ships the
  per-message toggle only.
- Automatic background retry of a failed translation. Retry is
  operator-initiated. See *Failure and retry strategy*.
- Translating `role="bot"` or `role="system"` messages. Bot answers are already
  native to the visitor's language via Phase 3; system strings are widget-side
  i18n. Only `role="user"` and `role="operator"` are translated.

## Prerequisites and NULL-language fallback

**`operator_translation_enabled` is effective only when
`language_config.enabled` is true.**

`_resolve_visitor_language_and_update_session`
(`api/app/api/chat_routes.py:264`) returns `None` immediately when
`language_config.enabled` is false, and it is the only writer of
`ChatSession.language_code`. A bot configured
`{"enabled": false, "operator_translation_enabled": true}` therefore has a
permanently NULL session language and nothing to translate to or from.

Two enforcement points:

1. **Config write.** The bot-settings validator rejects
   `operator_translation_enabled: true` when `enabled` is false, with a 422
   naming the dependency. This is the only place the invalid combination can be
   created.
2. **Runtime.** `_should_translate()` returns `False` unless *both* flags are
   true. Defensive, because existing rows may already hold the combination.

**NULL-language fallback.** A session may reach `live` with
`ChatSession.language_code IS NULL` in two legitimate cases: the bot enabled
multilingual after the session started, or the session reached live chat
without a prior REST `/chat` turn (the visitor WebSocket handler never resolves
language). In both cases:

- No translation is attempted in either direction.
- The message is delivered normally, unchanged.
- `translation_status=no_source_language` is recorded once per message.
- The operator console shows no language badge and no toggle.

This is a silent, safe degradation. It is never an error to the user and never
raises.

## Architecture: original-first, translation-derived

Four invariants. Every design decision below follows from them.

1. **`ChatMessage.content` is written once, at insert, and never updated.**
   Translations live in `ChatMessage.translations`, keyed by target language.
2. **Translation is persisted derived data, not a wire decoration.** Anything a
   client renders must be reachable from `GET /chat/history/{session_id}`,
   because both clients rebuild from it on reconnect.
3. **Delivery of the original never waits on, and never fails because of, a
   translation provider.** In the visitor to operator direction translation is
   fully out of band. In the operator to visitor direction it is awaited under
   a hard 2s ceiling with an original-text fallback.
4. **Translation decisions read from the database, never from per-process
   socket tables.** `assignments`, `operator_connections`, `_operator_names`
   and friends are per-worker; with `WS_BACKPLANE_ENABLED` the worker holding
   the visitor socket routinely does not hold the operator socket.

## Existing files/components affected

**Backend**

| File | Change |
|---|---|
| `api/app/db/models.py` — `ChatMessage` (1230-1273), `Operator` (1030-1105) | Add `ChatMessage.source_language`, `ChatMessage.translations`; add `Operator.preferred_locale`, `Operator.supported_languages`. Schema below. |
| `api/app/db/repository.py` — `add_chat_message` (225-256) | Add a `source_language: str \| None = None` parameter and persist it. This is the sole writer of `ChatMessage`; without it the new column is unreachable. |
| `api/app/api/chat_routes.py` — `get_history_endpoint` (2058), response builder (2174-2189) | Return `source_language` and `translations` per row. The response is a hand-built dict with a fixed field list, so adding a column does not surface it. **Without this change translations do not survive a reload on either client.** |
| `api/app/api/ws_routes.py` — visitor `message` branch (350-414), `message_ack` (406-414) | Persist with `source_language`; route the original; send `message_ack`; then `asyncio.create_task` the translation. The ack must not move. |
| `api/app/api/ws_routes.py` — operator `message` branch (801-829) | Capture the `db_id` returned by `add_chat_message` (currently discarded), await translation under a 2s ceiling, persist it, then route. |
| `api/app/api/ws_routes.py` — `_resolve_operator_from_key` (615-669) | Return `preferred_locale` alongside the existing tuple, so `connect_operator` can cache it for display. Not load-bearing for translation decisions (those read the DB), but avoids a query for the console's own badge. |
| `api/app/services/live_chat_service.py` — `connect_operator` (414-495) | Accept and cache `preferred_locale` in a new `self._operator_locales` dict, mirroring `_operator_names`. |
| `api/app/services/live_chat_service.py` — `route_visitor_message` (1258-1302) | Unchanged behaviour for the original. Add `source_language` to the outbound `msg` dict. No provider call here. |
| `api/app/services/live_chat_service.py` — `route_operator_message` (1304-1315) | Accept `delivered_content`, `translated_from`, and `message_id`; deliver the translated string when present, the original otherwise. No provider call here. |
| `api/app/services/live_chat_service.py` — new `send_translation_to_operator` | Emit the `message_translation` frame through the existing `_send_to_operator`, so the backplane path works unchanged. |
| `api/app/schemas/ws.py` — `MessageFrame` (95-102), `OPERATOR_FRAMES` (188-199) | Split `MessageFrame` into `VisitorMessageFrame` and `OperatorMessageFrame`. **No visitor-supplied language fields are added.** `OperatorMessageFrame` gains nothing in V1; the split exists so a future operator-only field cannot land on the visitor socket. |
| `api/app/api/operator_routes.py` — `PATCH /{operator_id}` (459) | Add `preferred_locale` / `supported_languages` to `UpdateOperatorRequest`; treat `preferred_locale` as self-editable (same `is_self_edit` branch as name/email); validate through `language_service`. |
| `api/app/api/operator_routes.py` — `GET /session/{session_id}/details` (1672) | Add `language_code` and `locale` to the response dict. |
| `api/app/api/operator_routes.py` — new `POST /operators/translate` | Preview and on-demand backfill. Auth `get_current_client_or_operator`, requires `session_id`, ownership-checked, target derived server-side, rate limited. |
| `api/app/core/rate_limit.py` — `key_from_api_key` (55) | Add `key_from_operator_credential`, keyed on `X-Operator-Key` or `X-API-Key` (falling back to IP). `key_from_api_key` reads only `X-API-Key` and would collapse every operator-key caller into one bucket. |
| `api/app/services/credit_service.py` — `_DEFAULT_PRICING` (133-175) | Add `credit_cost.translation` and `feature.translation_enabled`. |
| `api/app/api/bot_routes.py` — `language_config` merge in the bot-update handler (2472-2476) | Reject `operator_translation_enabled: true` when `enabled` is false. There is **no** `language_config` validator today: the field arrives as a `BoundedJsonObject` (510) and is shallow-merged into the existing dict. Validate the **merged result**, not the request body, because a partial update that sets only `enabled: false` would otherwise leave a stale `operator_translation_enabled: true` behind. |

**Admin app** (`app/src/features/inbox/*`, TypeScript, current rebuild)

| File | Change |
|---|---|
| `app/src/features/inbox/liveChatProtocol.ts` — `OperatorMessage` (64-75), `WsMessage` (144-151), `SessionDetails` (99-125) | Add `sourceLanguage?`, `translations?: Record<string, TranslationEntry>` to `OperatorMessage`; `source_language?` to `WsMessage`; a new `WsMessageTranslation` member of the inbound union; `language_code` / `locale` to `SessionDetails`. |
| `app/src/features/inbox/useOperatorSocket.ts` — `applyInbound` (147-348), `case 'message'` (174-215), history load (611, 634) | Attach `source_language` on inbound messages; handle `message_translation` by merging into the existing entry **by `message_id`, idempotently**; keep translations through the `mergeHistoryWithLive` path. |
| `app/src/features/inbox/liveChatHelpers.ts` — `parseHistoryMessage` (61) | Carry `source_language` and `translations` from the REST row into `OperatorMessage`. Without this, a refresh drops every translation. |
| `app/src/features/inbox/ConversationView.tsx` — `MessageBubble` (117-180) | Render the operator's preferred-language translation by default with a one-click "View original"; set `dir` from the rendered text's language; render translated text **as plain text, not Markdown**. |
| `app/src/features/inbox/SessionDetailsPanel.tsx` | Render `ConversationLanguageBadge` from `SessionDetails.language_code` / `locale`. |
| `app/src/services/api.js` + `api.d.ts` | Add `translateForSession(sessionId, text)`; extend the `ChatMessage` type with `source_language` / `translations`. |
| `app/src/types/domain.ts` — `ChatMessage` (229-239) | Add the two new fields. |

**Widget**

| File | Change |
|---|---|
| `widget/src/components/LiveChatMode.jsx` — `case 'message'` (266-280), history restore (171-250) | Render `data.content` (already the translated string when translation succeeded) and, on restore, prefer `translations[sessionLanguage].content` over `content`. **This is the fix for the mixed-language thread on reconnect.** |
| `widget/src/services/api.js` — `getChatHistory` (210) | No signature change; the response simply carries two more fields. |

## New files/components required

- `api/app/services/translation_service.py`
- `api/app/schemas/translation.py` (request/response models for the REST endpoint)
- `api/alembic/versions/<rev>_translation_columns.py`
- `app/src/features/inbox/TranslationToggle.tsx`
- `app/src/features/inbox/ConversationLanguageBadge.tsx`
- `api/tests/test_translation_service.py`
- `api/tests/test_operator_translation_flow.py`

## Database/schema changes

`ChatMessage` (`api/app/db/models.py:1230`):

```python
# The language ``content`` is written IN. NULL for pre-Phase-4 rows and for
# every message on a bot without multilingual enabled.
source_language = Column(String(16), nullable=True)

# Derived translations, keyed by TARGET language code. ``content`` above is
# never modified; this is the only place a translation is stored.
# Shape:
#   {"en": {"content": "...",
#           "provider": "litellm",
#           "model": "gemini/gemini-2.5-flash",
#           "status": "ok",              # "ok" | "failed"
#           "created_at": "2026-08-24T10:15:00Z"}}
translations = Column(JSONB, nullable=True)
```

**`source_locale` is deliberately NOT added.** The previous draft proposed both
`source_language` and `source_locale`. Region does not change translation
output (hi-IN and hi-XX translate identically), and a second field creates a
value that can silently disagree with `ChatSession.locale`. Where a locale is
needed for display, read it from the session.

`Operator` (`api/app/db/models.py:1030`):

```python
# The language this operator works in. NULL means "not set": treat as the
# workspace default and do not translate on their behalf.
preferred_locale = Column(String(32), nullable=True)

# Languages this operator can handle unaided. Phase 5 routing filters on this;
# Phase 4 only stores it.
supported_languages = Column(
    JSONB, nullable=False, default=list, server_default=sqlalchemy.text("'[]'::jsonb")
)
```

**Migration.** One revision touching both tables. Copy the structure of
`c8f5b2e0a3d9_chat_session_language_columns.py` exactly, including the
`_new_columns()` factory: `op.add_column()` binds the `sa.Column` instance to a
`Table`, and a module-level dict of columns dies with
`ArgumentError: Column object ... already assigned to Table` on the second
`upgrade()` in one process, which is how the migration is tested
(upgrade → downgrade → upgrade).

**No index.** `translations` is queried only by primary key alongside its row.
`source_language` gets an index only if Phase 5 analytics prove the need, the
same rule Phase 1 applied. Note that `chat_messages` is the fastest-growing
table in the schema (see the comment on `ix_chat_messages_session_id_created`);
both new columns are NULL for every existing row and JSONB growth is TOAST-only
once populated, so the write path is unaffected.

## API/WebSocket changes

### Inbound frames

**Visitor to server: unchanged.**

```json
{ "type": "message", "content": "मुझे pricing चाहिए", "client_msg_id": "..." }
```

No `locale`, no `source_language`, no `source_locale`. The previous draft
proposed adding them as "informational only", then stated in its own risk
section that the server must never trust them. Adding an untrusted field to a
frame class shared by both sockets buys nothing and creates a trust trap for
future code. The server's source of truth is `ChatSession.language_code`,
resolved in Phase 2.

`MessageFrame` is split into `VisitorMessageFrame` and `OperatorMessageFrame`
(identical fields in V1) so that any future operator-only field cannot be
submitted on the visitor socket. `parse_frame` and the `_Frame`
unknown-key-tolerance behaviour are unchanged.

**Operator to server: unchanged in V1.** No `target_locale`. The target is the
session's language, derived server-side. A per-send override is a Phase 5+
question.

### Outbound frames

**Server to operator, `message`.** One additive field:

```json
{ "type": "message", "session_id": "...", "role": "user",
  "content": "मुझे pricing चाहिए", "id": 123,
  "source_language": "hi" }
```

**Server to operator, `message_translation` (new frame type):**

```json
{ "type": "message_translation", "session_id": "...", "message_id": 123,
  "language": "en", "content": "I need pricing information.",
  "status": "ok" }
```

`status` is `"ok"` or `"unavailable"`. On `"unavailable"` the `content` key is
absent. The frame is idempotent: the console merges by `message_id`, so a
duplicate is a no-op.

**Server to visitor, `message`.** One additive field:

```json
{ "type": "message", "role": "operator",
  "content": "हमारा एंटरप्राइज़ प्लान...", "operator_name": "Asha",
  "message_id": 456, "translated_from": "en" }
```

`content` is the translated string when translation succeeded, the operator's
original when it did not. `translated_from` is absent in the failure case, so
the widget can tell the two apart.

All three are additive fields on existing frame types plus one new type.
`_Frame` ignores unknown keys, so an older console ignoring
`message_translation` shows originals only, and a rolled-back backend simply
stops emitting it.

### REST

```
GET /chat/history/{session_id}
```
Each row gains two fields:

```json
{ "id": 123, "role": "user", "content": "मुझे pricing चाहिए",
  "timestamp": "...", "feedback": null,
  "media_card": null, "media_secondary": null,
  "source_language": "hi",
  "translations": { "en": { "content": "I need pricing information.",
                            "status": "ok" } } }
```

Provider and model are **not** returned to clients. They are stored for audit
and cost attribution, not for rendering. `created_at` inside the translation
entry is likewise internal.

```
POST /operators/translate
```

| Property | Value |
|---|---|
| Auth | `get_current_client_or_operator` |
| Rate limit | `@limiter.limit("30/minute", key_func=key_from_operator_credential)` |
| Router | `operator_routes.py`, existing `/operators` prefix, already registered in `main.py` |

```json
Request:  { "session_id": "...", "text": "...", "message_id": 123 }
Response: { "translated": "...", "target_locale": "hi-IN",
            "cached": false, "status": "ok" }
```

Rules:

- `session_id` is **required** and ownership-checked against
  `auth["client_id"]` via the session's bot. A mismatch is a 403, matching
  `GET /operators/session/{id}/details`.
- `target_locale` is **derived server-side** from the session (for a preview of
  an outgoing reply) or from the caller's `preferred_locale` (for backfilling
  an incoming message). It is never read from the request body.
- `message_id`, when present, must belong to `session_id`; the result is
  persisted into that row's `translations`. This is the bounded backfill path.
- Without `message_id` the call is a pure preview and persists nothing.
- The endpoint is credit-metered exactly like the socket path.

The previous draft specified `get_current_operator`, which accepts
`X-Operator-Key` only. The admin dashboard authenticates workspace owners with
`X-API-Key` (`app/src/services/api.js:176-178`), and every existing inbox route
uses `get_current_client_or_operator`. As drafted the endpoint would have
returned 401 for the most common operator persona.

```
GET /operators/session/{session_id}/details
```
Response gains `"language_code"` and `"locale"`, read from `ChatSession`.

```
PATCH /operators/{operator_id}
```
`UpdateOperatorRequest` gains `preferred_locale` and `supported_languages`.
`preferred_locale` follows the **self-edit** rule already applied to `name` and
`email`: an operator may set their own, an admin may not set someone else's. It
is a personal working preference, not a team-management field.
`supported_languages` is the opposite: it is a routing capability, so it stays
under `_require_team_management_access`. Both are validated through
`language_service.normalize_locale`, and `supported_languages` entries must
each normalize and be present in the bot's `supported_locales`.

## Frontend changes

**Operator console.** `MessageBubble` renders, for a message whose
`source_language` differs from the operator's `preferred_locale`:

- The translation into the operator's language by default.
- A `TranslationToggle` showing "View original" / "View translation".
- A `ConversationLanguageBadge` in `SessionDetailsPanel` for the session
  language.
- `dir="rtl"` on the bubble when the rendered text's language is in the RTL set
  (`language_service.get_locale_direction` on the server, mirrored by the
  existing widget `localeCatalog.RTL_LANGUAGES` list on the client). Without
  this, Arabic and Hebrew render LTR with misplaced punctuation. Phase 1
  committed to RTL from the start and the operator console currently has no
  direction handling at all.
- **Translated text is rendered as plain text, not through `react-markdown`.**
  Original text keeps its existing `<Markdown>` rendering. Rationale in
  *Security and privacy model*.

When `translations[operatorLang].status === "failed"` or the key is absent
while translation is enabled, the bubble shows the original plus a muted
"Translation unavailable" affordance with a retry that calls
`POST /operators/translate` with the `message_id`.

**Widget.** `LiveChatMode.jsx` renders `data.content` for live operator
messages (already translated server-side) and, in the history-restore path,
prefers `translations[sessionLanguage].content` over `content`. This is the fix
for the audit's C1: the restore path fires on every `status: connected`, not
only the first, and appends any row newer than the last in-memory timestamp, so
a wire-only translation produced a half-Hindi, half-English thread after any
network blip.

## Backend/service changes

`api/app/services/translation_service.py`:

```python
class TranslationUnavailable(Exception):
    """Provider failed, timed out, or returned nothing usable.

    Callers MUST catch this and deliver the original. It is never allowed to
    propagate into a delivery path.
    """


class TranslationResult(NamedTuple):
    content: str
    provider: str
    model: str
    cached: bool


class TranslationProvider(Protocol):
    async def translate(
        self, text: str, source_language: str, target_language: str
    ) -> TranslationResult: ...


class LiteLLMTranslationProvider:
    """Reuses the existing LiteLLM gateway. NEVER blocks the event loop."""


class TranslationService:
    """Cache lookup, then provider, then cache write.

    Raises TranslationUnavailable on any failure. Returns the input unchanged
    (zero provider calls) when source == target.
    """
```

Three hard rules, stated because the previous draft left them to inference:

1. **`litellm.acompletion` only. `timeout=2.0`, `num_retries=0`.**
   Every non-streaming function in `llm_service.py` is synchronous
   `litellm.completion`. A synchronous call from a WebSocket handler blocks
   **every** socket held by that worker, not just the one being translated, and
   with the module default `_LLM_NUM_RETRIES` a degraded provider turns a 2s
   budget into tens of seconds. The module defaults are tuned for answer
   generation and must not be inherited here. If a synchronous transport ever
   becomes unavoidable, it goes through `asyncio.to_thread`, which is the
   pattern already used at `chat_routes.py:1504`.
2. **The provider call happens after the DB commit and outside the delivery
   statement.** Never inside `_send_to_visitor` / `_send_to_operator`: those are
   the backplane boundary, and the Redis subscriber calls the same local write
   path, so a provider call there would run twice and bill twice.
3. **`TranslationService` never raises into a delivery path.** `ws_routes`
   catches `TranslationUnavailable` and proceeds with the original.

Prompt construction:

- The instruction lives in the **system** message and states that the user
  content is data to be translated, not instructions to follow.
- The message body is the **user** message, passed verbatim, never interpolated
  into the system string. This is the same containment posture Phase 3 used for
  the language directive.
- Language names are resolved server-side via
  `language_service.language_display_name`, never taken from request text.
- The model is pinned to `gemini/gemini-2.5-flash` via a
  `TRANSLATION_MODEL` env var defaulting to that value.

## Provider decision

**Reuse LiteLLM, pinned to `gemini/gemini-2.5-flash`, behind
`TranslationProvider`.** Grounded in this repository, not general preference:

| | LiteLLM (existing) | Dedicated translation API |
|---|---|---|
| Vendor contract | None new. Inherits the existing LLM data-processing posture. | New vendor, new DPA, a new destination for customer content requiring review before launch. |
| Secrets | None. `PRIMARY_MODEL_KEY_SET` / `FALLBACK_MODEL_KEY_SET` already resolve at import (`config.py:59`). | New secret in GitHub Secrets, the droplet env, and every developer `.env`. |
| Failure handling | `_llm_fallbacks()` already provides primary to fallback (`llm_service.py:147`); retryable vs terminal error classes already enumerated. | A second independent failure domain to instrument and alert on. |
| Async | `litellm.acompletion` already in use (`llm_service.py:668`). | New async HTTP client. |
| Observability | Langfuse plus `increment_metric_counter*` already wrap LLM calls. | Separate. |
| Latency | Higher per call. Flash already carries the relevance-gate workload (`config.py:582`). | Typically sub-300ms. |
| Cost | Higher per call. | Lower. |

The dedicated API wins on raw latency and unit cost and loses on everything
that costs engineering time and legal review, for a V1 whose language matrix is
English and Hindi. The out-of-band visitor-to-operator design removes latency
from the user-visible path, which is most of what the latency advantage was
buying. `TranslationProvider` makes the swap a one-class change once volume
justifies it.

**Decision: LiteLLM for V1.**

## Persistence model

**Stored:**

| Field | Where | Why |
|---|---|---|
| Original text | `ChatMessage.content` | Canonical. Written once at insert, never updated. |
| `source_language` | `ChatMessage.source_language` | The language `content` is in. Needed to pick a translation direction without re-detecting. |
| Translated text, per target language | `ChatMessage.translations[lang].content` | Must survive reload; keyed by language so a transfer to a differently-configured operator can add a key without touching existing ones. |
| `provider`, `model`, `status`, `created_at` | inside the same JSONB entry | Audit and cost attribution. Not returned to clients. |
| `Operator.preferred_locale` | `operators` | The reader's language. |
| `Operator.supported_languages` | `operators` | Phase 5 routing input. |

**Derived, never stored:**

- Target locale (it is the reader's `preferred_locale` or the session's
  `locale`).
- Text direction (`get_locale_direction`).
- Language display names (`language_display_name`).
- Toggle state (client-side UI only).

**Never:**

- Duplicate `ChatMessage` rows for a translation.
- Per-language conversations or sessions.
- Any write to `ChatMessage.content` after insert.

The Redis cache holds only the translated string. It is a performance layer.
The JSONB column is the record.

## Message flows

### Visitor (Hindi) to operator (English): fully out of band

```
1  widget WS  →  {type:"message", content:"मुझे pricing चाहिए", client_msg_id}
2  ws_routes  →  add_chat_message(role="user",
                                  source_language=session.language_code)
                 commit → db_id
3  ws_routes  →  manager.route_visitor_message(..., source_language)   [ORIGINAL]
4  ws_routes  →  send message_ack {client_msg_id, message_id, status}  [~0 ms]
5  ws_routes  →  asyncio.create_task(translate_incoming(db_id, session_id))
                 ├─ resolve target from DB (assigned operator's preferred_locale)
                 ├─ TranslationService.translate(...)      [acompletion, ≤2 s]
                 ├─ UPDATE chat_messages SET translations = ...
                 └─ manager.send_translation_to_operator(...)
                       {type:"message_translation", message_id, language,
                        content, status:"ok"}
6  console     →  merges by message_id, re-renders the bubble with a toggle
```

Step 4 is the reason for the whole shape. `message_ack` is what drives the
visitor's sending → sent → delivered tick, and the visitor loop is a sequential
`await ws.receive_json()`, so anything slow before the ack both stalls the tick
and head-of-line blocks the visitor's next message behind their own
translation. The previous draft placed the provider call inside
`route_visitor_message`, which sits between steps 3 and 4.

On failure at step 5: persist `translations[lang] = {"status": "failed"}` and
emit `status:"unavailable"`. The operator already has the Hindi original from
step 3.

### Operator (English) to visitor (Hindi): awaited, bounded

```
1  console WS →  {type:"message", session_id, content:"Our Enterprise plan..."}
2  ws_routes  →  ownership + status checks (unchanged)
                 add_chat_message(role="operator",
                                  source_language=operator.preferred_locale)
                 commit → db_id           [db_id is currently discarded; capture it]
3  ws_routes  →  await TranslationService.translate(...)   [≤2 s, num_retries=0]
                 UPDATE chat_messages SET translations = ...
4  manager    →  route_operator_message(session_id,
                     delivered_content = translated or original,
                     translated_from   = "en" or None,
                     message_id        = db_id)
5  widget     →  renders delivered_content; on reconnect /chat/history returns
                 translations["hi"] and the widget renders the SAME string
```

The asymmetry is deliberate. This direction may await because no tick is
waiting and the operator is already typing-latency-bound, and because the
visitor-facing string must be persisted before delivery so that step 5's reload
path renders identically. On failure, deliver the English original with no
`translated_from`.

### Same language in both directions

`_should_translate()` returns `False` when
`source_language == target_language`. Zero provider calls, zero cache lookups,
no `translations` entry written. This is both the correct answer to "what
happens when visitor language == operator language" and the single largest cost
saving in the phase.

## Failure and retry strategy

| Condition | Behaviour |
|---|---|
| Provider timeout (>2 s) | Abandon. Visitor→operator: `message_translation` with `status:"unavailable"`. Operator→visitor: deliver the original. Record `translation_status=timeout`. |
| Provider error (auth, 5xx, rate limit) | Same. LiteLLM's own `fallbacks` already handles primary to fallback transparently; do not add a second retry layer on this path. |
| `num_retries` | **0**. Retries are what turn a 2 s budget into a 30 s stall. |
| Empty or whitespace-only provider output | Treated as failure. Never deliver an empty translated bubble over a non-empty original. |
| Session language NULL | Skip translation entirely, `translation_status=no_source_language`. |
| `source_language == target_language` | Skip, no provider call. |
| Feature disabled / kill switch on / insufficient credits | Skip, `translation_status=gated`. Message delivery unaffected. |
| Redis cache down | Treated as a miss. The cache is never load-bearing. |
| DB write of `translations` fails | Log, emit the frame anyway (the operator still gets the translation live), record `translation_status=persist_failed`. Delivery of the original is already complete. |
| Retry | **Operator-initiated only**, via `POST /operators/translate` with `message_id`. No automatic background retry: a stale translation arriving 40 s later, after the operator has already replied, is worse than none. |

The invariant to **test**, not merely assert: there is no code path in which a
`TranslationService` exception prevents `add_chat_message` from committing or
prevents `route_visitor_message` / `route_operator_message` from being called.
This is enforced structurally by placing every provider call after the commit
and outside the delivery statement.

## Caching strategy

```
key:   translation:v1:<sha256(source_language|target_language|text)>
value: the translated string only
TTL:   24 hours
```

- **Hash-only key.** The plaintext never appears in the key, so a Redis
  keyspace dump does not disclose message content.
- **No plaintext logging.** Never log the key next to the text it was derived
  from; doing so makes the hash reversible from the log.
- **Cross-tenant by design, documented.** The value is a pure function of
  (text, source, target). Two workspaces sending byte-identical text share an
  entry. This is safe because a cache hit reveals nothing a caller could not
  obtain by making the call themselves, and because the key is a preimage-
  resistant hash of content the caller already possesses. It is stated here
  explicitly so it is a decision rather than an accident. If a customer segment
  later requires strict isolation, prefix the key with `client_id`; nothing
  else changes.
- **Never load-bearing.** A cache miss, a stale entry, or a Redis outage
  degrades to a provider call.

**Expected hit rate, corrected.** The previous draft claimed
canned-response reuse makes hits likely "from day one" without qualification.
Split by direction:

- **Operator to visitor: genuinely high.** `CannedResponse.content`
  (`models.py:1355`) is byte-identical on every reuse, and operators lean on
  `/shortcut` snippets heavily.
- **Visitor to operator: near zero.** Free-form visitor prose almost never
  repeats.

Do not size the cache, or project cost savings, from a blended figure.

## Metering, credits, and observability

Live chat currently deducts **zero** credits: there is no `credit_service` call
anywhere in `ws_routes.py`. Phase 4 introduces up to two LLM calls per exchange
and must not do so invisibly.

**Pricing keys** added to `credit_service._DEFAULT_PRICING` and seeded by the
migration:

```python
"credit_cost.translation": 1,
"feature.translation_enabled": True,
```

**Gate order**, evaluated before any provider call:

1. `language_config.enabled` and `operator_translation_enabled` both true.
2. `credit_service.is_feature_enabled(session, "translation")` (super-admin
   master switch).
3. `credit_service.is_kill_switch_active(session)` is false (the global credit
   halt covers translation like every other metered action).
4. `credit_service.check_and_deduct(...)` succeeds. On
   `InsufficientCredits` or `KillSwitchActive`, **skip translation and deliver
   the original**. A workspace out of credits loses translation, never live
   chat.

Deduction is scoped with `credit_service.resolve_bot_ledger_bot_id(bot)` and
passes `idempotency_key=f"translation:{message_id}:{target_language}"`, so a
retry or a duplicate task never double-charges. Note the parameter:
`check_and_deduct` (`credit_service.py:545`) takes both `reference_id: int`
and `idempotency_key: str`, and only the latter is the dedupe key.

**Metrics**, via the existing `app/core/metrics.py` counters
(`increment_metric_counter`, `increment_metric_counter_by`), not log lines:

| Counter | Dimension |
|---|---|
| `translation_requests` | `bot_id` |
| `translation_ok` / `translation_failed` / `translation_timeout` | `bot_id` |
| `translation_cache_hit` / `translation_cache_miss` | `bot_id` |
| `translation_skipped_same_language` | `bot_id` |
| `translation_tokens_prompt` / `translation_tokens_completion` | `bot_id` |

Latency is recorded as `translation_latency_ms` on a structured log line
carrying `bot_id`, `session_id`, `status`, `provider`, `model`, `cached`.
**Never the message text, the translated text, or the cache key.**

**Langfuse.** Decide explicitly, in the implementation PR, whether translation
spans are traced. If they are, input and output must be redacted, because a
trace would otherwise carry the full text of every live-chat message into the
observability project.

## Security and privacy model

- **Customer content leaves OyeChats for the first time on this path.** Today,
  live-chat messages between a visitor and a human operator never reach a model
  provider. Phase 4 sends them to OpenAI or Google. Per-bot opt-in is the right
  control, and the default is off. This is a launch-checklist item with a named
  owner, not a footnote.
- **Tenant isolation.** `POST /operators/translate` requires `session_id` and
  ownership-checks it against `auth["client_id"]` through the session's bot,
  matching `GET /operators/session/{id}/details`. The cache is cross-tenant by
  documented design (above).
- **Authorization.** `get_current_client_or_operator`, matching every other
  inbox route. Not `get_current_operator`.
- **Rate limiting.** `30/minute` keyed on the operator credential. Without it
  the endpoint is an authenticated, unmetered LLM proxy.
- **Prompt injection.** Visitor text becomes LLM input whose output is rendered
  to an operator, who holds higher privilege than the visitor. Containment:
  instruction in the system message, content in the user message, and
  **translated output rendered as plain text** in the console. `react-markdown`
  blocks raw HTML and `javascript:` URLs by default, so the residual risk is a
  plausible-looking phishing link rather than XSS, but a link the visitor
  authored and the model laundered should not become a clickable anchor in the
  operator's inbox. Original text keeps Markdown rendering, because it is shown
  as-is and the operator knows it is the visitor's raw words.
- **Logging.** `translation_status` / `translation_latency_ms` /
  `translation_provider` only. Never message content, never translated content,
  never the cache key alongside its input. This matches the existing
  `redact_visitor_ip` / `redact_visitor_metadata` posture in
  `operator_routes.py`.
- **UTF-8 and normalization.** Text is passed through unchanged; no
  normalization, no transliteration, no truncation before the provider call.
  The existing `MAX_WS_MESSAGE_CHARS` (10,000) bound already caps input size.

## Cost and latency impact

- **Visitor to operator: zero added latency** on the user-visible path. The ack
  fires before the provider call starts.
- **Operator to visitor: bounded at 2 s**, typically 300-800 ms with Flash,
  0 ms on a cache hit or a same-language skip.
- **Event loop: zero blocking.** `acompletion` only. This is the difference
  between a slow message and a per-worker outage.
- **Database: one extra `UPDATE chat_messages` per translated message**, by
  primary key. Negligible against the existing composite index.
- **Provider volume: at most two calls per exchange**, reduced by the
  same-language skip (which eliminates the entire English-visitor population)
  and by the cache on the operator direction.
- **Before launch**, estimate real spend from the existing
  `llm_tokens_prompt` / `llm_tokens_completion` counters, which already give
  per-bot token volume for the AI path, then decide whether
  `credit_cost.translation: 1` is the right number.

## Dependencies on previous phases

- **Phase 1**: `language_service.py` for `normalize_locale`,
  `match_supported_locale`, `get_locale_direction`, `language_display_name`;
  `Bot.language_config` including the already-present
  `operator_translation_enabled` key (`models.py:457`).
- **Phase 2**: `ChatSession.language_code` / `locale` (`models.py:850-854`).
  This is the visitor side of every translation call and Phase 4 has a **hard**
  dependency on it. It never re-detects.
- **Phase 3**: no hard code dependency (disjoint file set), but Phase 3 must
  ship first in practice: an operator translating for a visitor whose bot
  answers in English would be an incoherent product.

## Exact implementation steps

1. **Schema.** Add the four columns to `models.py`. Write the migration on the
   `c8f5b2e0a3d9` template with a `_new_columns()` factory. Verify with a real
   upgrade → downgrade → upgrade round trip on the dev DB.
2. **Repository.** Add `source_language` to `add_chat_message`
   (`repository.py:225`).
3. **Config validation.** Reject `operator_translation_enabled: true` when
   `enabled` is false. Validate the **merged** `language_config` in
   `bot_routes.py:2472-2476`, not the request body. No such validator exists
   today.
4. **Credits.** Add `credit_cost.translation` and
   `feature.translation_enabled` to `_DEFAULT_PRICING`; seed them in the
   migration.
5. **`translation_service.py`.** Provider protocol, `LiteLLMTranslationProvider`
   on `acompletion` with `timeout=2.0, num_retries=0`, cache read/write,
   `TranslationUnavailable`, same-language short-circuit, gate chain, metrics.
6. **WS schemas.** Split `MessageFrame` into `VisitorMessageFrame` /
   `OperatorMessageFrame`; register both. Add no visitor language fields.
7. **`live_chat_service.py`.** `_operator_locales` cache in `connect_operator`;
   `source_language` on the outbound visitor message; `delivered_content` /
   `translated_from` / `message_id` parameters on `route_operator_message`; new
   `send_translation_to_operator`.
8. **`ws_routes.py` visitor branch.** Persist with `source_language`, route the
   original, ack, then `asyncio.create_task` the translation. Confirm by test
   that the ack precedes the provider call.
9. **`ws_routes.py` operator branch.** Capture `db_id`, await the bounded
   translation, persist, route with `delivered_content`.
10. **`_resolve_operator_from_key`.** Return `preferred_locale`.
11. **History endpoint.** Return `source_language` and `translations` from
    `get_history_endpoint` (`chat_routes.py:2243`).
12. **`POST /operators/translate`.** Auth, session ownership check, derived
    target, rate limit, optional `message_id` backfill, credit metering. Add
    `key_from_operator_credential` to `rate_limit.py`.
13. **`PATCH /operators/{operator_id}`.** `preferred_locale` (self-edit),
    `supported_languages` (team-management), both validated.
14. **`GET /operators/session/{id}/details`.** Add `language_code` / `locale`.
15. **Admin types.** `liveChatProtocol.ts`, `domain.ts`, `api.d.ts`.
16. **Admin socket.** `applyInbound` handles `message_translation`
    idempotently by `message_id`; `parseHistoryMessage` carries the new fields.
17. **Admin UI.** `TranslationToggle.tsx`, `ConversationLanguageBadge.tsx`,
    `MessageBubble` with `dir` and plain-text translated rendering,
    `SessionDetailsPanel` badge.
18. **Widget.** `LiveChatMode.jsx` history restore prefers
    `translations[sessionLanguage].content`.
19. **Failure injection.** Kill the provider mid-conversation; confirm live
    chat continues uninterrupted in both directions with originals only.
20. **Checks.** `ruff check` + `ruff format` + `pytest` in `api/`;
    `npm run lint` + `npm run build` in `app/` and `widget/`.

## Acceptance criteria

- [ ] Visitor writing in Hindi, operator working in English: the operator sees
      an English translation with the Hindi original one click away; the
      operator's English reply reaches the visitor in Hindi.
- [ ] **The operator refreshes the browser and still sees translations.**
      History carries them.
- [ ] **The visitor's WebSocket drops and reconnects and the thread stays
      entirely in Hindi.** No mixed-language transcript.
- [ ] `ChatMessage.content` is never updated after insert. Translations live
      only in `ChatMessage.translations`.
- [ ] `message_ack` reaches the visitor before any translation work begins.
- [ ] Translation provider outage does not block or delay message delivery in
      either direction.
- [ ] `POST /operators/translate` works for a workspace **owner authenticating
      with `X-API-Key`**, rejects a session belonging to another tenant with
      403, and is rate limited.
- [ ] A cache hit avoids a redundant provider call for a repeated canned
      response.
- [ ] Visitor language == operator language performs **zero** provider calls.
- [ ] An operator can set their own `preferred_locale`; an admin can set
      `supported_languages` for the team.
- [ ] A bot with `enabled: false` cannot be saved with
      `operator_translation_enabled: true`, and an existing row in that state
      translates nothing and errors nothing.
- [ ] Arabic or Hebrew translated text renders right-to-left in the operator
      console.
- [ ] Every translation call increments the metrics counters and is credit
      gated.

## Testing/QA requirements

**Unit**

1. `normalize_locale` round-trip on every accepted `preferred_locale`,
   including script subtags (`zh-Hans-CN`).
2. Same-language short-circuit performs zero provider calls and writes no
   `translations` entry.
3. `TranslationService` raises `TranslationUnavailable` on timeout and on empty
   output; never returns an empty string.
4. The provider prompt places message content in the **user** turn and never
   interpolates it into the system turn.
5. `translations` merge preserves existing keys when a second language is
   added.
6. `LiteLLMTranslationProvider` is called with `timeout=2.0` and
   `num_retries=0` (assert the kwargs).

**Persistence**

7. `add_chat_message` writes `source_language`; `content` is byte-identical to
   the input.
8. No code path updates `ChatMessage.content` after insert.
9. Migration upgrade → downgrade → upgrade in one process against a real dev
   DB. This is the exact failure the `_new_columns()` factory exists to
   prevent.

**WebSocket contract**

10. `parse_frame` accepts the extended frames; a malformed
    `message_translation` payload is rejected with an error frame and the
    socket stays open.
11. A visitor frame carrying `source_language` is **ignored, not trusted**.
12. **Ordering / ack timing:** `message_ack` is emitted before any translation
    work begins. This test must fail against the pre-rewrite design.
13. Two visitor messages in flight whose translations complete out of order
    both resolve to the correct `message_id`.
14. A duplicate `message_translation` for the same `message_id` is a no-op in
    the reducer.

**Failure**

15. Provider raises: the operator still receives the original;
    `message_translation` carries `status:"unavailable"`.
16. Provider raises in the operator to visitor direction: the visitor receives
    the English original, with no `translated_from`.
17. Provider hangs past the timeout: delivery unaffected, one
    `translation_timeout` counter.
18. Redis down: cache miss path, translation still works.
19. Insufficient credits: no translation, message still delivered.

**Reconnect and history**

20. **Visitor reconnects mid-conversation:** `/chat/history` returns translated
    operator messages and the widget renders no mixed-language thread.
    Regression test for C1.
21. **Operator refreshes:** history carries `translations`, the toggle still
    works. Regression test for C2.
22. Grace-period reconnect: a message queued while the operator was
    disconnected arrives, and its translation is present via history.

**Multi-worker**

23. Translation target resolves correctly when the process holding the visitor
    socket does not hold the operator socket (backplane path). Extends
    `tests/test_live_chat_cross_process.py`.
24. Translation decisions never read `assignments` / `operator_connections` /
    `_operator_names` as their source of truth.

**Tenant isolation and auth**

25. `POST /operators/translate` with a `session_id` belonging to another
    `client_id` returns 403. Extends
    `tests/test_live_chat_tenant_isolation.py`.
26. An owner authenticating with `X-API-Key` can call the endpoint
    successfully. Regression test for C5.
27. Rate limit fires at the configured threshold.

**Feature gating**

28. `operator_translation_enabled: true` with `enabled: false` translates
    nothing, raises nothing, and records `no_source_language`.
29. Saving that combination through the bot API is rejected with 422.
30. The credit kill switch suppresses translation without affecting delivery.

**Transfer**

31. Transfer to an operator with a different `preferred_locale`: the new
    operator's thread shows originals plus an on-demand backfill affordance;
    no eager mass translation is triggered.
32. Backfill via `POST /operators/translate` with `message_id` persists into
    the existing row's `translations` without disturbing other keys.

**Rendering**

33. UTF-8 round trip: Devanagari, Arabic, and emoji survive persist → history →
    render unchanged.
34. RTL: an Arabic translation renders with `dir="rtl"`.
35. Translated content containing Markdown link syntax renders as literal text,
    not as an anchor.

**End-to-end (Playwright)**

36. Hindi visitor, English operator, full exchange in both directions, with a
    mid-conversation operator reconnect and a mid-conversation visitor
    reconnect.
37. Provider killed mid-conversation: chat continues uninterrupted in both
    directions.

## Risks and edge cases

- **The server is the authoritative translation boundary.** No visitor-supplied
  language metadata is accepted anywhere. `ChatSession.language_code` (Phase 2)
  is the only source of truth for the visitor side.
- **Multi-worker.** `assignments`, `operator_connections`, `_operator_names`,
  and `_operator_locales` are per-process. With `WS_BACKPLANE_ENABLED` the
  worker holding the visitor socket routinely does not hold the operator
  socket, and `route_visitor_message` already returns `False` in that case even
  though the backplane delivered. Translation therefore resolves its target
  from the database. The `_operator_locales` cache is a display convenience
  only and must never gate a translation decision.
- **Head-of-line blocking.** The visitor socket loop is a sequential
  `await ws.receive_json()`. Anything slow before the ack blocks the visitor's
  next message. This is why translation is a detached task.
- **Detached-task lifetime.** `asyncio.create_task` results must be held in a
  set with a done-callback discard, otherwise the task can be garbage-collected
  mid-flight. Exceptions inside it must be caught and counted, never left to
  surface as an unretrieved-exception warning.
- **Transfer.** `transfer_chat` (`live_chat_service.py:947`) reassigns to an
  operator whose `preferred_locale` may have no `translations` key. Behaviour
  is **bounded on-demand backfill**: the console requests translation for the
  visible window only, one call per message, operator-triggered. Never an eager
  sweep of the whole transcript, which would spike cost and latency at the
  exact moment an operator is trying to pick up a conversation.
- **PII to a model provider.** Inherits the existing LLM data-handling posture.
  Flag to the team whether that is sufficient for the customer segments this
  ships to.
- **Cost visibility.** Do not project savings from a blended cache-hit rate.
  See *Caching strategy*.

## Rollback considerations

- Gated behind `bot.language_config.operator_translation_enabled` (Phase 1
  default `false`). Disabling per bot is instant and code-free.
- A second, global lever exists: `feature.translation_enabled` in
  `pricing_config`, editable from the super-admin panel, which stops every
  translation everywhere with no deploy.
- All four columns are additive and nullable (or defaulted), so a pre-launch
  schema rollback is safe. Once operators have set `preferred_locale` in
  production, prefer disabling via flag over a schema rollback.
- WS changes are additive fields plus one new frame type. An older admin build
  ignoring `message_translation` degrades to originals only; a rolled-back
  backend simply stops emitting it. `_Frame` ignores unknown keys, so neither
  direction breaks a live conversation.
- Persisted `translations` left behind by a rolled-back feature are inert: no
  client reads them unless the feature is on.

## Audit traceability

Mapping from the 2026-08-24 architecture review to this document.

| Finding | Resolution |
|---|---|
| **C1** Visitor sees translation live, original after reconnect | *Persistence model*, *Message flows*, widget row in the file table, tests 20 and 37 |
| **C2** Translations lost on operator refresh | `chat_routes.py` history row in the file table, *API/WebSocket changes → REST*, `parseHistoryMessage` row, test 21 |
| **C3** Synchronous LLM call on the event loop | *Backend/service changes* rule 1, step 5, test 6 |
| **C4** Translation inside the delivery-ack path | *Message flows* visitor direction, step 8, test 12 |
| **C5** Preview endpoint mis-authed, unscoped, unthrottled | *API/WebSocket changes → REST*, *Security and privacy model*, tests 25 to 27 |
| **C6** Uncosted LLM spend | *Metering, credits, and observability*, step 4, tests 19 and 30 |
| **H1** `add_chat_message` cannot write new columns | File table, step 2, test 7 |
| **H2** No path for `preferred_locale` to the routing layer | `_resolve_operator_from_key` + `connect_operator` rows, steps 7 and 10 |
| **H3** Multi-worker decisions unreliable | *Architecture* invariant 4, *Risks*, tests 23 and 24 |
| **H4** Phase 1/2 gate interaction leaves language NULL | *Prerequisites and NULL-language fallback*, steps 3, tests 28 and 29 |
| **H5** Transfer loses translation | *Risks → Transfer*, `POST /operators/translate` backfill, tests 31 and 32 |
| **H6** `preferred_locale` has no writable route | `PATCH /operators/{operator_id}` row, step 13 |
| **H7** Session details needs a backend change | `GET /operators/session/{id}/details` row, step 14 |
| **H8** `MessageFrame` shared by both sockets | *API/WebSocket changes → Inbound frames*, step 6, test 11 |
| **M1** No RTL in the operator console | *Frontend changes*, test 34 |
| **M2** Translated output rendered as Markdown | *Security and privacy model*, *Frontend changes*, test 35 |
| **M3** New router prefix | `POST /operators/translate` under the existing `/operators` router |
| **M4** Cache key design | *Caching strategy* |
| **M5** Grace-period queue and translations | *Testing* item 22 |
| **M6** JSONB on the fastest-growing table | *Database/schema changes* |
| **M7** Log-only observability | *Metering, credits, and observability* |
| **M8** Stale line references | File table re-verified line by line against the live repository. Note: the review's own claim that `WsMessage` had moved was wrong; the original draft's `144-151` was correct and is restored. Four genuine corrections were made: `chat_routes.py` response builder is 2174-2189 (not 2243-2258), `Operator` ends at 1105, `domain.ts` `ChatMessage` is 229-239, and `check_and_deduct` dedupes on `idempotency_key`, not `reference_id`. |
| **L1** Cache-hit assumption | *Caching strategy → Expected hit rate, corrected* |
| **L2** `live_chat_queue_service.py` untouched | *Non-scope* |
