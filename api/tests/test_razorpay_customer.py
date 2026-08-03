"""Razorpay Customer identity — created once, reused, never duplicated.

The customer is the anchor every saved payment instrument hangs off. Until it
existed, ``razorpay_customer_id`` was only ever scraped passively off
subscription webhooks and was routinely NULL, which made saved cards
structurally impossible.
"""

import pytest

from app.db.models import Client


class _FakeCustomerAPI:
    def __init__(self):
        self.created = []
        self.edited = []

    def create(self, data):
        self.created.append(data)
        return {"id": f"cust_fake{len(self.created)}"}

    def edit(self, customer_id, data):
        self.edited.append((customer_id, data))
        return {"id": customer_id, **data}


class _FakeClient:
    def __init__(self):
        self.customer = _FakeCustomerAPI()


def _client_row(db, email="cust@test.dev", **fields):
    row = Client(name="Cust", email=email, api_key=f"key-{email}", **fields)
    db.add(row)
    db.flush()
    return row


def test_creates_customer_on_first_call(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, legal_name="Fynix Digital", gstin="27AAPFU0939F1ZV")
    cid = svc.ensure_customer(db, client)

    assert cid == "cust_fake1"
    assert client.razorpay_customer_id == "cust_fake1"
    payload = fake.customer.created[0]
    assert payload["name"] == "Fynix Digital"
    assert payload["email"] == "cust@test.dev"
    assert payload["gstin"] == "27AAPFU0939F1ZV"
    # fail_existing=0 → Razorpay returns the EXISTING customer instead of a 400
    # when this email was already registered (e.g. from a wiped local DB).
    assert payload["fail_existing"] == "0"


def test_is_idempotent(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "idem@test.dev")
    first = svc.ensure_customer(db, client)
    second = svc.ensure_customer(db, client)

    assert first == second
    assert len(fake.customer.created) == 1


def test_prefers_billing_email_over_the_login_email(db, monkeypatch):
    """Invoices already go to billing_email; the gateway record must match."""
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "login@test.dev", billing_email="accounts@test.dev")
    svc.ensure_customer(db, client)

    assert fake.customer.created[0]["email"] == "accounts@test.dev"


def test_falls_back_to_account_name_when_legal_name_missing(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "noname@test.dev")
    svc.ensure_customer(db, client)

    assert fake.customer.created[0]["name"] == "Cust"


def test_gstin_is_omitted_when_absent(db, monkeypatch):
    """Sending an empty GSTIN is worse than sending none — Razorpay stores it."""
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    svc.ensure_customer(db, _client_row(db, "nogst@test.dev"))

    assert "gstin" not in fake.customer.created[0]


def test_gateway_failure_raises_and_leaves_the_column_null(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    class _Boom:
        customer = type("C", (), {"create": staticmethod(lambda data: (_ for _ in ()).throw(RuntimeError("boom")))})()

    monkeypatch.setattr(svc, "_client", lambda: _Boom())

    client = _client_row(db, "boom@test.dev")
    with pytest.raises(svc.RazorpayCustomerError):
        svc.ensure_customer(db, client)
    assert client.razorpay_customer_id is None


def test_a_response_without_an_id_is_an_error_not_a_silent_none(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    class _Empty:
        customer = type("C", (), {"create": staticmethod(lambda data: {})})()

    monkeypatch.setattr(svc, "_client", lambda: _Empty())

    with pytest.raises(svc.RazorpayCustomerError):
        svc.ensure_customer(db, _client_row(db, "empty@test.dev"))


def test_detached_client_is_rejected_not_silently_dropped(db, monkeypatch):
    """The failure mode this guards against is invisible without it.

    ``get_current_client`` hands routes a DETACHED Client. Assigning
    ``razorpay_customer_id`` on a detached instance is a silent no-op — the id
    is created at Razorpay, never persisted, and re-created on every checkout.
    Tests that build their own attached rows would all pass while production
    quietly never saved a customer.
    """
    from app.services import razorpay_customer_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient())
    client = _client_row(db, "detached@test.dev")
    db.expunge(client)

    with pytest.raises(svc.RazorpayCustomerError, match="session-attached"):
        svc.ensure_customer(db, client)


def test_sync_pushes_identity_edits_to_the_gateway(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "sync@test.dev", razorpay_customer_id="cust_existing")
    client.legal_name = "New Legal Name"
    svc.sync_customer(db, client)

    assert fake.customer.edited == [("cust_existing", svc._payload(client))]


def test_sync_is_a_noop_without_a_customer_id(db, monkeypatch):
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    svc.sync_customer(db, _client_row(db, "nosync@test.dev"))

    assert fake.customer.edited == []


def test_sync_never_raises_on_a_gateway_failure(db, monkeypatch):
    """A billing-details save must not fail because Razorpay is down — the
    local row is authoritative for invoicing."""
    from app.services import razorpay_customer_service as svc

    class _Boom:
        customer = type(
            "C",
            (),
            {"edit": staticmethod(lambda cid, data: (_ for _ in ()).throw(RuntimeError("down")))},
        )()

    monkeypatch.setattr(svc, "_client", lambda: _Boom())
    client = _client_row(db, "syncboom@test.dev", razorpay_customer_id="cust_x")

    svc.sync_customer(db, client)  # must not raise
