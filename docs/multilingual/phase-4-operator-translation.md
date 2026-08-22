# Phase 4 — Operator Multilingual Live Chat

## Objective

Let a visitor converse in their language while an operator works in theirs:
incoming visitor messages are translated for the operator, operator replies
are translated back to the visitor, originals are always preserved, and
translation failure never blocks live chat.

## Scope

- `TranslationService` abstraction (`api/app/services/translation_service.py`).
- `ChatMessage` translation-metadata columns; `Operator` language-preference
  columns.
- WebSocket frame extensions on both `/ws/chat/{session_id}` (visitor) and
  `/ws/operator` (operator) routes, validated centrally in
  `api/app/schemas/ws.py`.
- Translation hooks inside `ConnectionManager.route_visitor_message` /
  `route_operator_message` (`api/app/services/live_chat_service.py`).
- Admin inbox UI: original/translated toggle, language badge, translated
  message rendering — built against the **actual current** `app/src/features/
  inbox/*` files (the Admin Platform 2.0 rebuild is already complete here;
  there is no `pages/LiveChat.jsx` to modify).

## Non-scope

- Language-based operator routing (Phase 5 — this phase's `Operator.
  supported_languages` column exists so Phase 5 can filter on it, but the
  routing-strategy change itself is Phase 5's).
- Translation caching by Redis key (this phase can ship a first version with
  request-scoped/no caching if needed and add caching without protocol
  changes; recommended to include caching now since the surface is small —
  see Backend/service changes).
- Any change to `live_chat_queue_service.py` (pure FIFO, no language logic
  belongs there per its existing scope).

## Existing files/components affected

**Backend**

| File | Change |
|---|---|
| `api/app/schemas/ws.py` — `MessageFrame` (lines 95-102), `VISITOR_FRAMES`/`OPERATOR_FRAMES` (lines 173-199), `parse_frame()` (line 202) | Add optional fields to `MessageFrame`: incoming `source_language`/`source_locale` (visitor→server, informational only — server remains authoritative per the source plan's rule); outbound `translation: {language, content}` (server→operator) and `target_locale` (operator→server, for the reply). |
| `api/app/api/ws_routes.py` — visitor `message` handling (lines 350-414, `message_ack` built 406-414), operator `message` handling (lines 801-829) | After persisting the message (existing `add_chat_message` calls), invoke translation before calling `manager.route_visitor_message`/`route_operator_message`. |
| `api/app/services/live_chat_service.py` — `ConnectionManager.route_visitor_message` (lines 1258-1302, builds `msg` dict 1275-1281) | Attach `translation` to the outbound `msg` dict sent to the operator, computed via `TranslationService`, only if the operator's `preferred_locale` differs from the visitor's resolved language and `bot.language_config.operator_translation_enabled` is true. |
| `api/app/services/live_chat_service.py` — `ConnectionManager.route_operator_message` (lines 1304-1315, builds outbound payload 1304-1315) | Translate `content` into the visitor's session language before calling `_send_to_visitor`, attaching the translated text as the delivered `content` while the original (operator's own language) is what gets persisted via `add_chat_message` beforehand in `ws_routes.py` — **the DB always stores the operator's original text; only the wire payload to the visitor carries the translated text.** |
| `api/app/db/models.py` — `ChatMessage` (lines 1210-1253), `Operator` (lines 1010-1084) | Add columns (below). |
| `api/app/services/live_chat_routing_service.py` (module docstring lines 29-35 explicitly flags department-aware filtering as a documented, not-yet-implemented "one-line change" on the `candidates` list) | **No functional change in this phase** — noted here only because Phase 5's future language-routing filter follows the exact same shape this docstring already describes; Phase 4 just makes sure `Operator.supported_languages` exists so that filter has data to read. |
| `api/app/api/auth.py` — `get_current_operator` (lines 581-630, `X-Operator-Key`/`X-Agent-Key` via `_resolve_operator_key`, line 377) | Reused as-is for the new REST preview-translate endpoint (no changes needed — just the correct dependency to use). |

**Admin app** (`app/src/features/inbox/*` — confirmed `.tsx`/`.ts`, this is
the real, current live-chat inbox; there is no legacy `pages/LiveChat.jsx`)

| File | Change |
|---|---|
| `app/src/features/inbox/liveChatProtocol.ts` — `WsMessage` interface (lines 144-151), `OperatorMessage` type (lines 64-75) | Add `translation?: { language: string; content: string }` to `WsMessage`; add `translatedContent?: string`, `detectedLanguage?: string` to `OperatorMessage`. |
| `app/src/features/inbox/useOperatorSocket.ts` — `applyInbound` reducer (lines 147-348), `case 'message': case 'file':` (lines 174-215) | Parse the new `translation` field off the inbound WS frame and attach it to the `OperatorMessage` entry pushed into `messagesBySession`. |
| `app/src/features/inbox/ConversationView.tsx` — `MessageBubble` (lines 117-180, timestamp span at 175-177) | Add a language badge and an original/translated toggle near the timestamp; swap rendered `message.content` for `message.translatedContent` based on toggle state (default: show translated to the operator, with a one-click "View original" per the source plan's UX). |
| `app/src/features/inbox/SessionDetailsPanel.tsx` — `SessionDetails` type (`liveChatProtocol.ts` lines 99-125, includes `location`/`device`/`visitor_metadata`) | Add a per-session visitor-language badge in the header area (candidate location for the "🇮🇳 Hindi" badge from the source plan's UX mock), sourced from `ChatSession.language_code` surfaced through the session-details API response. |

## New files/components required

- `api/app/services/translation_service.py`
- `app/src/features/inbox/TranslationToggle.tsx`
- `app/src/features/inbox/ConversationLanguageBadge.tsx`

## Database/schema changes

`ChatMessage` (`api/app/db/models.py:1210-1253`):

```python
source_language = Column(String(16), nullable=True)
source_locale = Column(String(32), nullable=True)
translations = Column(JSONB, nullable=True)
# shape: {"en": {"content": "...", "provider": "internal", "created_at": "..."}}
```

`Operator` (`api/app/db/models.py:1010-1084`):

```python
preferred_locale = Column(String(32), nullable=True)
supported_languages = Column(JSONB, nullable=False, default=list, server_default=sqlalchemy.text("'[]'::jsonb"))
```

Migration: two idempotent-guard migrations (or one migration touching both
tables), following the `c9e2a4f7b1d3_bot_answer_links.py` template. No index
needed on `ChatMessage.source_language` unless Phase 5's analytics queries
prove it necessary (same "don't over-index until proven" rule as Phase 1).

## API/WebSocket changes

**Visitor → server** (`/ws/chat/{session_id}`, `MessageFrame`):
```json
{ "type": "message", "content": "मुझे pricing चाहिए", "client_msg_id": "...", "locale": "hi-IN" }
```
(`locale` here is informational/redundant with the session's already-resolved
`ChatSession.locale` from Phase 2 — the server does not trust it blindly, per
the source plan's explicit rule; it's included for parity with the schema and
potential future client-side hints only.)

**Server → operator** (over `/ws/operator`):
```json
{
  "type": "message", "role": "user", "content": "मुझे pricing चाहिए",
  "message_id": 123, "source_language": "hi", "source_locale": "hi-IN",
  "translation": { "language": "en", "content": "I need pricing information." }
}
```

**Operator → server**:
```json
{ "type": "message", "content": "Our Enterprise plan starts at...", "target_locale": "hi-IN" }
```

New REST endpoint (translation preview, auth via `get_current_operator`):
```
POST /live-chat/translate
{ "text": "...", "source_locale": "en-IN", "target_locale": "hi-IN" }
→ { "translated": "...", "provider": "...", "cached": false }
```
This lets the operator preview a translation before sending, per the source
plan's inbox UX (`[Preview translation]  [Send]`).

## Frontend changes

Covered in the file table above. Additional UX detail: operators can toggle
per-message or globally between **Original / Translated / Both** (source
plan §20) — for V1, implement the per-message toggle only
(`TranslationToggle.tsx` next to each `MessageBubble`); a global session-level
default (Both/Translated) is a reasonable Phase 5+ enhancement, not required
for V1.

## Backend/service changes

`api/app/services/translation_service.py`:

```python
class TranslationService:
    async def translate(self, text: str, source_locale: str, target_locale: str) -> str: ...

class TranslationProvider(Protocol):
    async def translate(self, text: str, source_locale: str, target_locale: str) -> str: ...

class LiteLLMTranslationProvider:
    # reuses the existing LiteLLM router (api/app/services/llm_service.py) —
    # per the source plan's explicit instruction to "reuse the existing
    # LLM/LiteLLM stack where practical" rather than integrating a dedicated
    # translation API for V1.
    ...
```

Caching: Redis key `translation:<sha256(text + source_locale + target_locale +
provider_version)>`, short-to-medium TTL — implement in this phase (not
deferred), since the key scheme is simple and canned-response reuse
(`CannedResponse` model, referenced in root `CLAUDE.md`'s schema table) makes
cache hits likely from day one.

Failure handling (source plan §31, non-negotiable): if `TranslationService`
raises or times out, `route_visitor_message`/`route_operator_message` must
**still deliver the message** with `translation: null` — the operator sees
the original text and can still respond; live chat must never block on
translation availability. Telemetry: log `translation_status`/
`translation_latency_ms`/`translation_provider` (never raw message content,
per the source plan's privacy rule).

## Dependencies on previous phases

- **Phase 1**: `language_service.py` for locale validation/normalization.
- **Phase 2**: `ChatSession.language_code`/`locale` — the visitor's side of
  every translation call.
- **Phase 3**: conceptually expected to precede this (AI-native responses
  should ship before operator translation, per the release-mapping in the
  README) but has no hard code dependency — Phase 4 touches a disjoint file
  set (`live_chat_service.py`, `ws_routes.py`, `translation_service.py`,
  `app/src/features/inbox/*`) from Phase 3's (`rag_service.py`,
  `response_style.py`, `qualification_service.py`), so it can be built in
  parallel with Phase 3 if the team wants to.

## Exact implementation steps

1. Add `ChatMessage` and `Operator` columns; migrations.
2. Build `translation_service.py` with the `LiteLLMTranslationProvider`
   implementation and Redis caching.
3. Extend `MessageFrame`/`VISITOR_FRAMES`/`OPERATOR_FRAMES` in `schemas/ws.py`.
4. Wire translation into `ws_routes.py`'s visitor/operator `message` handlers
   and `ConnectionManager.route_visitor_message`/`route_operator_message`.
5. Add `POST /live-chat/translate` (operator-auth) for preview.
6. Admin: extend `liveChatProtocol.ts` types.
7. Admin: extend `useOperatorSocket.ts`'s `applyInbound` for the `translation`
   field.
8. Admin: build `TranslationToggle.tsx`, `ConversationLanguageBadge.tsx`;
   wire into `ConversationView.tsx`'s `MessageBubble` and
   `SessionDetailsPanel.tsx`.
9. Failure-injection test: kill the translation provider mid-conversation,
   confirm live chat continues uninterrupted with original-only messages.

## Acceptance criteria

- [ ] Visitor writing in Hindi, operator working in English: operator sees an
      English translation with the Hindi original one click away; operator's
      English reply is delivered to the visitor in Hindi.
- [ ] Original message content is never overwritten in `ChatMessage.content` —
      translations live exclusively in `ChatMessage.translations` (JSONB) and
      the WS `translation` field.
- [ ] Translation provider outage does not block message delivery in either
      direction.
- [ ] `POST /live-chat/translate` works for operator-side preview before
      sending.
- [ ] Cache hit avoids a redundant provider call for repeated canned
      responses.
- [ ] `Operator.preferred_locale`/`supported_languages` are settable (even if
      the admin UI for them ships in Phase 5 — the columns and API must exist
      now for that UI to write to).

## Testing/QA requirements

- Live-chat test matrix (source plan §33.5): visitor Hindi → operator English;
  visitor Spanish → operator English; operator reply → visitor language;
  original preserved; translation unavailable → live chat still works.
- WebSocket contract tests: `parse_frame()` accepts the extended `MessageFrame`
  shape; rejects malformed `translation`/`target_locale` values without
  crashing the connection.
- E2E (Playwright, source plan §33.6 items 7-8): live handoff + translation,
  operator reconnect (confirm reconnect reads persisted `ChatSession`/
  `ChatMessage` state, not a redetection — per the source plan's Rule E).

## Risks and edge cases

- **Server remains the authoritative translation boundary** (source plan
  §17) — never trust a visitor-supplied `locale` field on the `MessageFrame`
  for anything beyond a hint; the session's already-resolved
  `ChatSession.locale` (Phase 2) is the source of truth.
- **Latency stacking**: translation must not add perceptible delay to the
  live-chat send path. `_send_to_visitor`/`_send_to_operator`
  (`live_chat_service.py:1525-1544`/`1566-1578`) fall back to a Redis
  backplane for multi-worker delivery — the translation call must complete
  (or fail over) before that hop, so keep the provider call on a tight
  timeout (recommend ≤2s) with immediate fallback to untranslated delivery.
- **PII to a translation provider**: since Phase 4 reuses the existing
  LiteLLM stack (not a new third-party API), this inherits whatever data
  handling agreements already exist for LLM calls — flag to the team whether
  that's sufficient for the customer segments this ships to, per the source
  plan's security/privacy rules (§32).

## Rollback considerations

- Gated behind `bot.language_config.operator_translation_enabled` (Phase 1
  default: `false`) — disabling per-bot is instant and code-free.
- `ChatMessage.translations`/`Operator.preferred_locale`/
  `supported_languages` are all additive/nullable — safe to roll back schema
  if the feature is abandoned pre-launch; once operators have set
  `preferred_locale` in production, prefer disabling via flag over a schema
  rollback.
- WS frame extensions are additive fields on existing frame types — an old
  admin build ignoring the new `translation` field degrades gracefully (shows
  original text only), and a rolled-back backend simply stops populating it.
