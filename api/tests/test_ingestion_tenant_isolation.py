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


# ── Defense-in-depth: archive / quarantine cold storage is per-tenant too ─────


def test_archive_is_scoped_to_tenant(tmp_path, monkeypatch):
    """A processed file is archived under {ARCHIVE_DIR}/{client_id}/{bot_id}/."""
    monkeypatch.setattr(pipeline, "ARCHIVE_DIR", str(tmp_path))
    src = tmp_path / "pricing.pdf"
    src.write_bytes(b"A-owned")

    pipeline.move_to_archive(str(src), "pricing.pdf", client_id=1, bot_id=10)

    assert (tmp_path / "1" / "10" / "pricing.pdf").is_file()
    assert not src.exists()


def test_quarantine_is_scoped_to_tenant(tmp_path, monkeypatch):
    """A failed file is quarantined under the tenant's own subtree."""
    monkeypatch.setattr(pipeline, "ARCHIVE_DIR", str(tmp_path))
    src = tmp_path / "broken.pdf"
    src.write_bytes(b"B-owned")

    pipeline.move_to_quarantine(str(src), "broken.pdf", client_id=2, bot_id=20)

    assert (tmp_path / "2" / "20" / "_quarantine" / "broken.pdf").is_file()
    assert not src.exists()


def test_same_filename_never_collides_across_tenants(tmp_path, monkeypatch):
    """Two tenants archiving an identically-named file stay fully separated."""
    monkeypatch.setattr(pipeline, "ARCHIVE_DIR", str(tmp_path))
    for client_id in (1, 2):
        src = tmp_path / f"src-{client_id}.pdf"
        src.write_bytes(f"tenant-{client_id}".encode())
        pipeline.move_to_archive(str(src), "shared.pdf", client_id=client_id, bot_id=10)

    assert (tmp_path / "1" / "10" / "shared.pdf").read_bytes() == b"tenant-1"
    assert (tmp_path / "2" / "10" / "shared.pdf").read_bytes() == b"tenant-2"


def test_delete_archived_copies_purges_only_this_tenant(tmp_path, monkeypatch):
    """Deleting a document removes this tenant's archived + quarantined copies
    (verbatim and collision-renamed) while leaving other tenants untouched."""
    monkeypatch.setattr(pipeline, "ARCHIVE_DIR", str(tmp_path))

    archive_1 = tmp_path / "1" / "10"
    quarantine_1 = archive_1 / "_quarantine"
    archive_1.mkdir(parents=True)
    quarantine_1.mkdir(parents=True)
    (archive_1 / "doc.pdf").write_bytes(b"x")
    (archive_1 / "doc_20260703_120000.pdf").write_bytes(b"x")  # collision-renamed copy
    (quarantine_1 / "doc.pdf").write_bytes(b"x")

    # A different tenant with the same filename must survive.
    archive_2 = tmp_path / "2" / "10"
    archive_2.mkdir(parents=True)
    (archive_2 / "doc.pdf").write_bytes(b"other-tenant")

    removed = pipeline.delete_archived_copies(client_id=1, bot_id=10, filename="doc.pdf")

    assert removed == 3
    assert not (archive_1 / "doc.pdf").exists()
    assert not (archive_1 / "doc_20260703_120000.pdf").exists()
    assert not (quarantine_1 / "doc.pdf").exists()
    assert (archive_2 / "doc.pdf").read_bytes() == b"other-tenant"


def test_delete_archived_copies_is_noop_when_nothing_archived(tmp_path, monkeypatch):
    """No archived copies (e.g. crawled URL sources) → nothing removed, no error."""
    monkeypatch.setattr(pipeline, "ARCHIVE_DIR", str(tmp_path))

    assert pipeline.delete_archived_copies(client_id=1, bot_id=10, filename="doc.pdf") == 0
