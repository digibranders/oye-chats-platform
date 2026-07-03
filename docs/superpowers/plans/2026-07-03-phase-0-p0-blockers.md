# Phase 0 — P0 Launch Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Parent program: `2026-07-03-production-readiness-master.md`.

**Goal:** Close the three P0 blockers — cross-tenant knowledge-base contamination (P0-2), seat-change overcharge (P0-3), and the spoofable rate-limit trust boundary (P0-1) — so no launch can leak tenant data, overcharge customers, or run with a nullified auth throttle.

**Architecture:** Three independent tasks. Task 1 (P0-2) namespaces upload storage per tenant so a folder sweep can never cross tenants. Task 2 (P0-3) routes seat deltas through a separate Razorpay add-on subscription and wires its webhook. Task 3 (P0-1) fixes the reverse-proxy trust chain (nginx real-IP from Cloudflare ranges + ufw ingress) and the app-layer proxy-header trust.

**Tech Stack:** FastAPI · SQLAlchemy · ARQ worker · Razorpay · nginx · gunicorn/uvicorn · ufw · pytest (real Postgres + mocked-session unit tests).

**Order:** Task 1 → Task 2 → Task 3 (P0-2 is highest trust risk; P0-1 ends with an ops step on the droplet). Tasks 1 and 2 are code-only and independently testable; do them first so CI is green before the infra change.

---

## Task 1 · P0-2 — Namespace upload storage per tenant

**Root cause (verified):** `DOCUMENTS_DIR = "documents"` (`config.py:389`) is a single global folder. Uploads are written as `base_dir / filename` (`document_routes.py:330-332`), ingestion is enqueued against the whole shared dir (`:387-389`), and `run_folder_ingestion` sweeps the entire folder via `os.listdir` (`pipeline.py:230`), attributing **every** file to the caller's `client_id`/`bot_id`. It also archives other tenants' pending files (NB-7). Delete unlinks by filename in the shared dir (`:146-151`).

**Fix strategy:** Introduce a helper that returns a per-tenant directory `documents/{client_id}/{bot_id}/` (bot `_none` when `bot_id is None`), write uploads there, enqueue ingestion against **that scoped path**, and scope the delete unlink to the same path. `run_folder_ingestion` needs no logic change — once it is handed a tenant-scoped folder, its sweep and archive are naturally isolated.

**Files:**
- Modify: `api/app/api/document_routes.py` (upload write `:330-341`, ingestion enqueue `:383-389`, background fn `:168-174`, delete unlink `:146-152`)
- Modify: `api/app/ingestion/pipeline.py` (`run_folder_ingestion` — accept the scoped path as-is; add a guard that the path exists)
- Modify: `api/app/worker/tasks.py` (`task_ingest_documents:18-37` — folder_path is now the scoped path; no signature change needed, but update the log/docstring)
- Create: helper `_tenant_documents_dir(client_id, bot_id)` in `api/app/api/document_routes.py`
- Test: `api/tests/test_document_routes.py` (extend), `api/tests/test_ingestion_tenant_isolation.py` (new, real-DB optional/mock)

- [ ] **Step 1: Write the failing unit test for the tenant-dir helper**

Add to `api/tests/test_document_routes.py`:

```python
class TestTenantDocumentsDir:
    def test_scopes_path_by_client_and_bot(self, tmp_path, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "DOCUMENTS_DIR", str(tmp_path))
        p = document_routes._tenant_documents_dir(client_id=7, bot_id=42)
        assert p == (tmp_path / "7" / "42").resolve()
        assert p.is_dir()  # helper must create it

    def test_bot_none_uses_sentinel_segment(self, tmp_path, monkeypatch):
        from app.api import document_routes

        monkeypatch.setattr(document_routes, "DOCUMENTS_DIR", str(tmp_path))
        p = document_routes._tenant_documents_dir(client_id=7, bot_id=None)
        assert p == (tmp_path / "7" / "_none").resolve()
        assert p.is_dir()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_document_routes.py::TestTenantDocumentsDir -v`
