"""Schemas for live-chat WebSocket frames.

The two socket loops in ``app.api.ws_routes`` were the last untrusted input
surface in the app with no schema behind it. They read frames as raw dicts and
reached into them field by field::

    data = await ws.receive_json()
    content = data.get("content", "").strip()      # AttributeError if int
    last_read_id = data.get("last_read_id")        # any JSON value, unchecked

Three consequences, all reachable from a public widget socket:

* **Type confusion.** ``{"type": "message", "content": 123}`` raises
  ``AttributeError`` inside the loop. A non-object frame (``[1, 2, 3]``) makes
  ``data.get`` itself fail. Either kills the connection mid-conversation.
* **Unenforced contracts.** The ``submit_offline_form`` branch carries a
  comment saying its validation "matches the existing HTTP endpoint contract".
  It did not: the HTTP endpoint syntax-checks the address, the socket only
  truncated it — so the socket was the way to store an unvalidated address
  that later becomes an email recipient.
* **Per-branch drift.** Each branch invented its own truncation constants, so
  the same field had a different ceiling depending on which socket it came in
  through.

Validating the frame once, up front, fixes all three. ``parse_frame`` is
deliberately non-raising: a socket is a long-lived session and a single
malformed frame should cost the sender that frame, not the conversation — so
it returns ``None`` and the loop answers with an error frame and continues.

Frames are discriminated on ``type``, so an unknown ``type`` is rejected here
rather than silently falling off the end of the if/elif chain.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, ValidationError

from app.schemas.validators import (
    EmailAddress,
    Identifier,
    Name,
    Phone,
    RequiredLongText,
    RequiredName,
    SessionId,
    bounded_list,
)

#: Longest chat message body accepted over a socket. Matches the ceiling the
#: visitor loop already applied by hand.
MAX_WS_MESSAGE_CHARS = 10_000

#: Turns kept from a visitor-supplied transcript on offline-form fallback.
MAX_TRANSCRIPT_TURNS = 200


class _Frame(BaseModel):
    """Base for every frame. Unknown keys are ignored, not rejected.

    Deliberate: widget and operator-console builds roll forward independently
    of the API, and an older server refusing a frame because a newer client
    added a field would break live conversations. Every field the server acts
    on is declared, so an undeclared key cannot reach any handler.
    """

    type: str


class PingFrame(_Frame):
    type: Literal["ping"]


class HeartbeatFrame(_Frame):
    type: Literal["heartbeat"]


class StatusCheckFrame(_Frame):
    type: Literal["status_check"]


class TypingFrame(_Frame):
    type: Literal["typing"]
    # Present on the operator socket (which session is being typed into),
    # absent on the visitor socket.
    session_id: SessionId | None = None


class StoppedTypingFrame(_Frame):
    type: Literal["stopped_typing"]
    session_id: SessionId | None = None


class MessageFrame(_Frame):
    type: Literal["message"]
    content: str = Field(..., min_length=1, max_length=MAX_WS_MESSAGE_CHARS)
    # Client-generated correlation id echoed back in ``message_ack`` so the
    # widget can move its optimistic entry to sent/delivered/read.
    client_msg_id: Identifier | None = None
    # Operator socket only — which conversation the message is for.
    session_id: SessionId | None = None


class FileFrame(_Frame):
    type: Literal["file"]
    # Re-checked against ``_is_safe_file_url`` in the loop, which pins it to
    # our own CDN host; this bounds it before that check runs.
    file_url: str = Field(..., min_length=1, max_length=2048)
    filename: str = Field(default="file", max_length=200)
    content_type: str = Field(default="", max_length=128)
    client_msg_id: Identifier | None = None
    session_id: SessionId | None = None


class ReadReceiptFrame(_Frame):
    type: Literal["read_receipt"]
    # A ``chat_messages.id``. Previously forwarded to the peer as whatever
    # JSON value arrived — including an object or an array.
    last_read_id: int = Field(..., ge=1)
    session_id: SessionId | None = None


class LeaveQueueFrame(_Frame):
    type: Literal["leave_queue"]


class VisitorEndChatFrame(_Frame):
    type: Literal["visitor_end_chat"]


class PongFrame(_Frame):
    """Client's reply to the server heartbeat. Acknowledged by ignoring it."""

    type: Literal["pong"]


class SetAvailabilityFrame(_Frame):
    type: Literal["set_availability"]
    accepting: bool = True


class CloseChatFrame(_Frame):
    type: Literal["close_chat"]
    session_id: SessionId


class TranscriptTurn(BaseModel):
    role: str = Field(default="user", max_length=20)
    content: str = Field(default="", max_length=5_000)
    ts: str = Field(default="", max_length=40)


class SubmitOfflineFormFrame(_Frame):
    """Mid-flow fallback to the offline form.

    Field-for-field the same contract as ``POST /offline-messages`` — including
    the email syntax check the socket path was missing, which matters because
    every one of these fields is rendered into a notification email and into
    the admin inbox.
    """

    type: Literal["submit_offline_form"]
    name: RequiredName
    email: EmailAddress
    phone: Phone | None = None
    message: RequiredLongText
    reason: Name = "manual"
    transcript: Annotated[list[TranscriptTurn], bounded_list(MAX_TRANSCRIPT_TURNS)] | None = None


#: Frames the visitor socket accepts.
VISITOR_FRAMES: dict[str, type[_Frame]] = {
    "ping": PingFrame,
    "message": MessageFrame,
    "file": FileFrame,
    "typing": TypingFrame,
    "stopped_typing": StoppedTypingFrame,
    "read_receipt": ReadReceiptFrame,
    "status_check": StatusCheckFrame,
    "submit_offline_form": SubmitOfflineFormFrame,
    "leave_queue": LeaveQueueFrame,
    "visitor_end_chat": VisitorEndChatFrame,
    "pong": PongFrame,
}

#: Frames the operator socket accepts.
OPERATOR_FRAMES: dict[str, type[_Frame]] = {
    "ping": PingFrame,
    "heartbeat": HeartbeatFrame,
    "set_availability": SetAvailabilityFrame,
    "message": MessageFrame,
    "file": FileFrame,
    "typing": TypingFrame,
    "stopped_typing": StoppedTypingFrame,
    "read_receipt": ReadReceiptFrame,
    "close_chat": CloseChatFrame,
    "pong": PongFrame,
}


def parse_frame(raw: object, allowed: dict[str, type[_Frame]]) -> tuple[_Frame | None, str | None]:
    """Validate one decoded frame against *allowed*.

    Returns ``(frame, None)`` on success and ``(None, reason)`` on rejection.
    Never raises: the caller is a socket loop, and dropping a whole live
    conversation because one frame was malformed is a worse outcome than
    refusing the frame.
    """
    if not isinstance(raw, dict):
        return None, "Frame must be a JSON object."
    msg_type = raw.get("type")
    if not isinstance(msg_type, str):
        return None, "Frame is missing a string 'type'."
    model = allowed.get(msg_type)
    if model is None:
        return None, f"Unsupported frame type '{msg_type[:40]}'."
    try:
        return model.model_validate(raw), None
    except ValidationError as exc:
        first = exc.errors()[0]
        field = ".".join(str(p) for p in first.get("loc", ())) or "frame"
        return None, f"Invalid '{msg_type}' frame: {field} — {first.get('msg', 'invalid')}"
