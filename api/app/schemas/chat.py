from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=5000)
    # Caller may pass a previously issued session_id for continuity.
    # The backend validates ownership before trusting it; mismatched sessions
    # receive a fresh server-generated UUID.
    session_id: str | None = Field(None, max_length=64)
    # BR-02: set when ``question`` is the visitor's tap on an active
    # qualification CTA pill, naming which dimension it answers — lets the
    # backend score the answer deterministically from the rubric instead of
    # re-interpreting it as free text. Untrusted input: the backend only
    # trusts this when the exact text also matches one of that dimension's
    # configured option labels (see ``rag_service._score_cta_answer``);
    # otherwise it's ignored and the message falls back to normal extraction.
    cta_dimension: str | None = Field(None, max_length=64)


class FeedbackRequest(BaseModel):
    feedback: int = Field(..., ge=-1, le=1, description="1 for positive, -1 for negative")
