import logging

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from app.db.models import EmailSuppression
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leads", tags=["leads"])


class UnsubscribeRequest(BaseModel):
    email: str


def _do_unsubscribe(email: str):
    email = email.strip().lower()
    if not email:
        return
    with get_session() as session:
        suppression = EmailSuppression(email=email, reason="unsubscribe")
        session.add(suppression)
        try:
            session.commit()
            logger.info(f"Unsubscribed email: {email}")
        except IntegrityError:
            session.rollback()
            # Already unsubscribed
            pass


@router.get("/unsubscribe")
def unsubscribe_get(email: str = Query(..., description="Email to unsubscribe")):
    """Handles direct clicks from email footers."""
    _do_unsubscribe(email)
    html_content = f"""
    <html>
        <head>
            <title>Unsubscribed</title>
            <style>
                body {{ font-family: sans-serif; text-align: center; margin-top: 50px; color: #333; }}
                h1 {{ color: #555; }}
            </style>
        </head>
        <body>
            <h1>Unsubscribed</h1>
            <p>{email} has been unsubscribed from future follow-ups.</p>
        </body>
    </html>
    """
    return HTMLResponse(content=html_content, status_code=200)


@router.post("/unsubscribe")
def unsubscribe_post(body: UnsubscribeRequest):
    """API endpoint for frontend unsubscribe forms."""
    _do_unsubscribe(body.email)
    return {"status": "success"}