Expected: FAIL — `AttributeError: module 'app.api.document_routes' has no attribute '_tenant_documents_dir'`.

- [ ] **Step 3: Implement the helper**

In `api/app/api/document_routes.py`, add after `_verify_bot_ownership` (~line 72):

```python
def _tenant_documents_dir(client_id: int, bot_id: int | None) -> Path:
    """Per-tenant upload directory: ``documents/{client_id}/{bot_id}/``.

    Namespacing by tenant is a security boundary, not an optimization:
    ``run_folder_ingestion`` sweeps whichever folder it is handed, so a
    shared folder let the first job to run ingest (and archive) every
    tenant's pending files. A per-tenant path makes that sweep isolated
    by construction. ``bot_id is None`` (account-level uploads) uses a
    reserved ``_none`` segment so it can never collide with a real bot id.
    """
    base_dir = Path(DOCUMENTS_DIR).resolve()
    bot_segment = str(bot_id) if bot_id is not None else "_none"
    tenant_dir = (base_dir / str(client_id) / bot_segment).resolve()
    if not tenant_dir.is_relative_to(base_dir):
        raise HTTPException(status_code=400, detail="Invalid storage path.")
    tenant_dir.mkdir(parents=True, exist_ok=True)
    return tenant_dir
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd api && uv run pytest tests/test_document_routes.py::TestTenantDocumentsDir -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Point the upload write at the tenant dir**

In `ingest_documents`, replace the Phase-2 write block (`document_routes.py:330-332`):

```python
    # ── Phase 2: All files validated + credits secured — write to disk ──
    base_dir = Path(DOCUMENTS_DIR).resolve()
    for filename, content in file_buffers:
        file_path = (base_dir / filename).resolve()
```

with:

```python
    # ── Phase 2: All files validated + credits secured — write to disk ──
    # Write into the caller's OWN namespaced folder so the ingestion sweep
    # can never see another tenant's files (P0-2).
    tenant_dir = _tenant_documents_dir(client_id, bot_id)
    for filename, content in file_buffers:
        file_path = (tenant_dir / filename).resolve()
        if not file_path.is_relative_to(tenant_dir):
```

(Update the `is_relative_to(base_dir)` check on the next line to `is_relative_to(tenant_dir)`.)

- [ ] **Step 6: Enqueue ingestion against the scoped path, not `DOCUMENTS_DIR`**

Replace the enqueue block (`document_routes.py:383-389`):

```python
    job_id = None
    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        job_id = enqueue_sync("task_ingest_documents", client_id, str(tenant_dir), bot_id)
    else:
        background_tasks.add_task(_run_ingestion_background, client_id, str(tenant_dir), bot_id)
```

- [ ] **Step 7: Scope the delete-time unlink to the tenant dir**

Replace the unlink block in `delete_document_endpoint` (`document_routes.py:146-151`):

```python
            tenant_dir = _tenant_documents_dir(client_id, bot_id)
            file_path = (tenant_dir / document_name).resolve()
            if not file_path.is_relative_to(tenant_dir):
                raise HTTPException(status_code=403, detail="Invalid document path.")
            if file_path.exists():
                file_path.unlink()
                logger.info(f"Deleted file from disk: {file_path}")
```

- [ ] **Step 8: Add an existence guard to `run_folder_ingestion`**

In `api/app/ingestion/pipeline.py`, at the top of `run_folder_ingestion` (after the docstring, ~line 229):

```python
    if not os.path.isdir(folder_path):
        logger.info("run_folder_ingestion: folder %s does not exist — nothing to ingest", folder_path)
        return 0
    supported_extensions = [".pdf", ".docx", ".txt", ".md"]
```

- [ ] **Step 9: Write the tenant-isolation regression test**

Create `api/tests/test_ingestion_tenant_isolation.py`:

```python
"""P0-2 regression: an ingestion job must only ever see its own tenant's files.

Prod incident modeled: Client A uploads pricing.pdf; before A's job runs,
Client B uploads secret.pdf. With a shared folder, A's job ingested BOTH.
With per-tenant namespacing, A's job sees only A's file.
"""

