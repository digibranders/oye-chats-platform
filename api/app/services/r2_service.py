"""S3-compatible object storage client (Cloudflare R2 in production).

Production deployments use Cloudflare R2; the env var prefix `R2_*` reflects that.
A small set of legacy "friendly URL" helpers below were originally written for
Backblaze B2 and remain in place as inert fallbacks: they only fire when the
endpoint string matches Backblaze's pattern. On Cloudflare R2 the regex misses
and the code falls through to the standard S3-style URL.
"""

import io
import logging
import re
import uuid
from contextlib import contextmanager

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from PIL import Image, ImageFile

from app.config import R2_APPLICATION_KEY, R2_BUCKET_NAME, R2_ENDPOINT, R2_KEY_ID, R2_PUBLIC_BASE_URL

logger = logging.getLogger(__name__)

# Content types safe to store (and later serve) verbatim on a chat attachment.
# Anything NOT on this allowlist is stored as ``application/octet-stream`` so a
# scriptable payload (SVG/HTML/JS/XML) can never be served inline from the app
# origin as its declared type, the root of the stored-XSS vector (NB-1).
_SAFE_CHAT_FILE_CONTENT_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/heic",
        "image/heif",
        "image/avif",
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-powerpoint",
    }
)

_DEFAULT_CHAT_FILE_CONTENT_TYPE = "application/octet-stream"


def _safe_chat_file_content_type(content_type: str | None) -> str:
    """Return a storage-safe content type for a chat attachment.

    Caller-supplied content types are only trusted when they appear on an
    explicit allowlist of non-scriptable types; everything else (including
    ``image/svg+xml``, ``text/html`` and any script-capable type, as well as a
    missing value) collapses to ``application/octet-stream``.
    """
    if not content_type:
        return _DEFAULT_CHAT_FILE_CONTENT_TYPE
    normalized = content_type.split(";", 1)[0].strip().lower()
    if normalized in _SAFE_CHAT_FILE_CONTENT_TYPES:
        return normalized
    return _DEFAULT_CHAT_FILE_CONTENT_TYPE


# Object-key extension taken from a caller-supplied file name. The name is
# never used as a path, the key is ``<prefix>/<uuid4>.<ext>``, but the
# extension was previously spliced in verbatim, so a name like
# ``report.tar.gz/../../x`` produced a key containing separators and traversal
# segments, and an extension could be arbitrarily long.
_SAFE_EXTENSION_RE = re.compile(r"^[a-z0-9]{1,12}$")
_DEFAULT_EXTENSION = "bin"


def safe_object_extension(original_filename: str | None) -> str:
    """Lower-cased, allow-listed extension for an object key, or ``bin``."""
    if not original_filename or "." not in original_filename:
        return _DEFAULT_EXTENSION
    ext = original_filename.rsplit(".", 1)[-1].strip().lower()
    return ext if _SAFE_EXTENSION_RE.match(ext) else _DEFAULT_EXTENSION


class UnsupportedImage(ValueError):
    """The uploaded bytes are not an image we will process.

    Distinct from a generic failure so the route can answer 400 (your file is
    wrong) rather than 500 (we are broken).
    """


# Pillow's own guard is a WARNING at ~89M pixels, not an error, so by default a
# decompression bomb is decoded and only grumbled about. 40M pixels is ~7x more
# than any real logo needs (the output is 512x512) and caps a decoded frame at
# roughly 160 MB rather than gigabytes.
MAX_DECODED_PIXELS = 40_000_000

# Verified against what Pillow can actually decode AND what the pipeline can
# use. SVG is absent because Pillow cannot open it at all. Every SVG upload
# 500'd for as long as the feature existed, while the UI advertised it.
ALLOWED_IMAGE_FORMATS = frozenset({"PNG", "JPEG", "WEBP", "GIF", "BMP"})


@contextmanager
def _strict_decode_limits():
    """Pin Pillow's two process-global decode switches for the duration of ONE
    decode, then put them back exactly as they were.

    Both are module-level globals on a shared library, so their value at any
    moment is whatever the last writer left, and a writer we do not control
    already exists: importing ``weasyprint`` (the invoice-PDF renderer) sets
    ``ImageFile.LOAD_TRUNCATED_IMAGES = True`` at import time, process-wide,
    for its own rendering needs. Any process that has rendered an invoice
    therefore stops rejecting truncated uploads, silently, and turns a corrupt
    file into a half-decoded image with the rest filled in.

    Today the API imports weasyprint only lazily, so the running API process
    happens not to be affected, but "happens not to be" is not a security
    boundary. It held only because a `from weasyprint import HTML` sits inside
    a function rather than at module scope, and it broke the test suite the
    moment everything was imported into one process.

    Restoring rather than merely setting matters too: this used to assign
    ``Image.MAX_IMAGE_PIXELS`` and leave it changed for the whole process, so a
    logo upload silently re-tuned the bomb guard for every other decode in the
    application.
    """
    prev_max_pixels = Image.MAX_IMAGE_PIXELS
    prev_truncated = ImageFile.LOAD_TRUNCATED_IMAGES
    Image.MAX_IMAGE_PIXELS = MAX_DECODED_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        yield
    finally:
        Image.MAX_IMAGE_PIXELS = prev_max_pixels
        ImageFile.LOAD_TRUNCATED_IMAGES = prev_truncated


