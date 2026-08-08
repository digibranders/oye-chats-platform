from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import Bot, Client, EmailSuppression
from app.db.session import get_session
from app.main import app
from app.services.unsubscribe_token import make_unsubscribe_token


def _make_bot(db, suffix: str) -> Bot:
    client = Client(name=f"c-{suffix}", email=f"{suffix}@example.com", api_key=f"key-{suffix}", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=f"bot-{suffix}", name=f"Bot {suffix}", is_legacy_pooled=False)
    db.add(bot)
    db.flush()
    return bot


def test_unsubscribe_get_with_valid_token(db):
    bot = _make_bot(db, "u1")
    db.commit()
    token = make_unsubscribe_token(bot.id, "test@example.com")

    tc = TestClient(app)
    response = tc.get(f"/leads/unsubscribe?token={token}")

    assert response.status_code == 200
    assert "Unsubscribed" in response.text

    with get_session() as session:
        suppression = session.execute(
            select(EmailSuppression).where(
                EmailSuppression.bot_id == bot.id, EmailSuppression.email == "test@example.com"
            )
        ).scalar_one_or_none()
        assert suppression is not None
        assert suppression.reason == "unsubscribe"


def test_unsubscribe_post_with_valid_token(db):
    bot = _make_bot(db, "u2")
    db.commit()
    token = make_unsubscribe_token(bot.id, "post@example.com")

    tc = TestClient(app)
    response = tc.post(f"/leads/unsubscribe?token={token}")

    assert response.status_code == 200
    assert response.json() == {"status": "success"}


def test_unsubscribe_rejects_invalid_token(db):
    tc = TestClient(app)
    response = tc.get("/leads/unsubscribe?token=not-a-real-token")
    assert response.status_code == 400


def test_unsubscribe_rejects_tampered_token(db):
    bot = _make_bot(db, "u3")
    db.commit()
    token = make_unsubscribe_token(bot.id, "victim@example.com")
    tampered = token[:-2] + "xx"  # flip the trailing signature bytes

    tc = TestClient(app)
    response = tc.get(f"/leads/unsubscribe?token={tampered}")
    assert response.status_code == 400

    with get_session() as session:
        suppression = session.execute(
            select(EmailSuppression).where(EmailSuppression.email == "victim@example.com")
        ).scalar_one_or_none()
        assert suppression is None


def test_unsubscribe_is_scoped_per_bot_not_global(db):
    """The exact bug this rewrite fixes: unsubscribing from one bot's
    follow-ups must never suppress that address for an unrelated bot."""
    bot_a = _make_bot(db, "tenant-a")
    bot_b = _make_bot(db, "tenant-b")
    db.commit()

    token_a = make_unsubscribe_token(bot_a.id, "shared@example.com")
    tc = TestClient(app)
    tc.get(f"/leads/unsubscribe?token={token_a}")

    with get_session() as session:
        suppressed_on_a = session.execute(
            select(EmailSuppression).where(
                EmailSuppression.bot_id == bot_a.id, EmailSuppression.email == "shared@example.com"
            )
        ).scalar_one_or_none()
        suppressed_on_b = session.execute(
            select(EmailSuppression).where(
                EmailSuppression.bot_id == bot_b.id, EmailSuppression.email == "shared@example.com"
            )
        ).scalar_one_or_none()

    assert suppressed_on_a is not None
    assert suppressed_on_b is None
