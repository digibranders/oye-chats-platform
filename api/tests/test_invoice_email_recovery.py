"""Invoice-email recovery + visibility for rendered-but-unmailed documents (audit F43).

An email failure after a successful PDF render used to be permanently
unrecoverable: the sweep only selects ``pdf_url IS NULL``, so a rendered
invoice with ``emailed_at IS NULL`` was never retried, and
``reconciliation_anomalies`` had no check for it, the customer silently never
received their tax invoice. Two fixes under test here:

* ``task_render_invoice_pdfs`` gains a recovery pass that re-attempts delivery
  for numbered documents with a PDF but no ``emailed_at``.
* ``reconciliation_anomalies`` gains an ``emails_pending`` list so a
  persistently failing delivery shows up in the daily error-level alert.
"""

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

from app import config
from app.db.models import Client, Invoice
from app.services import invoice_reports
from app.worker import tasks as worker_tasks

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def env(db, monkeypatch):
    """Wire the task to the test session, fake renderer + uploader, emails ON."""
    from contextlib import contextmanager

    @contextmanager
    def _ctx():
        yield db

    emails: list[tuple[str, str, bytes | None]] = []

    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    monkeypatch.setattr(config, "INVOICE_EMAILS_ENABLED", True)
    monkeypatch.setattr(worker_tasks, "_probe_pdf_renderer", lambda: None)
    monkeypatch.setattr(worker_tasks, "_invoice_pdf_session", _ctx)
    monkeypatch.setattr(worker_tasks, "_render_invoice_pdf", lambda inv: b"%PDF-fake-" + inv.invoice_number.encode())
    monkeypatch.setattr(worker_tasks, "_upload_invoice_pdf", lambda data, key: f"https://cdn.test/{key}")
    monkeypatch.setattr(
        worker_tasks,
        "_send_invoice_email",
        lambda to, invoice, url, pdf_bytes=None: emails.append((to, invoice.invoice_number, pdf_bytes)),
    )
    return {"emails": emails}


def _mk_rendered_unmailed(db, email, number, *, issued_ago=timedelta(0), buyer_email=True):
    """A numbered invoice whose PDF rendered fine but whose email never went out
    , exactly the state a post-render email failure leaves behind in prod."""
    c = Client(name="T", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    inv = Invoice(
        client_id=c.id,
        amount_cents=179900,
        currency="inr",
        status="paid",
        invoice_type="tax_invoice",
        invoice_number=number,
        issued_at=datetime.now(UTC) - issued_ago,
        pdf_url=f"https://cdn.test/invoices/26-27/{number.replace('/', '-')}-deadbeef.pdf",
        invoice_url=f"https://cdn.test/invoices/26-27/{number.replace('/', '-')}-deadbeef.pdf",
        emailed_at=None,
        buyer_snapshot={"email": f"billing-{email}"} if buyer_email else {"name": "No Email Co"},
    )
    db.add(inv)
    db.flush()
    return inv


# ── sweep recovery pass ───────────────────────────────────────────────────────


def test_sweep_recovers_rendered_but_unmailed_invoice(db, env):
    inv = _mk_rendered_unmailed(db, "rec-1@test.example", "DB/26-27/000101")
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert env["emails"] == [("billing-rec-1@test.example", "DB/26-27/000101", b"%PDF-fake-DB/26-27/000101")]
    assert inv.emailed_at is not None


def test_recovery_skipped_in_shadow_mode(db, env, monkeypatch):
    monkeypatch.setattr(config, "INVOICE_EMAILS_ENABLED", False)
    inv = _mk_rendered_unmailed(db, "rec-2@test.example", "DB/26-27/000102")
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert env["emails"] == []
    assert inv.emailed_at is None


def test_recovery_failure_leaves_invoice_pending_for_next_sweep(db, env, monkeypatch):
    inv = _mk_rendered_unmailed(db, "rec-3@test.example", "DB/26-27/000103")
    db.commit()  # prod rows were committed long before the sweep

    def _boom(to, invoice, url, pdf_bytes=None):
        raise ConnectionError("brevo down")

    monkeypatch.setattr(worker_tasks, "_send_invoice_email", _boom)
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))  # must not raise
    assert inv.emailed_at is None  # still pending → retried next sweep


