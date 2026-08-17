"""Public unsubscribe endpoint. No auth — reached via a signed link in a
follow-up email, not the widget/API-key flow used elsewhere.

The token is HMAC-signed (see ``app/services/unsubscribe_token.py``) so a
bare ``email`` query param can't be used to suppress an arbitrary address
for any bot.
"""

import html
import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.exc import IntegrityError

from app.db.models import EmailSuppression
from app.db.session import get_session
from app.schemas.validators import MAX_TOKEN
from app.services.unsubscribe_token import verify_unsubscribe_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/leads", tags=["leads"])


def _do_unsubscribe(bot_id: int, email: str, reason: str = "unsubscribe") -> None:
    email = email.strip().lower()
    with get_session() as session:
        existing = (
            session.query(EmailSuppression)
            .filter(EmailSuppression.bot_id == bot_id, EmailSuppression.email == email)
            .first()
        )
        if existing:
            return
        try:
            session.add(EmailSuppression(bot_id=bot_id, email=email, reason=reason))
            session.commit()
            logger.info(f"Unsubscribed | bot={bot_id} | email={email[:3]}***")
        except IntegrityError:
            session.rollback()  # race: another request inserted it first — fine, already suppressed


@router.get("/unsubscribe")
def unsubscribe_get(
    token: str = Query(..., max_length=MAX_TOKEN, description="Signed unsubscribe token from the email link"),
):
    """Handles direct clicks from email footers."""
    decoded = verify_unsubscribe_token(token)
    if decoded is None:
        raise HTTPException(status_code=400, detail="This unsubscribe link is invalid or has expired.")

    bot_id, email = decoded
    _do_unsubscribe(bot_id, email)

    # The address arrives inside an HMAC-signed token, so it is ours — but it
    # originated as visitor-supplied lead data, and this is the one place the
    # platform renders it straight back into a document. Escaping costs
    # nothing and removes the question.
    escaped_email = html.escape(email)
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
            <p>{escaped_email} has been unsubscribed from future follow-ups.</p>
        </body>
    </html>
    """
    return HTMLResponse(content=html_content, status_code=200)


@router.post("/unsubscribe")
def unsubscribe_post(
    token: str = Query(..., max_length=MAX_TOKEN, description="Signed unsubscribe token from the email link"),
):
    """API endpoint for a JS-driven unsubscribe confirmation button."""
    decoded = verify_unsubscribe_token(token)
    if decoded is None:
        raise HTTPException(status_code=400, detail="This unsubscribe link is invalid or has expired.")

    bot_id, email = decoded
    _do_unsubscribe(bot_id, email)
    return {"status": "success"}
