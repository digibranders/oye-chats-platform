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

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from PIL import Image

from app.config import R2_APPLICATION_KEY, R2_BUCKET_NAME, R2_ENDPOINT, R2_KEY_ID

logger = logging.getLogger(__name__)


def process_image_for_logo(file_data, target_size=(512, 512)):
    """
    Process image: Square center crop and resize to target_size.
    Returns bytes of the processed PNG.
    """
    img = Image.open(io.BytesIO(file_data))

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
    region_name=R2_ENDPOINT.split(".")[1] if hasattr(R2_ENDPOINT, "split") and "." in R2_ENDPOINT else "auto",
    config=Config(signature_version="s3v4"),
)


def _build_public_url(key: str) -> str:
    """
    Build a public URL for the object.

    On Cloudflare R2 we fall through to the path-style S3 URL —
    `https://{R2_ENDPOINT}/{R2_BUCKET_NAME}/{key}` — which works for buckets
    exposed via the configured endpoint.

    The two regex branches below are legacy fallbacks that build Backblaze B2
    "friendly URLs" when the endpoint matches that provider's pattern. They
    are dead code on R2 but kept so older buckets keep working if `R2_ENDPOINT`
    still points at Backblaze.
    """
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


def upload_chat_file(file_data: bytes, original_filename: str, content_type: str) -> str:
    """Upload a chat attachment (image, PDF, etc.) to R2.

    Unlike upload_to_r2 (which crops/resizes logos), this preserves files as-is.
    Returns the R2 object key (e.g. 'chat-files/uuid.pdf').
    """
    ext = original_filename.rsplit(".", 1)[-1].lower() if "." in original_filename else "bin"
    unique_key = f"chat-files/{uuid.uuid4()}.{ext}"

    try:
        s3_client.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=unique_key,
            Body=file_data,
            ContentType=content_type,
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

        # Return the key — the backend will construct full URLs via signed/public URL helpers.
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


# Backwards-compatibility alias — older imports may still call `upload_to_b2`.
upload_to_b2 = upload_to_r2