def process_image_for_logo(file_data, target_size=(512, 512)):
    """
    Process image: Square center crop and resize to target_size.
    Returns bytes of the processed PNG.

    THIS is the security boundary for logo uploads, not the route's
    content-type check. That header is client-supplied and forgeable. What
    arrives here is arbitrary attacker-chosen bytes from an authenticated
    customer, so the format is established by DECODING, and the decode itself
    is bounded against a compression bomb.
    """
    with _strict_decode_limits():
        try:
            img = Image.open(io.BytesIO(file_data))
            # `open` is lazy, it reads the header and returns. Verifying the
            # format here would be checking a claim the file makes about itself
            # before anything has actually been decoded, so the real decode below
            # is what proves it.
            detected = (img.format or "").upper()
            if detected not in ALLOWED_IMAGE_FORMATS:
                raise UnsupportedImage(f"Unsupported image format: {detected or 'unrecognised'}")
            img.load()
        except Image.DecompressionBombError as exc:
            raise UnsupportedImage("Image dimensions are too large to process.") from exc
        except UnsupportedImage:
            raise
        except Exception as exc:
            # UnidentifiedImageError, truncated files, and anything else Pillow
            # throws on hostile input. The caller must not see a 500 for a file
            # the customer chose.
            raise UnsupportedImage("That file could not be read as an image.") from exc

    # Convert to RGBA if not already (to preserve transparency)
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    # Square center crop logic
    width, height = img.size
    min_dim = min(width, height)
    left = (width - min_dim) / 2
    top = (height - min_dim) / 2
    right = (width + min_dim) / 2
    bottom = (height + min_dim) / 2

    img = img.crop((left, top, right, bottom))

    # Resize with high-quality resampling
    img = img.resize(target_size, Image.Resampling.LANCZOS)

    # Save to bytes
    output = io.BytesIO()
    img.save(output, format="PNG", optimize=True)
    return output.getvalue()


# Initialize S3 client for Cloudflare R2 (S3-compatible)
s3_client = boto3.client(
    "s3",
    endpoint_url=f"https://{R2_ENDPOINT}",
    aws_access_key_id=R2_KEY_ID,
    aws_secret_access_key=R2_APPLICATION_KEY,
    region_name="auto",
    config=Config(signature_version="s3v4"),
)


def _build_public_url(key: str) -> str:
    """
    Build a public URL for the object.

    Cloudflare R2's S3 endpoint (`{account}.r2.cloudflarestorage.com`) is
    **private**. Anonymous GETs are rejected with `InvalidArgument /
    Authorization`. Public reads have to go through a bound custom domain
    (e.g. `cdn.oyechats.com`) or the bucket's `r2.dev` URL. Set
    `R2_PUBLIC_BASE_URL` to that domain and we use it first.

    Legacy fallback below builds Backblaze B2 "friendly URLs" when the
    endpoint matches that provider's pattern. Dead code on R2 but kept so
    older buckets keep working if `R2_ENDPOINT` still points at Backblaze.

    Last-resort fallback returns the S3-style path URL; it only loads if
    the bucket has been made publicly readable via that endpoint, which on
    R2 it never is, so callers should treat that fallback as broken and
    configure `R2_PUBLIC_BASE_URL`.
    """
    if R2_PUBLIC_BASE_URL:
        return f"{R2_PUBLIC_BASE_URL}/{key}"

    # Legacy: Backblaze B2 "friendly" host extracted from the endpoint host
    match = re.search(r"(\d{3,4})\.backblazeb2\.com", R2_ENDPOINT or "")
    if match:
        cluster_id = match.group(1)
        return f"https://f{cluster_id}.backblazeb2.com/file/{R2_BUCKET_NAME}/{key}"

    match = re.search(r"-(\d{3,4})\.", R2_ENDPOINT or "")
    if match:
        cluster_id = match.group(1)
        return f"https://f{cluster_id}.backblazeb2.com/file/{R2_BUCKET_NAME}/{key}"

    return f"https://{R2_ENDPOINT}/{R2_BUCKET_NAME}/{key}"


def get_signed_url(key: str, expires_in: int = 3600) -> str:
    """
    Generate a pre-signed URL for a private R2 object.
    Default expiry is 1 hour.
    """
    try:
        url = s3_client.generate_presigned_url(
            "get_object", Params={"Bucket": R2_BUCKET_NAME, "Key": key}, ExpiresIn=expires_in
        )
        return url
    except Exception as e:
        logger.error(f"Failed to generate signed URL for {key}: {e}")
        return _build_public_url(key)  # Fallback to public format


