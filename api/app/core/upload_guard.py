"""Bounded, type-checked reading of multipart uploads.

Every upload endpoint had grown its own copy of the same two checks, and the
copies disagreed. ``/client/upload-logo`` had NEITHER: it called
``await file.read()`` with no cap and handed the bytes straight to
``Image.open``, so anything up to nginx's 50 MB body limit was materialised in
RAM and then decoded by Pillow — a decompression-bomb and CVE surface reachable
by any authenticated customer.

The other two endpoints did check, but in the order that does not help:

    content = await file.read()          # the whole 50 MB is already in RAM
    if len(content) > MAX_SIZE: reject   # …and only now do we object

Reading in bounded chunks means an oversized upload costs one chunk beyond the
limit, not the whole body, and a client that lies about ``Content-Length``
cannot get around it.

Client-supplied ``content_type`` is a hint, not evidence — it is trivially
forged. The allow-list here is a cheap early reject; anything that actually
decodes the bytes must ALSO verify what it really got (see
``r2_service.process_image_for_logo``).
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, UploadFile, status

logger = logging.getLogger(__name__)

# Read granularity. Small enough that the overshoot past a limit is trivial,
# large enough not to make a syscall per kilobyte.
_CHUNK_BYTES = 64 * 1024

# What the logo pipeline can actually process. Pillow cannot open SVG at all —
# every SVG upload 500'd for as long as the feature existed, while the UI
# advertised it — so it is deliberately absent.
IMAGE_UPLOAD_TYPES = frozenset({"image/png", "image/jpeg", "image/jpg", "image/webp"})

MAX_LOGO_BYTES = 5 * 1024 * 1024


async def read_bounded(upload: UploadFile, max_bytes: int) -> bytes:
    """Read at most ``max_bytes`` from ``upload``; reject anything larger.

    Raises 413 rather than truncating: silently storing a partial image would
    be worse than refusing it. Never holds more than ``max_bytes`` plus one
    chunk in memory, regardless of what the client sends or claims.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            logger.warning(
                "upload rejected: exceeded %d bytes (filename=%r, declared type=%r)",
                max_bytes,
                upload.filename,
                upload.content_type,
            )
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File exceeds the {max_bytes // (1024 * 1024)}MB limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def ensure_allowed_type(upload: UploadFile, allowed: frozenset[str]) -> None:
    """Reject a declared content type outside ``allowed``.

    A cheap early exit only. The header is client-controlled, so this stops an
    honest mistake and a lazy attacker — it is NOT the security boundary. The
    boundary is whatever decodes the bytes.
    """
    declared = (upload.content_type or "").split(";")[0].strip().lower()
    if declared not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type '{upload.content_type or 'unknown'}' is not supported. Use PNG, JPG or WebP.",
        )
