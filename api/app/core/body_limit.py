"""Global request-body ceiling.

Every JSON endpoint in this app validates the *shape* of what it parses, but
nothing stopped a client from sending the parser 400 MB in the first place.
Two properties of the stack make that worse than it sounds:

* ``Request.json()`` buffers the whole body before Pydantic sees a single
  field, so per-field ``max_length`` constraints do nothing about total size.
* ``POST /webhooks/razorpay`` reads the raw body *before* it can verify the
  HMAC — signature checking needs the bytes — so an unauthenticated caller
  controls that allocation.

nginx caps bodies at 50–60 MB in production, but nginx is not in the loop for
local dev, Docker Compose, tests, or any future deployment that fronts the app
differently. A limit that only exists in one deployment's reverse proxy is not
a limit the application has.

Implemented as raw ASGI rather than ``BaseHTTPMiddleware`` deliberately:
``BaseHTTPMiddleware`` runs the downstream app in a task group with the body
already flowing, so refusing mid-stream there races the endpoint. At the ASGI
layer we can answer 413 and simply never forward the rest.

Two checks, because either alone is bypassable:

1. ``Content-Length``, when present — rejects before a single byte of body is
   read. A client can lie about or omit this header.
2. A running byte count over the streamed chunks — catches the liar, and
   catches ``Transfer-Encoding: chunked``, which has no ``Content-Length`` at
   all.
"""

from __future__ import annotations

import logging

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

#: Ceiling for ordinary JSON / form requests. Two orders of magnitude above
#: the largest legitimate body (a bot config with a full BANT rubric is a few
#: KB) and far below anything that threatens the worker's memory.
DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024

#: Ceiling for multipart upload routes. Matches the per-request total the
#: document pipeline already enforces (``_MAX_TOTAL_UPLOAD`` = 60 MB) plus
#: multipart framing overhead, so this middleware never rejects an upload the
#: endpoint would have accepted — it only stops what nothing else would.
UPLOAD_MAX_BODY_BYTES = 64 * 1024 * 1024

#: Path prefixes that legitimately carry multipart file bodies.
UPLOAD_PATH_PREFIXES: tuple[str, ...] = (
    "/ingest",
    "/documents/upload",
    "/client/upload-logo",
    "/client/upload-avatar",
    "/operators/upload",
)


def limit_for_path(path: str) -> int:
    """Byte ceiling that applies to *path*."""
    if path.startswith(UPLOAD_PATH_PREFIXES):
        return UPLOAD_MAX_BODY_BYTES
    return DEFAULT_MAX_BODY_BYTES


class BodySizeLimitMiddleware:
    """Reject request bodies larger than the per-path ceiling with a 413."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        upload_max_body_bytes: int = UPLOAD_MAX_BODY_BYTES,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.upload_max_body_bytes = upload_max_body_bytes

    def _limit_for(self, path: str) -> int:
        if path.startswith(UPLOAD_PATH_PREFIXES):
            return self.upload_max_body_bytes
        return self.max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # WebSocket frames are bounded by the live-chat handler's own message
        # cap; lifespan has no body at all.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        limit = self._limit_for(path)

        headers = Headers(scope=scope)
        declared = headers.get("content-length")
        if declared is not None:
            try:
                if int(declared) > limit:
                    await self._reject(scope, send, limit, path, declared_bytes=int(declared))
                    return
            except ValueError:
                # A malformed Content-Length is not ours to interpret; the
                # streamed counter below still bounds the request.
                pass

        received = 0
        too_large = False

        async def counting_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    too_large = True
                    # Hand the endpoint a clean end-of-stream instead of the
                    # oversized chunk. It will fail its own parse and return
                    # an error; we never buffer past the ceiling.
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        sent_response = False

        async def guarded_send(message: Message) -> None:
            nonlocal sent_response
            if too_large and not sent_response and message["type"] == "http.response.start":
                sent_response = True
                await _send_413(send, limit)
                return
            if too_large and sent_response and message["type"] != "http.response.start":
                # Swallow the endpoint's body; we already answered 413.
                return
            await send(message)

        await self.app(scope, counting_receive, guarded_send)

    async def _reject(self, scope: Scope, send: Send, limit: int, path: str, *, declared_bytes: int) -> None:
        logger.warning(
            "Request body rejected: %s %s declared %d bytes, limit %d",
            scope.get("method", "?"),
            path,
            declared_bytes,
            limit,
        )
        await _send_413(send, limit)


async def _send_413(send: Send, limit: int) -> None:
    body = (
        b'{"detail":"Request body too large. Maximum allowed size is '
        + str(limit // (1024 * 1024)).encode()
        + b' MB.","code":"payload_too_large"}'
    )
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})
