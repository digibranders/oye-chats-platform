from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=5000)
    # Caller may pass a previously issued session_id for continuity.
    # The backend validates ownership before trusting it; mismatched sessions
    # receive a fresh server-generated UUID.
    session_id: str | None = Field(None, max_length=64)


class FeedbackRequest(BaseModel):
    feedback: int = Field(..., ge=-1, le=1, description="1 for positive, -1 for negative")
