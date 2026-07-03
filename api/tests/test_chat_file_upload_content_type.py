"""Regression tests for NB-1: stored XSS via chat-file upload content_type.

`upload_chat_file` previously stored the caller-supplied ``content_type``
verbatim on the R2 object. Combined with the ``/files/`` route serving
``image/svg+xml`` inline (SVG can carry <script>), an attacker could upload an
SVG chat attachment and have it executed inline from the app origin.

These tests pin two independent defenses:
1. `upload_chat_file` neutralizes scriptable content types to
   ``application/octet-stream`` before storing them on R2.
2. `_INLINE_SAFE_TYPES` in ``app.main`` never contains scriptable types, so the
   ``/files/`` route serves them as ``attachment`` even if one slips through.
"""

from app.services import r2_service


class _FakeS3Client:
    """Records the last put_object call so assertions can inspect ContentType."""

    def __init__(self):
        self.put_calls: list[dict] = []

    def put_object(self, **kwargs):
        self.put_calls.append(kwargs)
        return {"ETag": "fake-etag"}


def test_svg_upload_is_neutralized_to_octet_stream(monkeypatch):
    fake = _FakeS3Client()
    monkeypatch.setattr(r2_service, "s3_client", fake)

    svg_payload = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    key = r2_service.upload_chat_file(svg_payload, "evil.svg", "image/svg+xml")

    assert len(fake.put_calls) == 1
    stored = fake.put_calls[0]
    # Body must be preserved (upload_chat_file does not re-encode), but the
    # stored content type must NOT be a scriptable svg.
    assert stored["Body"] == svg_payload
    assert stored["ContentType"] == "application/octet-stream"
    assert stored["ContentType"] != "image/svg+xml"
    # Key still carries the original extension for reference.
    assert key.startswith("chat-files/") and key.endswith(".svg")


def test_html_and_script_types_are_neutralized(monkeypatch):
    fake = _FakeS3Client()
    monkeypatch.setattr(r2_service, "s3_client", fake)

    for ct in ("text/html", "application/xhtml+xml", "application/javascript", "text/xml"):
        fake.put_calls.clear()
        r2_service.upload_chat_file(b"<html></html>", "x.bin", ct)
        assert fake.put_calls[0]["ContentType"] == "application/octet-stream", ct


def test_legitimate_types_are_preserved(monkeypatch):
    fake = _FakeS3Client()
    monkeypatch.setattr(r2_service, "s3_client", fake)

    cases = {
        "application/pdf": b"%PDF-1.4",
        "image/png": b"\x89PNG\r\n",
        "image/jpeg": b"\xff\xd8\xff",
        "image/gif": b"GIF89a",
        "image/webp": b"RIFF",
        "text/plain": b"hello",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": b"PK\x03\x04",
    }
    for ct, payload in cases.items():
        fake.put_calls.clear()
        r2_service.upload_chat_file(payload, "file.bin", ct)
        assert fake.put_calls[0]["ContentType"] == ct, ct


def test_missing_content_type_defaults_to_octet_stream(monkeypatch):
    fake = _FakeS3Client()
    monkeypatch.setattr(r2_service, "s3_client", fake)

    r2_service.upload_chat_file(b"data", "file.bin", None)
    assert fake.put_calls[0]["ContentType"] == "application/octet-stream"


def test_inline_safe_types_exclude_scriptable_types():
    from app import main

    scriptable = {
        "image/svg+xml",
        "text/html",
        "application/xhtml+xml",
        "application/javascript",
        "text/javascript",
        "text/xml",
        "application/xml",
    }
    assert scriptable.isdisjoint(main._INLINE_SAFE_TYPES)


def test_svg_content_type_is_served_as_attachment():
    """Even if an svg content type reaches the serving route, it is not inline."""
    from app import main

    assert "image/svg+xml" not in main._INLINE_SAFE_TYPES
    disposition = "inline" if "image/svg+xml" in main._INLINE_SAFE_TYPES else "attachment"
    assert disposition == "attachment"
