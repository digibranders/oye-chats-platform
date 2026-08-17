"""Tests for the global request-body ceiling.

The point of this middleware is that it holds for endpoints that never see a
Pydantic model — most importantly ``POST /webhooks/razorpay``, which has to
read the raw body before it can verify the HMAC, so an unauthenticated caller
controls that allocation.
"""

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.core.body_limit import (
    DEFAULT_MAX_BODY_BYTES,
    UPLOAD_MAX_BODY_BYTES,
    BodySizeLimitMiddleware,
    limit_for_path,
)


def _app(**kwargs):
    app = FastAPI()
    app.add_middleware(BodySizeLimitMiddleware, **kwargs)

    @app.post("/echo")
    async def echo(request: Request):
        body = await request.body()
        return {"received": len(body)}

    @app.post("/ingest")
    async def ingest(request: Request):
        body = await request.body()
        return {"received": len(body)}

    @app.get("/ping")
    def ping():
        return {"ok": True}

    return app


class TestPerPathLimits:
    def test_json_routes_get_the_default_ceiling(self):
        assert limit_for_path("/chat") == DEFAULT_MAX_BODY_BYTES
        assert limit_for_path("/webhooks/razorpay") == DEFAULT_MAX_BODY_BYTES

    def test_upload_routes_get_the_larger_ceiling(self):
        # Must be at least what the document pipeline itself accepts (60 MB
        # per request), or this middleware would reject uploads the endpoint
        # would have allowed.
        assert limit_for_path("/ingest") == UPLOAD_MAX_BODY_BYTES
        assert limit_for_path("/ingest/preview-cost") == UPLOAD_MAX_BODY_BYTES
        assert UPLOAD_MAX_BODY_BYTES >= 60 * 1024 * 1024


class TestRejection:
    def test_rejects_an_oversized_body(self):
        client = TestClient(_app(max_body_bytes=1024), raise_server_exceptions=False)
        res = client.post("/echo", content=b"x" * 4096)
        assert res.status_code == 413
        assert res.json()["code"] == "payload_too_large"

    def test_allows_a_body_at_the_limit(self):
        client = TestClient(_app(max_body_bytes=1024))
        res = client.post("/echo", content=b"x" * 1024)
        assert res.status_code == 200
        assert res.json()["received"] == 1024

    def test_rejects_on_a_lying_content_length_header(self):
        # The header check is the cheap path; the streamed counter is what
        # actually holds when the client understates or omits it.
        client = TestClient(_app(max_body_bytes=1024), raise_server_exceptions=False)
        res = client.post(
            "/echo",
            content=b"x" * 4096,
            headers={"Content-Length": "10"},
        )
        assert res.status_code == 413

    def test_rejects_a_chunked_body_with_no_content_length(self):
        def _chunks():
            for _ in range(20):
                yield b"x" * 1024

        client = TestClient(_app(max_body_bytes=1024), raise_server_exceptions=False)
        res = client.post("/echo", content=_chunks())
        assert res.status_code == 413

    def test_upload_paths_use_their_own_larger_ceiling(self):
        client = TestClient(
            _app(max_body_bytes=1024, upload_max_body_bytes=1024 * 1024),
            raise_server_exceptions=False,
        )
        # Over the JSON ceiling, under the upload one.
        assert client.post("/ingest", content=b"x" * 4096).status_code == 200
        assert client.post("/echo", content=b"x" * 4096).status_code == 413

    def test_bodyless_requests_are_untouched(self):
        client = TestClient(_app(max_body_bytes=1024))
        assert client.get("/ping").status_code == 200

    @pytest.mark.parametrize("bad", ["", "not-a-number", "-5"])
    def test_a_malformed_content_length_still_falls_through_to_the_counter(self, bad):
        client = TestClient(_app(max_body_bytes=1024), raise_server_exceptions=False)
        res = client.post("/echo", content=b"x" * 4096, headers={"Content-Length": bad})
        # However the header is mangled, the streamed byte count still bounds
        # the request.
        assert res.status_code == 413