from pathlib import Path
from unittest.mock import patch

from app.api import document_routes
from app.ingestion import pipeline


def test_folder_ingestion_is_scoped_to_tenant_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(document_routes, "DOCUMENTS_DIR", str(tmp_path))

    dir_a = document_routes._tenant_documents_dir(client_id=1, bot_id=10)
    dir_b = document_routes._tenant_documents_dir(client_id=2, bot_id=20)
    (dir_a / "pricing.pdf").write_bytes(b"A-owned")
    (dir_b / "secret.pdf").write_bytes(b"B-owned")

    seen: list[str] = []

    def _fake_ingest(client_id, file_name, *a, **kw):
        seen.append(file_name)
        return 1

    # Only exercise the sweep + attribution boundary; skip real extraction.
    monkeypatch.setattr(pipeline, "_ingest_document", _fake_ingest)
    monkeypatch.setattr(pipeline, "load_pdf", lambda p: [{"text": "x", "page": 1}])
    monkeypatch.setattr(pipeline, "move_to_archive", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "move_to_quarantine", lambda *a, **k: None)

    pipeline.run_folder_ingestion(client_id=1, folder_path=str(dir_a), bot_id=10)

    assert seen == ["pricing.pdf"]  # B's secret.pdf must NOT appear
    assert "secret.pdf" not in seen


def test_missing_tenant_dir_returns_zero(tmp_path):
    assert pipeline.run_folder_ingestion(1, str(tmp_path / "nope"), bot_id=1) == 0
