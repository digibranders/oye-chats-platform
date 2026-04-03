import io
import logging
import re
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from PIL import Image

from app.config import B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_ENDPOINT, B2_KEY_ID

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


# Initialize S3 client for Backblaze B2
s3_client = boto3.client(
    "s3",
    endpoint_url=f"https://{B2_ENDPOINT}",
    aws_access_key_id=B2_KEY_ID,
    aws_secret_access_key=B2_APPLICATION_KEY,
    region_name=B2_ENDPOINT.split(".")[1] if hasattr(B2_ENDPOINT, "split") and "." in B2_ENDPOINT else "us-east-1",
    config=Config(signature_version="s3v4"),
)


def _build_public_url(key: str) -> str:
    """
    Build the Backblaze B2 'friendly' public URL.

    B2 supports 3 URL formats:
      1. S3 virtual-hosted: https://{bucket}.s3.{region}.backblazeb2.com/{key}
         → Requires specific B2 bucket settings, often fails with CORS/404
      2. S3 path-style:     https://s3.{region}.backblazeb2.com/{bucket}/{key}
         → Same issues as virtual-hosted
      3. Friendly URL:      https://f{cluster}.backblazeb2.com/file/{bucket}/{key}
         → Most reliable for public access, works if bucket is set to "Public"

    We use format #3 (friendly URL) for maximum reliability.

    B2_ENDPOINT example: "s3.eu-central-003.backblazeb2.com"
    → cluster = "003" → friendly host = "f003.backblazeb2.com"
    """
    # Extract cluster ID (e.g., "s3.eu-central-003.backblazeb2.com" -> cluster is "003")
    match = re.search(r"(\d{3,4})\.backblazeb2\.com", B2_ENDPOINT or "")
    if match:
        cluster_id = match.group(1)
        return f"https://f{cluster_id}.backblazeb2.com/file/{B2_BUCKET_NAME}/{key}"

    # Secondary check: look for digits after a hyphen
    match = re.search(r"-(\d{3,4})\.", B2_ENDPOINT or "")
    if match:
        cluster_id = match.group(1)
        return f"https://f{cluster_id}.backblazeb2.com/file/{B2_BUCKET_NAME}/{key}"

    return f"https://{B2_ENDPOINT}/{B2_BUCKET_NAME}/{key}"


def get_signed_url(key: str, expires_in: int = 3600) -> str:
    """
    Generate a pre-signed URL for a private B2 file.
    Default expiry is 1 hour.
    """
    try:
        url = s3_client.generate_presigned_url(
            "get_object", Params={"Bucket": B2_BUCKET_NAME, "Key": key}, ExpiresIn=expires_in
        )
        return url
    except Exception as e:
        logger.error(f"Failed to generate signed URL for {key}: {e}")
        return _build_public_url(key)  # Fallback to public format


def get_object(key: str):
    """
    Fetch an object from B2 and return its body stream and content type.
    Raises ClientError if the object does not exist.
    """
    response = s3_client.get_object(Bucket=B2_BUCKET_NAME, Key=key)
    content_type = response.get("ContentType", "application/octet-stream")
    body = response["Body"]
    return body, content_type


def generate_presigned_put(key: str, content_type: str, expires: int = 300) -> str:
    """Generate a presigned PUT URL so the browser can upload directly to B2.

    The caller uploads via PUT to the returned URL (no auth headers needed).
    expires: seconds until the URL expires (default 5 minutes).
    """
    try:
        return s3_client.generate_presigned_url(
            "put_object",
            Params={"Bucket": B2_BUCKET_NAME, "Key": key, "ContentType": content_type},
            ExpiresIn=expires,
        )
    except Exception as e:
        logger.error(f"Failed to generate presigned PUT URL for {key}: {e}")
        raise


def upload_chat_file(file_data: bytes, original_filename: str, content_type: str) -> str:
    """Upload a chat attachment (image, PDF, etc.) to B2.

    Unlike upload_to_b2 (which crops/resizes logos), this preserves files as-is.
    Returns the B2 object key (e.g. 'chat-files/uuid.pdf').
    """
    ext = original_filename.rsplit(".", 1)[-1].lower() if "." in original_filename else "bin"
    unique_key = f"chat-files/{uuid.uuid4()}.{ext}"

    try:
        s3_client.put_object(
            Bucket=B2_BUCKET_NAME,
            Key=unique_key,
            Body=file_data,
            ContentType=content_type,
        )
        return unique_key
    except ClientError as e:
        logger.error(f"B2 chat file upload failed: {e}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error uploading chat file: {e}")
        raise


def upload_to_b2(file_data, filename, content_type):
    """
    Upload a file to Backblaze B2 using the S3-compatible API.
    Returns the public 'friendly' URL of the uploaded file.
    """
    try:
        # Process image for consistency (Square crop + 512x512 PNG)
        # 512x512 ensures it looks great on BOTH 56x56 (launcher) and 40x40 (bot)
        processed_data = process_image_for_logo(file_data)

        # Generate a unique path for the logo (now always a .png)
        unique_filename = f"logos/{uuid.uuid4()}.png"

        # Upload the file
        s3_client.put_object(Bucket=B2_BUCKET_NAME, Key=unique_filename, Body=processed_data, ContentType="image/png")

        # Build a persistent backend URL that will handle the signing/redirecting
        # This prevents logos from breaking when a direct signed URL expires.
        # Format: /api/v1/files/logos/uuid.png (assuming we strip /api/v1 prefix in main.py if needed)
        # For now, let's keep it simple: return the key and let the backend construct the full URL.
        return unique_filename

    except ClientError as e:
        error_msg = (
            f"B2 Upload failed (ClientError): {e.response['Error']['Message'] if 'Error' in e.response else str(e)}"
        )
        logger.error(error_msg)
        raise Exception(error_msg) from e
    except Exception as e:
        error_msg = f"Unexpected error during B2 upload: {str(e)}"
        logger.error(error_msg, exc_info=True)
        raise Exception(error_msg) from e
