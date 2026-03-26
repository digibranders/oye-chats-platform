from typing import Optional
from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=5000)
    session_id: Optional[str] = None


class FeedbackRequest(BaseModel):
    feedback: int = Field(..., ge=-1, le=1, description="1 for positive, -1 for negative")
