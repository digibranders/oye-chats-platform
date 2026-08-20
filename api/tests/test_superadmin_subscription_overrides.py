"""``PUT/GET /superadmin/subscriptions`` — the manual-override endpoints.

Two defects covered here:

* ``extend_trial_days`` used to be applied only when ``trial_end`` was already
  set, and answered 200 otherwise. A support engineer was told they had granted
  days they had not granted. It now 409s, and the field is bounded so ``0``
  (a no-op edit), a negative (a silent trial SHORTENING) and an absurd value
  (``trial_end + timedelta`` overflowing past ``datetime.max``) are all 422s.
* ``list_subscriptions`` capped at 200 rows with no total, no paging and no
  search. It now answers the house ``{total, page, limit, items}`` envelope.

Real-Postgres route tests via the shared ``db`` fixture; skip without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_plan_routes
from app.api.auth import get_superadmin
from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="superadmin subscription route tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _ctx(session):
    yield session


def _api(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, is_superadmin=True)
    return TestClient(app, raise_server_exceptions=False)


def _plan(db, *, slug: str = "std") -> Plan:
    plan = Plan(name="Standard", slug=slug, currency="INR")
    db.add(plan)
    db.flush()
    return plan


def _client_row(db, *, email: str, name: str = "Acme") -> Client:
    row = Client(name=name, email=email, api_key=email, hashed_password="h", is_verified=True)
    db.add(row)
    db.flush()
    return row


def _sub(db, client: Client, plan: Plan, **kwargs) -> Subscription:
    sub = Subscription(client_id=client.id, plan_id=plan.id, **kwargs)
    db.add(sub)
    db.flush()
    return sub


# ── extend_trial_days ────────────────────────────────────────────────────────


def test_extend_trial_on_a_row_with_no_trial_is_409_and_changes_nothing(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    plan = _plan(db)
    owner = _client_row(db, email="no-trial@e.com")
    period_end = datetime(2026, 9, 1, tzinfo=UTC)
    sub = _sub(db, owner, plan, status="active", trial_end=None, current_period_end=period_end)
    db.commit()

    res = api.put(f"/superadmin/subscriptions/{sub.id}", json={"extend_trial_days": 7})

    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert "no trial to extend" in detail
    # The remedy is named, not left to the caller to guess.
    assert "/subscriptions/start-trial" in detail

    db.expire_all()
    refreshed = db.get(Subscription, sub.id)
    assert refreshed.trial_end is None
    assert refreshed.current_period_end == period_end


def test_a_combined_request_applies_nothing_when_there_is_no_trial(db, monkeypatch) -> None:
    # The refusal is checked before any field is written, so the operator does
    # not get a half-applied override alongside the 409.
    api = _api(db, monkeypatch)
    plan = _plan(db, slug="combined")
    owner = _client_row(db, email="combined@e.com")
    sub = _sub(db, owner, plan, status="active", operator_quantity=1, trial_end=None)
    db.commit()

    res = api.put(
        f"/superadmin/subscriptions/{sub.id}",
        json={"operator_quantity": 9, "status": "paused", "extend_trial_days": 7},
    )
    assert res.status_code == 409, res.text

    db.expire_all()
    refreshed = db.get(Subscription, sub.id)
    assert refreshed.operator_quantity == 1
    assert refreshed.status == "active"


def test_extend_trial_moves_trial_end_by_exactly_n_days(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    plan = _plan(db)
    owner = _client_row(db, email="trialing@e.com")
    trial_end = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    sub = _sub(
        db,
        owner,
        plan,
        status="trialing",
        trial_start=trial_end - timedelta(days=7),
        trial_end=trial_end,
        current_period_start=trial_end - timedelta(days=7),
        # A trial row is created with the two ends pinned equal.
        current_period_end=trial_end,
    )
    db.commit()

    res = api.put(f"/superadmin/subscriptions/{sub.id}", json={"extend_trial_days": 5})
    assert res.status_code == 200, res.text

    db.expire_all()
    refreshed = db.get(Subscription, sub.id)
    assert refreshed.trial_end == trial_end + timedelta(days=5)
    # ``current_period_end`` rides along: it is the same fact in a second column
    # and every reader of it (the "Resets on" label, the gateway-cancellation
    # sweep) would otherwise act on the stale deadline.
    assert refreshed.current_period_end == trial_end + timedelta(days=5)
    body = res.json()
    assert body["trial_end"] == (trial_end + timedelta(days=5)).isoformat()
    assert body["current_period_end"] == (trial_end + timedelta(days=5)).isoformat()


def test_extend_trial_leaves_a_later_gateway_period_end_alone(db, monkeypatch) -> None:
    # A period end BEYOND the trial is driven by a live mandate this endpoint
    # never touches. Deferring the local copy would misstate the charge date.
    api = _api(db, monkeypatch)
    plan = _plan(db)
    owner = _client_row(db, email="mandate@e.com")
    trial_end = datetime(2026, 9, 1, tzinfo=UTC)
    period_end = datetime(2026, 10, 1, tzinfo=UTC)
    sub = _sub(db, owner, plan, status="trialing", trial_end=trial_end, current_period_end=period_end)
    db.commit()

    res = api.put(f"/superadmin/subscriptions/{sub.id}", json={"extend_trial_days": 3})
    assert res.status_code == 200, res.text

    db.expire_all()
    refreshed = db.get(Subscription, sub.id)
    assert refreshed.trial_end == trial_end + timedelta(days=3)
    assert refreshed.current_period_end == period_end


@pytest.mark.parametrize("days", [0, -1, 10_000])
def test_out_of_range_extensions_are_rejected(db, monkeypatch, days: int) -> None:
    api = _api(db, monkeypatch)
    plan = _plan(db)
    owner = _client_row(db, email=f"bounds{days}@e.com")
    trial_end = datetime(2026, 9, 1, tzinfo=UTC)
    sub = _sub(db, owner, plan, status="trialing", trial_end=trial_end, current_period_end=trial_end)
    db.commit()

    res = api.put(f"/superadmin/subscriptions/{sub.id}", json={"extend_trial_days": days})
    assert res.status_code == 422, res.text

    db.expire_all()
    assert db.get(Subscription, sub.id).trial_end == trial_end


def test_extend_trial_on_a_missing_subscription_is_404(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    db.commit()
    res = api.put("/superadmin/subscriptions/987654", json={"extend_trial_days": 7})
    assert res.status_code == 404, res.text


# ── list_subscriptions paging ────────────────────────────────────────────────


def _seed_three(db) -> tuple[Plan, list[Subscription]]:
    plan = _plan(db, slug="paging")
    subs = []
    for i in range(3):
        owner = _client_row(db, email=f"pager{i}@e.com", name=f"Pager {i}")
        subs.append(_sub(db, owner, plan, status="active"))
    db.commit()
    return plan, subs


def test_paging_reports_total_and_returns_every_row_exactly_once(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    _plan_row, subs = _seed_three(db)
    expected = {s.id for s in subs}

    first = api.get("/superadmin/subscriptions?limit=2&page=1")
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["total"] == 3
    assert body["page"] == 1
    assert body["limit"] == 2
    assert len(body["items"]) == 2

    second = api.get("/superadmin/subscriptions?limit=2&page=2")
    assert second.status_code == 200, second.text
    tail = second.json()
    assert tail["total"] == 3
    assert len(tail["items"]) == 1

    # All three rows were written in ONE transaction, so they share
    # ``created_at`` exactly. Without the id tiebreak the two OFFSET queries can
    # resolve that tie differently and the union is short (or doubled).
    seen = [row["id"] for row in body["items"]] + [row["id"] for row in tail["items"]]
    assert len(seen) == len(set(seen)) == 3
    assert set(seen) == expected


# Enough rows sharing one ``created_at`` that the planner sorts rather than
# trivially answering in physical order. Three rows are not enough to expose an
# unstable tie on this Postgres, which is exactly how the defect survives.
_TIED_ROWS = 60
_TIED_PAGE = 10


def test_tied_created_at_pages_without_duplicating_or_dropping(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    plan = _plan(db, slug="tied")
    for i in range(_TIED_ROWS):
        owner = _client_row(db, email=f"tied{i}@e.com", name=f"Tied {i}")
        _sub(db, owner, plan, status="active")
    db.commit()

    stamps = {row.created_at for row in db.query(Subscription).all()}
    assert len(stamps) == 1, "fixture must produce rows with one identical timestamp"
    expected = {row.id for row in db.query(Subscription).all()}

    seen: list[int] = []
    for page in range(1, _TIED_ROWS // _TIED_PAGE + 1):
        body = api.get(f"/superadmin/subscriptions?limit={_TIED_PAGE}&page={page}").json()
        assert body["total"] == _TIED_ROWS
        assert len(body["items"]) == _TIED_PAGE
        seen.extend(row["id"] for row in body["items"])

    assert len(seen) - len(set(seen)) == 0, "a row was served on two pages"
    assert set(seen) == expected, "a row was never served on any page"


def test_the_default_page_size_is_the_old_cap(db, monkeypatch) -> None:
    # An un-paged caller (today's console) must still get the same row set it
    # got before, now with a total beside it.
    api = _api(db, monkeypatch)
    _seed_three(db)
    body = api.get("/superadmin/subscriptions").json()
    assert body["limit"] == 200
    assert body["page"] == 1
    assert body["total"] == 3
    assert len(body["items"]) == 3


def test_page_past_the_end_is_empty_with_the_real_total(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    _seed_three(db)

    res = api.get("/superadmin/subscriptions?limit=2&page=9")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["items"] == []
    assert body["total"] == 3


def test_search_matches_client_email_and_name(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    plan = _plan(db, slug="searchable")
    wanted = _client_row(db, email="findme@corp.example", name="Zenith Ltd")
    other = _client_row(db, email="someone@other.example", name="Nothing Inc")
    target = _sub(db, wanted, plan, status="active")
    _sub(db, other, plan, status="active")
    db.commit()

    by_email = api.get("/superadmin/subscriptions?search=findme").json()
    assert by_email["total"] == 1
    assert [r["id"] for r in by_email["items"]] == [target.id]
    assert by_email["items"][0]["client_email"] == "findme@corp.example"

    by_name = api.get("/superadmin/subscriptions?search=zenith").json()
    assert by_name["total"] == 1
    assert [r["id"] for r in by_name["items"]] == [target.id]


def test_search_wildcards_are_escaped_not_interpreted(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    _seed_three(db)
    # A bare '%' must be a literal, not "match every row".
    res = api.get("/superadmin/subscriptions?search=%25").json()
    assert res["total"] == 0
    assert res["items"] == []


def test_status_and_plan_filters_still_apply(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    plan = _plan(db, slug="filters")
    owner = _client_row(db, email="filter@e.com")
    active = _sub(db, owner, plan, status="active")
    _sub(db, _client_row(db, email="filter2@e.com"), plan, status="canceled")
    db.commit()

    res = api.get(f"/superadmin/subscriptions?status=active&plan_id={plan.id}").json()
    assert res["total"] == 1
    assert [r["id"] for r in res["items"]] == [active.id]
    assert res["items"][0]["plan_name"] == "Standard"
