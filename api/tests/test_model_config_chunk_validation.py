"""AR-07 regression: PUT /superadmin/model-config must reject a chunk_size/
chunk_overlap combination that would crash ingestion.

chunk_size and chunk_overlap are independently range-validated by
ModelConfigPatch's Field(ge=..., le=...), but two separately-valid PUTs (one
admin changes chunk_size, another later changes chunk_overlap) could leave
overlap >= size persisted. RecursiveCharacterTextSplitter then raises an
uncaught ValueError on the next ingestion (upload or crawl), a platform-wide
outage. The route must validate the EFFECTIVE post-patch values (new value if
patched, else the currently-stored one) before writing anything.
"""

from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient as HttpClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin


@contextmanager
def _ctx(session):
    yield session


@pytest.fixture()
def client(db, monkeypatch):
    from app.services import runtime_config

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    # runtime_config.get_chunk_size()/get_chunk_overlap() (used by the route's
    # cross-validation) load their cache via app.services.runtime_config's own
    # get_session. Point that at the same test DB, or reads would silently
    # hit the real app database instead of this test's throwaway one.
    monkeypatch.setattr(runtime_config, "get_session", lambda: _ctx(db))
    runtime_config.invalidate_runtime_config_cache()
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="A", is_superadmin=True, superadmin_role="owner"
    )
    return HttpClient(app)


def test_rejects_single_patch_that_makes_overlap_exceed_default_size(client, monkeypatch):
    """Simplest repro: chunk_size has never been set (falls back to the env
    default), and a single PUT sets chunk_overlap above it."""
    from app.config import CHUNK_SIZE

    res = client.put("/superadmin/model-config", json={"chunk_overlap": CHUNK_SIZE + 100})
    assert res.status_code == 400
    assert "chunk_overlap" in res.json()["detail"]
    assert "chunk_size" in res.json()["detail"]


def test_rejects_second_patch_that_conflicts_with_first(client):
    """The exact two-admin/two-PUT repro from the finding: PUT #1 sets a
    small chunk_size; PUT #2 (independently valid per its own Field bounds)
    sets an overlap that's now >= that stored chunk_size."""
    res1 = client.put("/superadmin/model-config", json={"chunk_size": 300})
    assert res1.status_code == 200, res1.text

    res2 = client.put("/superadmin/model-config", json={"chunk_overlap": 500})
    assert res2.status_code == 400
    assert "300" in res2.json()["detail"]
    assert "500" in res2.json()["detail"]


def test_accepts_valid_combo_in_a_single_patch(client):
    res = client.put("/superadmin/model-config", json={"chunk_size": 1000, "chunk_overlap": 200})
    assert res.status_code == 200, res.text
    assert res.json()["ok"] is True


def test_accepts_valid_combo_across_two_patches(client):
    res1 = client.put("/superadmin/model-config", json={"chunk_size": 2000})
    assert res1.status_code == 200, res1.text

    res2 = client.put("/superadmin/model-config", json={"chunk_overlap": 200})
    assert res2.status_code == 200, res2.text


def test_rejected_patch_writes_nothing(client, db):
    """A 400 must not partially commit, the overlap value must not land in
    pricing_config even though it individually passed Field validation."""
    from app.db.models import PricingConfig

    res = client.put("/superadmin/model-config", json={"chunk_overlap": 999999})
    assert res.status_code in (400, 422)  # 422 if Field(le=2000) catches it first

    assert db.get(PricingConfig, "rag.chunk_overlap") is None
