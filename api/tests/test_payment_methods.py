"""Saved-instrument mirror — synced from Razorpay, never invented locally.

Razorpay is the source of truth. The mirror exists so the UI renders without a
gateway round-trip; every rule here protects one invariant — the customer is
only ever shown an instrument that can actually be charged.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, PaymentMethod

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_TOKEN_PAGE = {
    "entity": "collection",
    "count": 2,
    "items": [
        {
            "id": "token_A",
            "method": "card",
            # Razorpay returns expiry and name; we must NOT persist either.
            "card": {
                "last4": "8950",
                "network": "Visa",
                "type": "credit",
                "issuer": "HDFC",
                "name": "Gaurav Kumar",
                "expiry_month": 12,
                "expiry_year": 2029,
            },
            "recurring": True,
        },
        {
            "id": "token_B",
            "method": "upi",
            "vpa": {"username": "gaurav", "handle": "okhdfcbank"},
            "recurring": True,
        },
    ],
}


class _FakeTokenAPI:
    def __init__(self, page):
        self.page = page
        self.deleted = []

    def all(self, customer_id):
        return self.page

    def delete(self, customer_id, token_id):
        self.deleted.append((customer_id, token_id))
        return {"deleted": True}


class _FakeClient:
    def __init__(self, page=None):
        self.token = _FakeTokenAPI(page if page is not None else _TOKEN_PAGE)


def _paying_client(db, email="pm@test.dev", customer_id="cust_1"):
    row = Client(name="PM", email=email, api_key=f"key-{email}", razorpay_customer_id=customer_id)
    db.add(row)
    db.flush()
    return row


def test_sync_mirrors_card_and_upi_tokens(db, monkeypatch):
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient())
    client = _paying_client(db)

    rows = svc.sync_payment_methods(db, client)

    assert {r.razorpay_token_id for r in rows} == {"token_A", "token_B"}
    card = next(r for r in rows if r.type == "card")
    assert (card.last4, card.network, card.issuer) == ("8950", "Visa", "HDFC")
    upi = next(r for r in rows if r.type == "upi")
    assert upi.upi_handle == "gaurav@okhdfcbank"


def test_expiry_and_cardholder_name_are_never_persisted(db, monkeypatch):
    """RBI card-on-file: last4 + network + issuer and nothing more. The token
    payload CARRIES expiry and name -- the projection must drop both."""
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient())
    svc.sync_payment_methods(db, _paying_client(db, "noexp@test.dev"))

    columns = {c.key for c in PaymentMethod.__mapper__.column_attrs}
    assert not ({"expiry_month", "expiry_year", "brand", "cardholder_name"} & columns)


def test_sync_is_idempotent(db, monkeypatch):
    from app.services import payment_method_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient())
    client = _paying_client(db, "idem-pm@test.dev", "cust_idem")

    svc.sync_payment_methods(db, client)
    rows = svc.sync_payment_methods(db, client)

    assert len(rows) == 2
    assert db.query(PaymentMethod).filter_by(client_id=client.id).count() == 2


def test_sync_prunes_tokens_deleted_at_the_gateway(db, monkeypatch):
    """Offering an instrument the gateway has revoked produces a failed payment
    the customer cannot explain."""
    from app.services import payment_method_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)
    client = _paying_client(db, "prune@test.dev", "cust_prune")
    svc.sync_payment_methods(db, client)

    fake.token.page = {"entity": "collection", "count": 1, "items": [_TOKEN_PAGE["items"][0]]}
    rows = svc.sync_payment_methods(db, client)

    assert {r.razorpay_token_id for r in rows} == {"token_A"}
    assert db.query(PaymentMethod).filter_by(client_id=client.id).count() == 1


def test_delete_removes_at_the_gateway_before_the_mirror(db, monkeypatch):
    from app.services import payment_method_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)
    client = _paying_client(db, "del@test.dev", "cust_del")
    svc.sync_payment_methods(db, client)

    svc.delete_payment_method(db, client, "token_A")

    assert fake.token.deleted == [("cust_del", "token_A")]
    assert db.query(PaymentMethod).filter_by(razorpay_token_id="token_A").count() == 0


def test_a_failed_gateway_delete_keeps_the_local_row(db, monkeypatch):
    """The list must keep reflecting what can actually be charged. Deleting
    locally first would hide an instrument that is still live."""
    from app.services import payment_method_service as svc

    class _Boom:
        token = type(
            "T",
            (),
            {
                "all": staticmethod(lambda cid: _TOKEN_PAGE),
                "delete": staticmethod(lambda cid, tid: (_ for _ in ()).throw(RuntimeError("gateway down"))),
            },
        )()

    monkeypatch.setattr(svc, "_client", lambda: _Boom())
    client = _paying_client(db, "delboom@test.dev", "cust_delboom")
    svc.sync_payment_methods(db, client)

    with pytest.raises(svc.PaymentMethodError):
        svc.delete_payment_method(db, client, "token_A")

    assert db.query(PaymentMethod).filter_by(razorpay_token_id="token_A").count() == 1


def test_client_without_a_customer_id_syncs_to_empty_without_calling_razorpay(db, monkeypatch):
    """A client that has never paid has no tokens by definition. The fake would
    raise if called, so this also proves the short-circuit."""
    from app.services import payment_method_service as svc

    class _NeverCall:
        token = type("T", (), {"all": staticmethod(lambda cid: (_ for _ in ()).throw(AssertionError("called")))})()

    monkeypatch.setattr(svc, "_client", lambda: _NeverCall())
    free = Client(name="Free", email="free-pm@test.dev", api_key="key-free-pm")
    db.add(free)
    db.flush()

    assert svc.sync_payment_methods(db, free) == []


def test_gateway_failure_raises_rather_than_reporting_an_empty_list(db, monkeypatch):
    """Reporting 'no saved cards' when we simply could not check would make the
    customer re-enter a card they already have on file."""
    from app.services import payment_method_service as svc

    class _Boom:
        token = type("T", (), {"all": staticmethod(lambda cid: (_ for _ in ()).throw(RuntimeError("down")))})()

    monkeypatch.setattr(svc, "_client", lambda: _Boom())

    with pytest.raises(svc.PaymentMethodError):
        svc.sync_payment_methods(db, _paying_client(db, "listboom@test.dev", "cust_listboom"))


# ── Staleness ────────────────────────────────────────────────────────────────


def test_an_empty_mirror_is_always_stale(db):
    """'No saved cards' and 'we have not looked yet' are indistinguishable
    locally, and only one of them is safe to show."""
    from app.services import payment_method_service as svc

    assert svc.is_stale([]) is True


def test_a_never_synced_row_is_stale(db, monkeypatch):
    from app.services import payment_method_service as svc

    client = _paying_client(db, "stale-null@test.dev", "cust_staleN")
    row = PaymentMethod(client_id=client.id, provider="razorpay", type="card", razorpay_token_id="t1")
    db.add(row)
    db.flush()

    assert svc.is_stale([row]) is True


def test_a_recently_synced_row_is_fresh(db, monkeypatch):
    from app.services import payment_method_service as svc

    client = _paying_client(db, "fresh@test.dev", "cust_fresh")
    row = PaymentMethod(
        client_id=client.id,
        provider="razorpay",
        type="card",
        razorpay_token_id="t2",
        synced_at=datetime.now(UTC),
    )
    db.add(row)
    db.flush()

    assert svc.is_stale([row]) is False


def test_the_oldest_row_decides_staleness(db):
    """One fresh row must not mask a stale sibling."""
    from app.services import payment_method_service as svc

    now = datetime.now(UTC)
    fresh = PaymentMethod(provider="razorpay", type="card", synced_at=now)
    old = PaymentMethod(provider="razorpay", type="card", synced_at=now - timedelta(hours=2))

    assert svc.is_stale([fresh, old]) is True
