from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import EmailSuppression
from app.db.session import get_session
from app.main import app


def test_unsubscribe_get(db):
    client = TestClient(app)
    response = client.get("/leads/unsubscribe?email=test%40example.com")
    assert response.status_code == 200
    assert "Unsubscribed" in response.text

    with get_session() as session:
        suppression = session.execute(
            select(EmailSuppression).where(EmailSuppression.email == "test@example.com")
        ).scalar_one_or_none()
        assert suppression is not None
        assert suppression.reason == "unsubscribe"


def test_unsubscribe_post(db):
    client = TestClient(app)
    response = client.post("/leads/unsubscribe", json={"email": "post@example.com"})
    assert response.status_code == 200
    assert response.json() == {"status": "success"}

    with get_session() as session:
        suppression = session.execute(
            select(EmailSuppression).where(EmailSuppression.email == "post@example.com")
        ).scalar_one_or_none()
        assert suppression is not None
        assert suppression.reason == "unsubscribe"
