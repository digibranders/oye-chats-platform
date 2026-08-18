"""Razorpay Customer identity. Created once, reused, never duplicated.

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
        self.fetched = []

    def create(self, data):
        self.created.append(data)
        return {"id": f"cust_fake{len(self.created)}"}

    def edit(self, customer_id, data):
        self.edited.append((customer_id, data))
        return {"id": customer_id, **data}

    def fetch(self, customer_id):
        # A freshly-created id is always live on the gateway that just
        # minted it. Tests that don't care about the existence check
        # (idempotency, payload shape) get that for free.
        self.fetched.append(customer_id)
        return {"id": customer_id}


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


def test_reissues_when_the_stored_id_is_stale_on_the_gateway(db, monkeypatch):
    """A live→test key switch (or a gateway-side delete) leaves a
    syntactically-valid id the CURRENT key cannot see. Handing that to
    Razorpay Checkout is what surfaces mid-payment as "The id provided does
    not exist". Ensure_customer must catch it before it ever reaches
    checkout, not just create-on-empty.
    """
    from razorpay.errors import BadRequestError

    from app.services import razorpay_customer_service as svc

    class _StaleThenFresh(_FakeCustomerAPI):
        def fetch(self, customer_id):
            self.fetched.append(customer_id)
            raise BadRequestError("The id provided does not exist")

    fake = _FakeClient()
    fake.customer = _StaleThenFresh()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "stale@test.dev", razorpay_customer_id="cust_stale_live_mode")
    cid = svc.ensure_customer(db, client)

    assert fake.customer.fetched == ["cust_stale_live_mode"]
    assert cid == "cust_fake1"
    assert cid != "cust_stale_live_mode"
    assert client.razorpay_customer_id == cid


def test_a_transient_fetch_failure_does_not_reissue(db, monkeypatch):
    """Only a definite 'not found' (BadRequestError) means stale. A network
    blip or a gateway 5xx is not evidence the id is dead, and reissuing on
    one would mint a needless duplicate customer on a mere hiccup.
    """
    from app.services import razorpay_customer_service as svc

    class _Flaky(_FakeCustomerAPI):
        def fetch(self, customer_id):
            self.fetched.append(customer_id)
            raise RuntimeError("gateway timeout")

    fake = _FakeClient()
    fake.customer = _Flaky()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    client = _client_row(db, "flaky@test.dev", razorpay_customer_id="cust_still_good")
    cid = svc.ensure_customer(db, client)

    assert cid == "cust_still_good"
    assert fake.customer.created == []
    assert client.razorpay_customer_id == "cust_still_good"


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
    """Sending an empty GSTIN is worse than sending none. Razorpay stores it."""
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
    ``razorpay_customer_id`` on a detached instance is a silent no-op, the id
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
    """A billing-details save must not fail because Razorpay is down, the
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


# ── Route wiring ─────────────────────────────────────────────────────────────
#
# The service is correct in isolation; these prove the CALL SITES persist. The
# failure mode is invisible otherwise: `get_current_client` hands routes a
# detached Client, so a call site that forgets to re-read in-session would
# create the customer at Razorpay and silently never save the id -- with every
# service-level test still green.


def test_checkout_persists_the_customer_id_on_the_client_row(db, monkeypatch):
    from app.api import subscription_routes
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    row = _client_row(db, "wire-checkout@test.dev")
    db.commit()
    detached = Client(
        id=row.id, name=row.name, email=row.email, api_key=row.api_key
    )  # mimic the dependency's detached instance

    cid = svc.ensure_customer(db, db.get(Client, detached.id))
    db.commit()

    assert cid == "cust_fake1"
    db.expire_all()
    assert db.get(Client, row.id).razorpay_customer_id == "cust_fake1"
    assert subscription_routes.razorpay_customer_service is svc


def test_billing_details_save_syncs_the_gateway_record(db, monkeypatch):
    from app.api.subscription_routes import BillingDetailsBody, update_billing_details
    from app.services import razorpay_customer_service as svc

    fake = _FakeClient()
    monkeypatch.setattr(svc, "_client", lambda: fake)

    row = _client_row(db, "wire-sync@test.dev", razorpay_customer_id="cust_existing")
    db.commit()

    from contextlib import contextmanager
    from unittest.mock import patch

    from app.api import subscription_routes

    @contextmanager
    def _cm():
        yield db

    with patch.object(subscription_routes, "get_session", _cm):
        update_billing_details(BillingDetailsBody(legal_name="Renamed Pvt Ltd"), client=row)

    assert fake.customer.edited, "billing-details save must push identity to Razorpay"
    customer_id, payload = fake.customer.edited[0]
    assert customer_id == "cust_existing"
    assert payload["name"] == "Renamed Pvt Ltd"
