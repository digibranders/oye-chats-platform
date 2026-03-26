"""
Langfuse v4 client utilities for LLM observability.

Uses the @observe decorator and context manager APIs (OpenTelemetry-based).
Graceful no-op when LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are not set.
"""

import logging
from typing import Optional

from app.config import LANGFUSE_ENABLED

logger = logging.getLogger(__name__)


def get_langfuse():
    """
    Return the Langfuse client singleton, or None if disabled.

    In v4, use `langfuse.get_client()` which reads env vars automatically.
    We only return it if LANGFUSE_ENABLED is True.
    """
    if not LANGFUSE_ENABLED:
        return None

    try:
        from langfuse import get_client
        return get_client()
    except ImportError:
        logger.warning("langfuse package not installed. Observability disabled.")
        return None
    except Exception as e:
        logger.error(f"Failed to get Langfuse client: {type(e).__name__}: {e}")
        return None


def flush_langfuse() -> None:
    """Flush any buffered Langfuse events. Call on app shutdown."""
    lf = get_langfuse()
    if lf is not None:
        try:
            lf.flush()
            logger.info("Langfuse events flushed successfully")
        except Exception as e:
            logger.warning(f"Langfuse flush failed: {e}")
