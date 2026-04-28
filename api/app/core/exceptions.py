"""Custom application exceptions and the metadata FastAPI handlers use.

Keeping these in ``app.core`` (rather than near the routes that raise them)
avoids circular imports when handlers and route modules need to reference the
same exception classes.
"""

from __future__ import annotations


class SessionOwnershipError(Exception):
    """A chat session exists, but it doesn't belong to the requesting bot.

    Two cases:

    1. The existing row has ``bot_id IS NULL`` (legacy / pre-multi-bot data).
       We deliberately do **not** auto-claim it for the requesting bot at
       runtime — that would silently grant whoever asks first ownership of
       any orphan session. The Alembic backfill migration handles unambiguous
       cases (single-bot clients); the rest surface here.
    2. The existing row's ``bot_id`` differs from the caller's. Cross-bot
       access is rejected explicitly instead of being papered over with a
       primary-key collision on INSERT.

    Both cases are mapped to **HTTP 404** at the API boundary so that the
    response is indistinguishable from "session does not exist". The widget
    treats 404 as "regenerate session_id and retry".
    """

    def __init__(self, session_id: str, expected_bot_id: int | None, actual_bot_id: int | None) -> None:
        self.session_id = session_id
        self.expected_bot_id = expected_bot_id
        self.actual_bot_id = actual_bot_id
        super().__init__(
            f"Session {session_id!r} does not belong to bot_id={expected_bot_id} (actual bot_id={actual_bot_id})."
        )