def test_recovery_ignores_invoices_without_buyer_email(db, env):
    # A snapshot with no email can never be delivered, it must not occupy the
    # recovery batch (starving real recoverable rows) or be marked emailed.
    no_email = _mk_rendered_unmailed(db, "rec-4@test.example", "DB/26-27/000104", buyer_email=False)
    ok = _mk_rendered_unmailed(db, "rec-5@test.example", "DB/26-27/000105")
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert [e[1] for e in env["emails"]] == ["DB/26-27/000105"]
    assert no_email.emailed_at is None
    assert ok.emailed_at is not None


def test_recovery_does_not_touch_already_emailed(db, env):
    inv = _mk_rendered_unmailed(db, "rec-6@test.example", "DB/26-27/000106")
    inv.emailed_at = datetime.now(UTC)
    db.flush()
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert env["emails"] == []


# ── reconciliation visibility ─────────────────────────────────────────────────


def test_emails_pending_anomaly_lists_stuck_deliveries(db, env):
    stuck = _mk_rendered_unmailed(db, "rec-7@test.example", "DB/26-27/000107", issued_ago=timedelta(hours=2))
    _mk_rendered_unmailed(db, "rec-8@test.example", "DB/26-27/000108")  # fresh. Sweep hasn't had its chance yet
    anomalies = invoice_reports.reconciliation_anomalies(db)
    assert [r["id"] for r in anomalies["emails_pending"]] == [stuck.id]


def test_emails_pending_empty_in_shadow_mode(db, env, monkeypatch):
    # Shadow mode never emails, so unmailed documents are expected, not anomalous.
    monkeypatch.setattr(config, "INVOICE_EMAILS_ENABLED", False)
    _mk_rendered_unmailed(db, "rec-9@test.example", "DB/26-27/000109", issued_ago=timedelta(hours=2))
    anomalies = invoice_reports.reconciliation_anomalies(db)
    assert anomalies["emails_pending"] == []


def test_stale_claim_from_crashed_worker_is_reswept(db, env):
    # A worker that crashed between claim-commit and send (deploys restart the
    # worker) leaves email_claimed_at set with emailed_at NULL. The claim must
    # go stale (>1h) and the invoice must be re-swept, the first M-5 cut
    # claimed via emailed_at itself and lost the document forever.
    inv = _mk_rendered_unmailed(db, "stale-claim@test.example", "INV/25-26/9001")
    inv.email_claimed_at = datetime.now(UTC) - timedelta(hours=2)
    db.commit()

    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    db.refresh(inv)
    assert inv.emailed_at is not None  # delivered
    assert inv.email_claimed_at is None
    assert [number for _to, number, _pdf in env["emails"]] == ["INV/25-26/9001"]


def test_fresh_claim_is_left_for_the_owning_sweep(db, env):
    # A LIVE claim belongs to a concurrent sweep. This run must not
    # double-send.
    inv = _mk_rendered_unmailed(db, "fresh-claim@test.example", "INV/25-26/9002")
    inv.email_claimed_at = datetime.now(UTC) - timedelta(minutes=5)
    db.commit()

    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    db.refresh(inv)
    assert inv.emailed_at is None
    assert env["emails"] == []


def test_delivery_stamps_emailed_at_only_after_send_returns(db, env, monkeypatch):
    # emailed_at means DELIVERED again: a send that raises must leave it NULL
    # (visible to the emails_pending alert) with only the claim released.
    inv = _mk_rendered_unmailed(db, "post-send@test.example", "INV/25-26/9003")
    db.commit()

    def _boom(to, invoice, url, pdf_bytes=None):
        raise RuntimeError("brevo down")

    monkeypatch.setattr(worker_tasks, "_send_invoice_email", _boom)
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    db.refresh(inv)
    assert inv.emailed_at is None
    assert inv.email_claimed_at is None  # released for the next sweep