def get_object(key: str):
    """
    Fetch an object from R2 and return its body stream and content type.
    Raises ClientError if the object does not exist.
    """
    response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
    content_type = response.get("ContentType", "application/octet-stream")
    body = response["Body"]
    return body, content_type


def generate_presigned_put(key: str, content_type: str, expires: int = 300) -> str:
    """Generate a presigned PUT URL so the browser can upload directly to R2.

    The caller uploads via PUT to the returned URL (no auth headers needed).
    expires: seconds until the URL expires (default 5 minutes).

    NOTE: a presigned PUT signs only the Content-Type header, it cannot bound
    the uploaded body size. Prefer :func:`generate_presigned_post` for
    untrusted/browser uploads where a size ceiling must be enforced.
    """
    try:
        return s3_client.generate_presigned_url(
            "put_object",
            Params={"Bucket": R2_BUCKET_NAME, "Key": key, "ContentType": content_type},
            ExpiresIn=expires,
        )
    except Exception as e:
        logger.error(f"Failed to generate presigned PUT URL for {key}: {e}")
        raise


def generate_presigned_post(key: str, content_type: str, max_bytes: int, expires: int = 300) -> dict:
    """Generate a presigned POST for a direct browser upload with a
    **server-enforced size ceiling**.

    Unlike a presigned PUT (which cannot bound the body size), a presigned POST
    carries a policy with a ``content-length-range`` condition that R2 enforces
    at upload time, so a holder of the URL cannot store an arbitrarily large
    object. The Content-Type is likewise pinned by the policy.

    Returns ``{"url": ..., "fields": {...}}``; the browser POSTs a multipart form
    with those fields followed by the ``file`` field (which must be appended
    last per the S3 POST spec). ``expires`` is in seconds (default 5 minutes).
    """
    try:
        return s3_client.generate_presigned_post(
            Bucket=R2_BUCKET_NAME,
            Key=key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", 1, int(max_bytes)],
            ],
            ExpiresIn=expires,
        )
    except Exception as e:
        logger.error(f"Failed to generate presigned POST for {key}: {e}")
        raise


def upload_chat_file(file_data: bytes, original_filename: str, content_type: str | None) -> str:
    """Upload a chat attachment (image, PDF, etc.) to R2.

    Unlike upload_to_r2 (which crops/resizes logos), this preserves files as-is.
    Returns the R2 object key (e.g. 'chat-files/uuid.pdf').
    """
    unique_key = f"chat-files/{uuid.uuid4()}.{safe_object_extension(original_filename)}"

    # Never store a caller-supplied scriptable content type verbatim: an SVG or
    # HTML payload stored as its declared type could be served inline and
    # executed from the app origin (stored XSS). Unknown/scriptable types are
    # neutralized to application/octet-stream (NB-1).
    safe_content_type = _safe_chat_file_content_type(content_type)

    try:
        s3_client.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=unique_key,
            Body=file_data,
            ContentType=safe_content_type,
        )
        return unique_key
    except ClientError as e:
        logger.error(f"R2 chat file upload failed: {e}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error uploading chat file: {e}")
        raise


def upload_to_r2(file_data, filename, content_type):
    """
    Upload a logo image to Cloudflare R2 (S3-compatible).
    Square-crops + resizes to 512x512 PNG before uploading.
    Returns the R2 object key.
    """
    try:
        # Process image for consistency (Square crop + 512x512 PNG)
        # 512x512 ensures it looks great on BOTH 56x56 (launcher) and 40x40 (bot)
        processed_data = process_image_for_logo(file_data)

        # Generate a unique path for the logo (now always a .png)
        unique_filename = f"logos/{uuid.uuid4()}.png"

        # Upload the file
        s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=unique_filename, Body=processed_data, ContentType="image/png")

        # Return the key, the backend will construct full URLs via signed/public URL helpers.
        return unique_filename

    except ClientError as e:
        error_msg = (
            f"R2 upload failed (ClientError): {e.response['Error']['Message'] if 'Error' in e.response else str(e)}"
        )
        logger.error(error_msg)
        raise Exception(error_msg) from e
    except Exception as e:
        error_msg = f"Unexpected error during R2 upload: {str(e)}"
        logger.error(error_msg, exc_info=True)
        raise Exception(error_msg) from e


# Backwards-compatibility alias. Older imports may still call `upload_to_b2`.
upload_to_b2 = upload_to_r2


def upload_invoice_pdf(pdf_bytes: bytes, key: str) -> str:
    """Upload a rendered invoice PDF and return its public URL.

    The key must already carry its unguessable capability token (see
    ``worker.tasks._invoice_pdf_key``). Sequential serials alone would make
    customer invoices enumerable on the public CDN domain.
    """
    try:
        s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=pdf_bytes, ContentType="application/pdf")
        return _build_public_url(key)
    except ClientError as e:
        error_msg = (
            f"R2 invoice upload failed (ClientError): "
            f"{e.response['Error']['Message'] if 'Error' in e.response else str(e)}"
        )
        logger.error(error_msg)
        raise Exception(error_msg) from e
