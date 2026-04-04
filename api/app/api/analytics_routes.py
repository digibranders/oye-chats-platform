import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.auth import get_current_client_or_operator
from app.db.repository import (
    get_dashboard_stats,
    get_feedback_data,
    get_message_activity,
    get_ratings_summary,
    get_top_questions,
    get_visitor_data,
)
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/dashboard")
def get_dashboard_analytics_endpoint(
    bot_id: int | None = Query(None),
    days: int | None = Query(None, ge=1, le=365, description="Restrict stats to the last N days"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve live aggregate statistics for the admin dashboard."""
    try:
        with get_session() as session:
            stats = get_dashboard_stats(session, client_id=auth["client_id"], bot_id=bot_id, days=days)
            return stats
    except Exception as e:
        logger.error(f"Failed to fetch dashboard stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard statistics.") from e


@router.get("/activity")
def get_activity_analytics_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve message activity over time for charts."""
    try:
        with get_session() as session:
            activity = get_message_activity(session, client_id=auth["client_id"], bot_id=bot_id)
            return activity
    except Exception as e:
        logger.error(f"Failed to fetch activity stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to load activity data.") from e


@router.get("/top-questions")
def get_top_questions_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve the most common user queries."""
    try:
        with get_session() as session:
            top_questions = get_top_questions(session, client_id=auth["client_id"], bot_id=bot_id)
            return top_questions
    except Exception as e:
        logger.error(f"Failed to fetch top questions: {e}")
        raise HTTPException(status_code=500, detail="Failed to load top questions.") from e


@router.get("/visitors")
def get_visitors_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve all visitor sessions for the admin dashboard."""
    try:
        with get_session() as session:
            data = get_visitor_data(session, client_id=auth["client_id"], bot_id=bot_id)

            unique_visitors = {}
            current_user_index = 1

            for item in data:
                raw_loc = item.get("location", "") or "Unknown"
                ip_part = raw_loc
                display_loc = raw_loc
                if " | " in raw_loc:
                    display_loc, ip_part = raw_loc.split(" | ", 1)
                elif raw_loc.startswith("IP: "):
                    ip_part = raw_loc
                    display_loc = "Unknown"

                fingerprint = f"{ip_part}--{item.get('device', '')}"

                if fingerprint not in unique_visitors:
                    item["visitor"] = f"user{current_user_index}"
                    current_user_index += 1
                    item["all_session_ids"] = [item.get("session_id")]
                    item["location"] = display_loc
                    unique_visitors[fingerprint] = item
                else:
                    existing = unique_visitors[fingerprint]
                    existing["chats"] += item.get("chats", 0)
                    existing["all_session_ids"].append(item.get("session_id"))
                    if (
                        item.get("last_active_at")
                        and existing.get("last_active_at")
                        and item["last_active_at"] > existing["last_active_at"]
                    ):
                        existing["last_active_at"] = item["last_active_at"]

            result_list = list(unique_visitors.values())
            for user in result_list:
                user["session_id"] = ",".join(user["all_session_ids"])

            return sorted(result_list, key=lambda x: x["last_active_at"], reverse=True)

    except Exception as e:
        logger.error(f"Failed to fetch visitors: {e}")
        raise HTTPException(status_code=500, detail="Failed to load visitor data.") from e


@router.get("/ratings-summary")
def get_ratings_summary_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve post-chat visitor rating summary (avg, total, distribution)."""
    try:
        with get_session() as session:
            return get_ratings_summary(session, client_id=auth["client_id"], bot_id=bot_id)
    except Exception as e:
        logger.error(f"Failed to fetch ratings summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to load ratings summary.") from e


@router.get("/feedback")
def get_feedback_endpoint(
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Retrieve all feedback for the admin dashboard."""
    try:
        with get_session() as session:
            data = get_feedback_data(session, client_id=auth["client_id"], bot_id=bot_id)

            session_to_user_map = {}
            current_user_index = 1

            for item in data:
                sid = item["session_id"]
                if sid not in session_to_user_map:
                    session_to_user_map[sid] = f"User -{current_user_index}"
                    current_user_index += 1

                item["user"] = session_to_user_map[sid]
                del item["session_id"]

            return sorted(data, key=lambda x: x["created_at"], reverse=True)

    except Exception as e:
        logger.error(f"Failed to fetch feedback logs: {e}")
        raise HTTPException(status_code=500, detail="Failed to load feedback data.") from e
