from pydantic import BaseModel, Field

from app.schemas.validators import SessionId


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=5000)
    # Caller may pass a previously issued session_id for continuity.
    # The backend validates ownership before trusting it; mismatched sessions
    # receive a fresh server-generated UUID.
    #
    # Constrained to the opaque-identifier charset rather than a bare bounded
    # string because an accepted value becomes a ``chat_sessions`` primary key
    # (``ensure_chat_session`` inserts on miss), a Redis cache key fragment,
    # and a log field. All three formats this platform has ever minted
    # (``<uuid4>``, ``session_<uuid4>``, ``sess-<b36>-<b36>``) satisfy it.
    session_id: SessionId | None = None
    # BR-02: set when ``question`` is the visitor's tap on an active
    # qualification CTA pill, naming which dimension it answers. Lets the
    # backend score the answer deterministically from the rubric instead of
    # re-interpreting it as free text. Untrusted input: the backend only
    # trusts this when the exact text also matches one of that dimension's
    # configured option labels (see ``rag_service._score_cta_answer``);
    # otherwise it's ignored and the message falls back to normal extraction.
    cta_dimension: str | None = Field(None, max_length=64)


class FeedbackRequest(BaseModel):
    feedback: int = Field(..., ge=-1, le=1, description="1 for positive, -1 for negative")
