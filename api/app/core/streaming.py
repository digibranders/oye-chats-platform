"""Streaming responses that close their body in the task that streamed it."""

import logging

import anyio
from fastapi.responses import StreamingResponse
from starlette.types import Send

logger = logging.getLogger(__name__)

#: How long closing an abandoned body may take. The close is shielded from the
#: request's cancellation, so without a bound a close stuck on the network would
#: hold the response task open.
BODY_CLOSE_TIMEOUT_S = 5.0


class ClosingStreamingResponse(StreamingResponse):
    """A ``StreamingResponse`` that closes its body iterator in the streaming task.

    Starlette stops iterating the body when the client leaves while a frame is
    being sent (the send is cancelled on ASGI spec 2.3 and raises ``OSError`` on
    2.4), and it never closes the body. The async generator finalizer then
    closes it later, in a task of its own, so every ``with`` block suspended
    inside the body exits in a foreign context: an OpenTelemetry span attached
    there cannot be detached ("Failed to detach context"), and cleanup such as
    releasing the chat concurrency slot waits on garbage collection.

    Closing a body that already finished is a no-op, so a stream that ran to its
    end, or raised, behaves exactly as before.
    """

    async def stream_response(self, send: Send) -> None:
        try:
            await super().stream_response(send)
        finally:
            aclose = getattr(self.body_iterator, "aclose", None)
            if aclose is not None:
                # Shielded: on spec 2.3 this task is being cancelled, and anyio
                # would otherwise cancel the close again at its first await.
                with anyio.move_on_after(BODY_CLOSE_TIMEOUT_S, shield=True) as close_scope:
                    try:
                        await aclose()
                    except Exception:
                        logger.exception("Closing an abandoned streaming response body failed")
                if close_scope.cancelled_caught:
                    logger.warning(
                        "Closing an abandoned streaming response body timed out after %ss", BODY_CLOSE_TIMEOUT_S
                    )
