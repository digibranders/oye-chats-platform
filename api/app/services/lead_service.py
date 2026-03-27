"""Lead scoring and qualification service."""

from app.db.models import ChatSession, LeadInfo


def calculate_lead_score(session: ChatSession) -> int:
    """Calculate lead score (0-100) based on BANT completion."""
    score = 0
    if session.bant_need:
        score += 30
    if session.bant_budget:
        score += 25
    if session.bant_authority:
        score += 25
    if session.bant_timeline:
        score += 20
    return score


def get_lead_status(score: int) -> str:
    """Classify lead by score: cold, warm, hot, or qualified."""
    if score == 100:
        return "qualified"
    if score >= 50:
        return "hot"
    if score >= 25:
        return "warm"
    return "cold"


def build_lead_response(session: ChatSession, lead_info: LeadInfo | None, message_count: int = 0) -> dict:
    """Build a standardized lead response dict."""
    score = calculate_lead_score(session)
    return {
        "session_id": session.id,
        "score": score,
        "status": get_lead_status(score),
        "bant": {
            "need": session.bant_need,
            "budget": session.bant_budget,
            "authority": session.bant_authority,
            "timeline": session.bant_timeline,
        },
        "contact": {
            "name": lead_info.name if lead_info else None,
            "email": lead_info.email if lead_info else None,
            "phone": lead_info.phone if lead_info else None,
            "company": lead_info.company if lead_info else None,
        } if lead_info else None,
        "location": session.location or "Unknown",
        "device": session.device or "Unknown",
        "chats": message_count,
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "last_active_at": session.last_active_at.isoformat() if session.last_active_at else (
            session.created_at.isoformat() if session.created_at else None
        ),
    }
