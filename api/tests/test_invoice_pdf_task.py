"""task_render_invoice_pdfs — sweep finalized invoices, render→R2→urls (+email)."""

import asyncio
import os
from datetime import UTC, datetime

import pytest

from app import config
from app.db.models import Client, Invoice
from app.worker import tasks as worker_tasks

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def env(db, monkeypatch):
    """Wire the task to the test session, fake renderer + uploader, flags on."""
    from contextlib import contextmanager

    @contextmanager
    def _ctx():
        yield db

    uploads: list[tuple[bytes, str]] = []
    emails: list[tuple[str, str]] = []

    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)
    monkeypatch.setattr(config, "INVOICE_EMAILS_ENABLED", False)
    monkeypatch.setattr(worker_tasks, "_probe_pdf_renderer", lambda: None)
    monkeypatch.setattr(worker_tasks, "_invoice_pdf_session", _ctx)
    monkeypatch.setattr(worker_tasks, "_render_invoice_pdf", lambda inv: b"%PDF-fake-" + inv.invoice_number.encode())
    monkeypatch.setattr(
        worker_tasks,
        "_upload_invoice_pdf",
        lambda data, key: (uploads.append((data, key)), f"https://cdn.test/{key}")[1],
    )
    monkeypatch.setattr(
        worker_tasks, "_send_invoice_email", lambda to, invoice, url: emails.append((to, invoice.invoice_number))
    )
    return {"uploads": uploads, "emails": emails}


def _mk_invoice(db, email, number, **kw):
    c = Client(name="T", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    inv = Invoice(
        client_id=c.id,
        amount_cents=179900,
        currency="inr",
        status="paid",
        invoice_type=kw.pop("invoice_type", "tax_invoice"),
        invoice_number=number,
        issued_at=datetime(2026, 7, 2, tzinfo=UTC),
        buyer_snapshot={"email": f"billing-{email}"},
        **kw,
    )
    db.add(inv)
    db.flush()
    return inv


def test_renders_uploads_and_sets_urls(db, env):
    inv = _mk_invoice(db, "pdf-1@test.example", "DB/26-27/000001")
    processed = asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert processed == 1
    key = env["uploads"][0][1]
    assert inv.pdf_url == f"https://cdn.test/{key}"
    assert inv.pdf_url.startswith("https://cdn.test/invoices/26-27/")
    assert inv.invoice_url == inv.pdf_url
    # Serial slashes sanitized and an unguessable token appended (sequential
    # numbers on a public CDN must not be enumerable).
    assert "/DB-26-27-000001-" in key
    assert key.endswith(".pdf")
    assert len(key.rsplit("-", 1)[1]) >= 16 + len(".pdf") - 4  # 16-hex token


def test_skips_legacy_and_already_rendered(db, env):
    _mk_invoice(db, "pdf-2@test.example", None, invoice_type="legacy")  # unnumbered
    done = _mk_invoice(db, "pdf-3@test.example", "DB/26-27/000002", pdf_url="https://cdn.test/existing.pdf")
    processed = asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert processed == 0
    assert done.pdf_url == "https://cdn.test/existing.pdf"
    assert env["uploads"] == []


def test_noop_when_flag_disabled(db, env, monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", False)
    _mk_invoice(db, "pdf-4@test.example", "DB/26-27/000003")
    assert asyncio.run(worker_tasks.task_render_invoice_pdfs({})) == 0


def test_one_failure_does_not_block_others(db, env, monkeypatch):
    bad = _mk_invoice(db, "pdf-5@test.example", "DB/26-27/000004")
    good = _mk_invoice(db, "pdf-6@test.example", "DB/26-27/000005")
    # In production the pending rows were committed by the webhook txn long
    # before the sweep; commit here so the sweep's per-invoice rollback only
    # discards its own writes (as it does live), not the test fixtures.
    db.commit()

    def _render(inv):
        if inv.id == bad.id:
            raise RuntimeError("render boom")
        return b"%PDF-ok"

    monkeypatch.setattr(worker_tasks, "_render_invoice_pdf", _render)
    processed = asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert processed == 1
    assert good.pdf_url is not None
    assert bad.pdf_url is None  # picked up again on the next sweep


def test_email_sent_only_when_enabled(db, env, monkeypatch):
    _mk_invoice(db, "pdf-7@test.example", "DB/26-27/000006")
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert env["emails"] == []  # INVOICE_EMAILS_ENABLED off → shadow mode

    monkeypatch.setattr(config, "INVOICE_EMAILS_ENABLED", True)
    _mk_invoice(db, "pdf-8@test.example", "DB/26-27/000007")
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert env["emails"] == [("billing-pdf-8@test.example", "DB/26-27/000007")]


def test_sweep_skips_cleanly_when_renderer_unavailable(db, env, monkeypatch):
    def _no_pango():
        raise OSError("cannot load library 'libgobject-2.0-0'")

    monkeypatch.setattr(worker_tasks, "_probe_pdf_renderer", _no_pango)
    _mk_invoice(db, "pdf-probe@test.example", "DB/26-27/000009")
    # One clean skip, no per-invoice failures, nothing uploaded.
    assert asyncio.run(worker_tasks.task_render_invoice_pdfs({})) == 0
    assert env["uploads"] == []


def test_regenerated_pdf_does_not_reemail(db, env, monkeypatch):
    # B1: an admin regenerate (pdf_url cleared, emailed_at set from the first
    # delivery) must re-render WITHOUT re-emailing the customer.
    monkeypatch.setattr(config, "INVOICE_EMAILS_ENABLED", True)
    inv = _mk_invoice(db, "pdf-reemail@test.example", "DB/26-27/000011")
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert env["emails"] == [("billing-pdf-reemail@test.example", "DB/26-27/000011")]
    assert inv.emailed_at is not None

    inv.pdf_url = None  # what the regenerate endpoint does
    inv.invoice_url = None
    db.commit()
    asyncio.run(worker_tasks.task_render_invoice_pdfs({}))
    assert inv.pdf_url is not None  # re-rendered
    assert len(env["emails"]) == 1  # NOT re-emailed