```

- [ ] **Step 10: Run the isolation tests**

Run: `cd api && uv run pytest tests/test_ingestion_tenant_isolation.py -v`
Expected: PASS (2 passed). If `load_pdf`/`move_to_archive` names differ, align the monkeypatch targets with `pipeline.py` imports.

- [ ] **Step 11: Update the worker task docstring/log**

In `api/app/worker/tasks.py:18-37`, update the docstring to note `folder_path` is now a per-tenant scoped path and the log line already prints it. No signature change.

- [ ] **Step 12: Run the full document + ingestion suite + lint**

Run: `cd api && uv run pytest tests/test_document_routes.py tests/test_ingestion_tenant_isolation.py -v && uv run ruff check app/api/document_routes.py app/ingestion/pipeline.py app/worker/tasks.py && uv run ruff format app/api/document_routes.py app/ingestion/pipeline.py`
Expected: all green, no lint errors.

- [ ] **Step 13: Note the one-time migration of existing files (ops)**

Add a short note to the PR description: existing files under `documents/*.ext` (flat) must be migrated into `documents/{client_id}/{bot_id}/` on the droplet, or left to re-ingest. Because ingested content already lives in Postgres, the safe path is: stop the worker, move any un-ingested flat files to quarantine for manual review, deploy. Document in `docs/` runbook.

- [ ] **Step 14: Commit**

```bash
cd /Users/a12345/Desktop/AI/OyeChats/oye-chats-platform
git add api/app/api/document_routes.py api/app/ingestion/pipeline.py api/app/worker/tasks.py api/tests/test_document_routes.py api/tests/test_ingestion_tenant_isolation.py
git commit -m "fix(ingestion): namespace uploads per tenant to stop cross-tenant KB contamination (P0-2)"
```

**Acceptance criteria:**
- Uploads land under `documents/{client_id}/{bot_id}/`; ingestion + delete operate only within that path.
- `test_folder_ingestion_is_scoped_to_tenant_dir` proves tenant B's file is never seen by tenant A's job.
- No behavior change for a single tenant's happy path (existing `test_document_routes.py` still green).

---

## Task 2 · P0-3 — Route seat changes through a separate add-on subscription

**Root cause (verified):** `POST /subscriptions/seats` → `change_seat_count` (`subscription_routes.py:1157-1209`) calls `update_subscription_quantity` (`razorpay_service.py:688-712`) which does `rzp.subscription.edit(quantity=N)` on the **main plan** sub — multiplying the whole plan amount. The correct function `create_seat_addon_subscription` (`razorpay_service.py:504-533`, uses `RAZORPAY_SEAT_PLAN_ID` whose amount IS the ₹499 per-seat price) has zero production callers.

**Fix strategy:** `change_seat_count` must operate on a **seat add-on subscription** distinct from the main plan. Adding seats creates/edits the add-on's quantity; removing seats edits it down (or cancels it at zero extra). The main plan's quantity is never touched. Wire the add-on's `subscription.activated`/`subscription.charged` webhook (notes carry `purpose=seat_addon`) so it doesn't dead-letter. Store the add-on subscription id on the client/subscription so subsequent deltas find it.

**Files:**
- Modify: `api/app/api/subscription_routes.py` (`change_seat_count:1157-1209`)
- Modify: `api/app/services/razorpay_service.py` (add `edit_seat_addon_quantity`/`cancel_seat_addon`; keep `create_seat_addon_subscription`)
- Modify: `api/app/api/webhook_billing_routes.py` (handle `purpose=seat_addon` in activated/charged)
- Modify: `api/app/db/models.py` (add `seat_addon_subscription_id` if not present) + new alembic migration
- Test: `api/tests/test_subscription_seats.py` (extend), `api/tests/test_webhook_billing_routes.py` (extend)

- [ ] **Step 1: Confirm the storage column and the add-on helpers that exist**

Run: `cd api && grep -n "seat_addon\|RAZORPAY_SEAT_PLAN_ID\|operator_quantity\|seat_addon_subscription_id" app/db/models.py app/services/razorpay_service.py app/config.py`
Expected: `create_seat_addon_subscription` exists; note whether a `seat_addon_subscription_id` column already exists on `Subscription`/`Client`. If absent, it is added in Step 2.

- [ ] **Step 2: Add the storage column + migration (only if Step 1 shows it is missing)**

In `api/app/db/models.py`, on the `Subscription` model, add:

```python
    # Razorpay id of the SEPARATE ₹499×N operator-seat add-on subscription.
    # Kept distinct from razorpay_subscription_id because Razorpay quantity
    # multiplies the whole plan amount — seats must be their own sub (P0-3).
    seat_addon_subscription_id = Column(String, nullable=True)
    seat_addon_quantity = Column(Integer, nullable=False, server_default="0")
```

Create the migration:

Run: `cd api && uv run alembic revision -m "add seat_addon subscription fields (P0-3)"`
Then fill the generated file's `upgrade()`:

```python
def upgrade() -> None:
    op.add_column("subscriptions", sa.Column("seat_addon_subscription_id", sa.String(), nullable=True))
    op.add_column("subscriptions", sa.Column("seat_addon_quantity", sa.Integer(), server_default="0", nullable=False))


def downgrade() -> None:
    op.drop_column("subscriptions", "seat_addon_quantity")
    op.drop_column("subscriptions", "seat_addon_subscription_id")
```

- [ ] **Step 3: Write the failing test — seats must NOT edit the main plan quantity**

In `api/tests/test_subscription_seats.py` add:

```python
def test_add_seat_never_edits_main_plan_quantity(monkeypatch):
    """P0-3: adding a seat must go to a separate add-on sub, not rzp.subscription.edit
    on the main plan (which would multiply the whole plan amount)."""
    from app.services import razorpay_service

    calls = {"edit_main": 0, "addon": 0}

    def _boom_edit(*a, **k):
        calls["edit_main"] += 1
        raise AssertionError("main-plan quantity must never be edited for seat changes")

    def _fake_addon(session, client, *, extra_seats):
        calls["addon"] += 1
        return {"id": "sub_addon_123", "extra_seats": extra_seats}

    monkeypatch.setattr(razorpay_service, "update_subscription_quantity", _boom_edit)
    monkeypatch.setattr(razorpay_service, "create_seat_addon_subscription", _fake_addon)

    # ... build a client with an active main sub and call change_seat_count(delta=+1)
    # via TestClient with get_current_client overridden (mirror existing tests in this file).
    # Assert: calls["addon"] == 1 and calls["edit_main"] == 0.
```

(Complete the harness to match the existing style in `test_subscription_seats.py` — use its client/sub fixtures. The invariant asserted is `edit_main == 0`, `addon == 1`.)

- [ ] **Step 4: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_subscription_seats.py::test_add_seat_never_edits_main_plan_quantity -v`
Expected: FAIL — the current route calls `update_subscription_quantity`, tripping the `_boom_edit` assertion.

- [ ] **Step 5: Add add-on edit/cancel helpers in razorpay_service**

In `api/app/services/razorpay_service.py`, after `create_seat_addon_subscription`:

```python
def edit_seat_addon_quantity(session: Session, sub: Subscription, extra_seats: int) -> None:
    """Set the operator-seat add-on quantity for ``sub``.

    Creates the add-on subscription on first use, edits its quantity
    thereafter, and cancels it when ``extra_seats`` drops to 0. The main
    plan subscription is NEVER touched here (P0-3).
    """
    extra_seats = max(int(extra_seats), 0)
    if extra_seats == 0:
        if sub.seat_addon_subscription_id:
            cancel_seat_addon(session, sub)
        sub.seat_addon_quantity = 0
        session.flush()
        return

    rzp = _get_razorpay()
    if not sub.seat_addon_subscription_id:
        addon = create_seat_addon_subscription(session, sub.client, extra_seats=extra_seats)
        sub.seat_addon_subscription_id = addon["id"]
    else:
        try:
            rzp.subscription.edit(
                sub.seat_addon_subscription_id,
                data={"quantity": extra_seats, "schedule_change_at": "now"},
            )
        except Exception as exc:
            logger.exception(
                "Razorpay seat add-on edit (qty=%d) failed for %s: %s",
                extra_seats, sub.seat_addon_subscription_id, exc,
            )
            raise RazorpayBillingError("Could not update seat add-on with Razorpay.") from exc
    sub.seat_addon_quantity = extra_seats
    session.flush()


def cancel_seat_addon(session: Session, sub: Subscription) -> None:
    """Cancel the seat add-on subscription at the gateway and clear the mirror."""
    if not sub.seat_addon_subscription_id:
        return
    rzp = _get_razorpay()
    try:
        rzp.subscription.cancel(sub.seat_addon_subscription_id, {"cancel_at_cycle_end": 0})
    except Exception as exc:
        logger.exception("Razorpay seat add-on cancel failed for %s: %s", sub.seat_addon_subscription_id, exc)
        raise RazorpayBillingError("Could not cancel the seat add-on with Razorpay.") from exc
    sub.seat_addon_subscription_id = None
    sub.seat_addon_quantity = 0
    session.flush()
```

- [ ] **Step 6: Rewrite `change_seat_count` to use the add-on**

In `api/app/api/subscription_routes.py`, replace the try-block that calls `update_subscription_quantity` (`:1201-1209`) with:

```python
        # Seats are billed via a SEPARATE add-on subscription (₹extra_seat_price
        # × extra_seats). Editing the MAIN plan quantity would multiply the whole
        # plan amount (₹4,599×2 = ₹9,198 instead of ₹4,599+₹499) — P0-3.
        extra_seats = new_total - floor
        try:
            from app.services import razorpay_service

            razorpay_service.edit_seat_addon_quantity(session, sub, extra_seats)
        except razorpay_service.RazorpayBillingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Seat update failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail="Could not update seats with payment provider.") from exc

        sub.operator_quantity = new_total
        session.commit()
        return {"message": "Seats updated.", "total_seats": new_total, "extra_seats": extra_seats}
```

Also fix the stale docstring at `:1159-1166` to describe the add-on mechanism (remove the "subscription.edit with new quantity" and dangling proration sentence).

- [ ] **Step 7: Run the seat test to verify it passes**

Run: `cd api && uv run pytest tests/test_subscription_seats.py::test_add_seat_never_edits_main_plan_quantity -v`
Expected: PASS.

- [ ] **Step 8: Write the failing webhook test for the seat add-on**

In `api/tests/test_webhook_billing_routes.py` add a test that posts a `subscription.charged` (and `subscription.activated`) event whose subscription `notes.purpose == "seat_addon"` and asserts it is handled (200, not dead-lettered) and does not mutate the main plan credits.

```python
def test_seat_addon_webhook_is_handled_not_dead_lettered(client, ...):
    payload = _signed_event(
        "subscription.charged",
        subscription_notes={"purpose": "seat_addon", "oyechats_client_id": "1"},
    )
    resp = client.post("/webhooks/razorpay", data=payload, headers=_sig_headers(payload))
    assert resp.status_code == 200
    # assert: no plan-credit grant was written for the add-on; add-on is acknowledged
```

(Match the existing signing/fixture helpers in this file.)

- [ ] **Step 9: Run it to verify it fails, then handle the event**

Run: `cd api && uv run pytest tests/test_webhook_billing_routes.py -k seat_addon -v` → FAIL (dead-letters / grants incorrectly).

In `api/app/api/webhook_billing_routes.py`, in the subscription-event dispatch, branch on `notes.get("purpose") == "seat_addon"`: acknowledge + record the add-on charge/activation, and **do not** run the plan-credit grant path (seats don't grant monthly plan credits). Then re-run → PASS.

- [ ] **Step 10: Run the full billing suite + migration check + lint**

Run:
```bash
cd api
uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head
uv run pytest tests/test_subscription_seats.py tests/test_webhook_billing_routes.py tests/test_razorpay_service.py -v
uv run ruff check app/api/subscription_routes.py app/services/razorpay_service.py app/api/webhook_billing_routes.py app/db/models.py
uv run ruff format app/api/subscription_routes.py app/services/razorpay_service.py app/api/webhook_billing_routes.py
```
Expected: migration round-trips; all tests green; lint clean.

- [ ] **Step 11: Commit**

```bash
git add api/app/api/subscription_routes.py api/app/services/razorpay_service.py api/app/api/webhook_billing_routes.py api/app/db/models.py api/alembic/versions/*seat_addon* api/tests/test_subscription_seats.py api/tests/test_webhook_billing_routes.py
git commit -m "fix(billing): bill operator seats via separate add-on subscription, not main-plan quantity (P0-3)"
```

**Acceptance criteria:**
- `change_seat_count` never calls `update_subscription_quantity` on the main plan; `edit_main == 0` in the regression test.
- Seat add-on webhook events (`purpose=seat_addon`) are handled, not dead-lettered, and do not grant plan credits.
- Adding one extra seat to a ₹4,599 plan results in a ₹499 add-on charge, not ₹9,198 (asserted via the mocked add-on quantity).

---

## Task 3 · P0-1 — Fix the rate-limit trust boundary (Cloudflare-only ingress + real-IP)

**Root cause (verified):** nginx copies the client-supplied `CF-Connecting-IP` into `X-Real-IP`/`X-Forwarded-For` in every location block (`oyechats-locations.conf:26-27,42-43,61-62,74-75,88-89`) with no `set_real_ip_from`/`real_ip_header`; `oyechats-api.conf:20-30` serves plain `:80` with the redirect commented; `limit_req_zone` keys on `$binary_remote_addr` (the Cloudflare edge IP, not the visitor); gunicorn uses `UvicornWorker` bound to `127.0.0.1` so uvicorn trusts the proxied `X-Forwarded-For`; SlowAPI keys on `get_remote_address` → the spoofable value.

**Fix strategy (defense in depth):**
1. **nginx real-IP:** trust `CF-Connecting-IP` **only** from Cloudflare ranges via `set_real_ip_from` + `real_ip_header CF-Connecting-IP` + `real_ip_recursive on`, then forward `$remote_addr` (the validated real IP) — not the raw header.
2. **ufw:** restrict inbound :80/:443 to Cloudflare ranges so the origin cannot be hit directly to bypass the proxy.
3. **app layer (NB-9):** keep uvicorn `forwarded-allow-ips=127.0.0.1` (only nginx on loopback is trusted). SlowAPI's `get_remote_address` then reads the nginx-supplied validated IP.

Most of this is config + an ops step. Code-testable parts: a config-lint test asserting the nginx snippet contains the real-IP directives and no longer forwards the raw header, and a docs runbook.

**Files:**
- Create: `api/nginx/cloudflare-real-ip.conf` (generated CF ranges + `real_ip_header`)
- Modify: `api/nginx/oyechats-locations.conf` (include the real-ip conf; forward `$remote_addr` instead of `$http_cf_connecting_ip`)
- Modify: `api/nginx/oyechats-api.conf` (include real-ip conf at http/server scope)
- Modify: `api/gunicorn.conf.py` (pin uvicorn `forwarded_allow_ips`)
- Create: `docs/runbooks/cloudflare-origin-lockdown.md` (ufw + CF range refresh cron)
- Test: `api/tests/test_nginx_real_ip_config.py` (new — static assertions on the committed conf)

- [ ] **Step 1: Write the failing config-lint test**

Create `api/tests/test_nginx_real_ip_config.py`:

```python
"""P0-1: the committed nginx config must validate CF-Connecting-IP against
Cloudflare ranges (set_real_ip_from) instead of blindly trusting the header."""

from pathlib import Path

NGINX = Path(__file__).resolve().parents[1] / "nginx"


def test_real_ip_conf_exists_and_sets_directives():
    conf = (NGINX / "cloudflare-real-ip.conf").read_text()
    assert "real_ip_header CF-Connecting-IP" in conf
    assert "set_real_ip_from" in conf
    assert "real_ip_recursive on" in conf


def test_locations_forward_validated_remote_addr_not_raw_header():
    loc = (NGINX / "oyechats-locations.conf").read_text()
    # After realip runs, $remote_addr IS the validated visitor IP.
    assert "$http_cf_connecting_ip" not in loc, "raw client header must no longer be forwarded"
    assert "X-Real-IP $remote_addr" in loc
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_nginx_real_ip_config.py -v`
Expected: FAIL — file missing + raw header still present.

- [ ] **Step 3: Create the Cloudflare real-IP conf**

Create `api/nginx/cloudflare-real-ip.conf` (Cloudflare's published ranges — refresh via the cron in Step 6):

```nginx
# Trust the real client IP ONLY when the connection is genuinely from a
# Cloudflare edge. Without this, CF-Connecting-IP is attacker-controlled (P0-1).
# Source: https://www.cloudflare.com/ips/  (refresh via cron — see runbook)

# IPv4
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
# IPv6
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;

real_ip_header CF-Connecting-IP;
real_ip_recursive on;
```

- [ ] **Step 4: Include it and forward the validated IP**

In `api/nginx/oyechats-api.conf`, inside the `http`-level context is unavailable here (this file is a `server` fragment), so include the real-ip conf **inside the server block** just before the `include .../oyechats-locations.conf;` at `:29`:

```nginx
    include /etc/nginx/snippets/cloudflare-real-ip.conf;
    include /etc/nginx/snippets/oyechats-locations.conf;
```

In `api/nginx/oyechats-locations.conf`, replace **every** occurrence of:

```nginx
    proxy_set_header X-Real-IP $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
```

with (in all five location blocks — `/ws/`, `/chat/stream`, `/crawl`, `/health`, `/`):

```nginx
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Also update the header comment at `:6-9` to state that `$remote_addr` is now the Cloudflare-validated visitor IP (via `real_ip_header`), not a datacenter IP.

- [ ] **Step 5: Run the config-lint test**

Run: `cd api && uv run pytest tests/test_nginx_real_ip_config.py -v`
Expected: PASS (3 passed).

- [ ] **Step 6: Pin uvicorn proxy trust in gunicorn.conf.py**

In `api/gunicorn.conf.py`, after `worker_class = "uvicorn.workers.UvicornWorker"` (`:21`), add:

```python
# Only trust proxy headers (X-Forwarded-For / -Proto) from nginx on loopback.
# Without this, uvicorn would honor a spoofed X-Forwarded-For from any source
# that reached the port directly (P0-1 / NB-9).
forwarded_allow_ips = os.getenv("FORWARDED_ALLOW_IPS", "127.0.0.1")
```

- [ ] **Step 7: Write the ops runbook**

Create `docs/runbooks/cloudflare-origin-lockdown.md` with:
- `ufw` commands to allow :80/:443 **only** from Cloudflare ranges and deny all other origin ingress (loop over the same IP list; example: `for ip in $(curl -s https://www.cloudflare.com/ips-v4); do ufw allow from $ip to any port 443 proto tcp; done`, then `ufw deny 443` last-match, plus SSH allow).
- A weekly cron to refresh `cloudflare-real-ip.conf` from `https://www.cloudflare.com/ips-v4` + `ips-v6` and `nginx -t && systemctl reload nginx`.
- Manual verification: from a non-CF host, `curl -H 'CF-Connecting-IP: 1.2.3.4' http://<origin-ip>/...` must be refused by ufw (connection blocked), and via Cloudflare the app sees the true visitor IP.

- [ ] **Step 8: Run lint + full suite**

Run: `cd api && uv run ruff check app/ tests/ && uv run pytest tests/test_nginx_real_ip_config.py -v && uv run pytest -q`
Expected: lint clean; new test green; suite green (or unchanged skip profile).

- [ ] **Step 9: Commit**

```bash
git add api/nginx/cloudflare-real-ip.conf api/nginx/oyechats-locations.conf api/nginx/oyechats-api.conf api/gunicorn.conf.py docs/runbooks/cloudflare-origin-lockdown.md api/tests/test_nginx_real_ip_config.py
git commit -m "fix(security): validate CF-Connecting-IP against Cloudflare ranges + lock origin ingress (P0-1)"
```

- [ ] **Step 10: Deploy-time ops (on the droplet, requires explicit user authorization)**

Per CLAUDE.md production access rules, this is a manual, user-authorized step: copy the two nginx snippets to `/etc/nginx/snippets/`, apply the ufw rules from the runbook, `nginx -t && systemctl reload nginx`, restart the API service, and run the Step-7 manual verification. **Do not perform on prod without explicit approval.**

**Acceptance criteria:**
- `cloudflare-real-ip.conf` is committed and included; no location block forwards the raw `$http_cf_connecting_ip`.
- uvicorn trusts proxy headers only from loopback.
- Runbook documents ufw lockdown + CF-range refresh; a direct non-CF origin request cannot set its own rate-limit identity (manually verified on deploy).

---

## Phase 0 completion gate

- [ ] Task 1 (P0-2), Task 2 (P0-3), Task 3 (P0-1) all committed with tests green.
- [ ] `cd api && uv run pytest` green; `uv run ruff check . && uv run ruff format --check .` clean.
- [ ] PR `development → main` opened; P0-1 droplet ops step scheduled with the user.
- [ ] Master plan Phase 0 gate checkboxes ticked.

## Self-review (performed)

- **Spec coverage:** P0-1, P0-2, P0-3 each have a task; NB-7 (archive-other-tenant-files) is folded into Task 1 via the scoped folder + existence guard; NB-9 (uvicorn proxy trust) is folded into Task 3 Step 6.
- **Type/name consistency:** `_tenant_documents_dir(client_id, bot_id) -> Path` used identically in routes and tests; `edit_seat_addon_quantity(session, sub, extra_seats)` / `cancel_seat_addon(session, sub)` signatures consistent between service and route; `seat_addon_subscription_id`/`seat_addon_quantity` column names consistent across model, migration, and service.
- **Placeholder scan:** Step 3 (Task 2) and Step 8 (Task 2) intentionally say "match the existing fixture/signing style in this file" for the test harness — the asserted invariant is fully specified (`edit_main == 0`; webhook 200 not dead-lettered); complete the harness against the real fixtures when implementing.
