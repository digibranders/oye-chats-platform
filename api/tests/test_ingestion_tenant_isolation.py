"""P0-2 regression: an ingestion job must only ever see its own tenant's files."""

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

    monkeypatch.setattr(pipeline, "_ingest_document", _fake_ingest)
    monkeypatch.setattr(pipeline, "load_pdf", lambda p: [{"text": "x", "page": 1}])
    monkeypatch.setattr(pipeline, "move_to_archive", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "move_to_quarantine", lambda *a, **k: None)

    pipeline.run_folder_ingestion(client_id=1, folder_path=str(dir_a), bot_id=10)

    assert seen == ["pricing.pdf"]
    assert "secret.pdf" not in seen


def test_missing_tenant_dir_returns_zero(tmp_path):
    assert pipeline.run_folder_ingestion(1, str(tmp_path / "nope"), bot_id=1) == 0
