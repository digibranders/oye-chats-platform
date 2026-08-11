"""Upload validation: size, declared type, and what the bytes really are.

`/client/upload-logo` had NO size cap and NO type check. It called
`await file.read()` on a body bounded only by nginx's 50MB limit and handed
the result straight to `Image.open` — a decompression-bomb and Pillow-CVE
surface reachable by any authenticated customer.

Two sibling endpoints did check, but in the order that does not help:
read the whole body into memory, THEN measure it.
"""

from __future__ import annotations

import io

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image

from app.core.upload_guard import IMAGE_UPLOAD_TYPES, ensure_allowed_type, read_bounded
from app.services.r2_service import UnsupportedImage, process_image_for_logo


def _upload(data: bytes, content_type: str = "image/png", name: str = "logo.png") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data), headers={"content-type": content_type})


def _png(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), "red").save(buf, format="PNG")
    return buf.getvalue()


class TestBoundedRead:
    @pytest.mark.asyncio
    async def test_a_file_within_the_limit_is_returned_whole(self):
        data = b"x" * 1000
        assert await read_bounded(_upload(data), 5000) == data

    @pytest.mark.asyncio
    async def test_an_oversized_file_is_rejected_with_413(self):
        with pytest.raises(HTTPException) as exc:
            await read_bounded(_upload(b"x" * 6000), 5000)
        assert exc.value.status_code == 413

    @pytest.mark.asyncio
    async def test_rejection_does_not_buffer_the_whole_body(self):
        """The point of reading in chunks. Reading first and measuring second
        means a 50MB upload is already in RAM before anyone objects."""
        limit = 64 * 1024
        huge = _upload(b"x" * (8 * 1024 * 1024))
        with pytest.raises(HTTPException):
            await read_bounded(huge, limit)
        # Whatever was consumed, the stream must not have been drained.
        assert huge.file.tell() <= limit + 2 * 64 * 1024

    @pytest.mark.asyncio
    async def test_a_file_exactly_at_the_limit_is_accepted(self):
        data = b"x" * 5000
        assert len(await read_bounded(_upload(data), 5000)) == 5000


class TestDeclaredType:
    @pytest.mark.parametrize(
        "content_type", ["image/png", "image/jpeg", "image/webp", "IMAGE/PNG", "image/png; charset=x"]
    )
    def test_supported_types_pass(self, content_type):
        ensure_allowed_type(_upload(b"", content_type), IMAGE_UPLOAD_TYPES)

    @pytest.mark.parametrize(
        "content_type",
        ["application/pdf", "text/html", "application/octet-stream", "image/svg+xml", "", "text/plain"],
    )
    def test_unsupported_types_are_rejected_with_400(self, content_type):
        """SVG is deliberately absent: Pillow cannot open it, so every SVG
        upload 500'd for as long as the feature existed while the UI
        advertised it."""
        with pytest.raises(HTTPException) as exc:
            ensure_allowed_type(_upload(b"", content_type), IMAGE_UPLOAD_TYPES)
        assert exc.value.status_code == 400


class TestTheActualDecodeIsTheBoundary:
    """The declared content type is client-supplied and forgeable, so the
    check that decides has to be the one that decodes."""

    def test_a_real_image_processes(self):
        assert process_image_for_logo(_png(800, 600))

    def test_bytes_that_merely_CLAIM_to_be_png_are_rejected(self):
        """The attack the route's header check cannot stop."""
        with pytest.raises(UnsupportedImage):
            process_image_for_logo(b"MZ\x90\x00" + b"\x00" * 500)  # a PE header

    def test_a_truncated_image_is_rejected_not_crashed(self):
        """A header that parses over pixel data that stops early.

        The cut is a FRACTION of the encoded file, and asserted to be one. It
        used to be a fixed `[:120]`, which silently stopped testing anything on
        a machine whose Pillow encodes this image in under 120 bytes — the
        slice was then the whole valid file, `load()` succeeded, and the test
        failed with DID NOT RAISE. PNG size here is decided by which row filter
        the build picks: a solid colour under filter "Up" is 400 rows of zeros
        and compresses to almost nothing, so the encoded length is a property
        of the platform, never something to hard-code against.
        """
        full = _png(400, 400)
        truncated = full[: len(full) // 2]
        assert 0 < len(truncated) < len(full), "the fixture must actually be missing data"

        with pytest.raises(UnsupportedImage):
            process_image_for_logo(truncated)

    def test_empty_input_is_rejected(self):
        with pytest.raises(UnsupportedImage):
            process_image_for_logo(b"")

    def test_a_decompression_bomb_is_refused_before_it_is_decoded(self):
        """A small file that expands to an enormous frame. Pillow's own guard
        is a WARNING at ~89M pixels, not an error, so by default this decodes
        and is merely grumbled about."""
        buf = io.BytesIO()
        # ~100M pixels from a highly compressible solid colour: a few hundred
        # KB on disk, gigabytes decoded.
        Image.new("L", (10_000, 10_000), 0).save(buf, format="PNG")
        bomb = buf.getvalue()

        from app.services import r2_service

        original = r2_service.MAX_DECODED_PIXELS
        try:
            r2_service.MAX_DECODED_PIXELS = 1_000_000  # 10k x 10k is 100x this
            with pytest.raises(UnsupportedImage):
                process_image_for_logo(bomb)
        finally:
            r2_service.MAX_DECODED_PIXELS = original
            Image.MAX_IMAGE_PIXELS = original

    def test_the_pixel_ceiling_is_far_below_pillows_permissive_default(self):
        from app.services import r2_service

        assert r2_service.MAX_DECODED_PIXELS < 89_000_000

    @pytest.mark.parametrize("fmt", ["TIFF", "ICO"])
    def test_a_decodable_format_outside_the_allow_list_is_refused(self, fmt):
        """The allow-list has to do work that `Image.open` failing does not.

        Garbage bytes and truncated files are already rejected by the decode
        itself, so they do not exercise this rule — removing the allow-list
        left those tests green. A TIFF or ICO decodes perfectly well; it is
        simply not something the logo pipeline should accept, and each extra
        decoder is extra attack surface.
        """
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), "blue").save(buf, format=fmt)

        with pytest.raises(UnsupportedImage, match="Unsupported image format"):
            process_image_for_logo(buf.getvalue())
