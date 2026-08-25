"""The platform's locale catalogue, served to the admin dashboard.

Phase 5A. Before this endpoint existed the dashboard carried its own hardcoded
copies of the locale list, and they drifted: the operator translation picker
offered twelve locales, seven of which no bot could be configured with, while
the conversation badge knew twenty-nine names the backend had never heard of.
``KNOWN_LOCALES`` is the single source of truth, and this is how it reaches the
browser.

The widget deliberately does NOT use this endpoint. It bundles its own copy
because it must render a locale's name and direction before any network call
resolves, on a customer's page. That pair is held together by parity tests
rather than by a request.
"""

import logging

from fastapi import APIRouter, Depends, Response

from app.api.auth import get_current_client_or_operator
from app.services.language_service import KNOWN_LOCALES, LANGUAGE_NAMES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/locales", tags=["locales"])

# Seconds the browser may reuse the catalogue for. It changes only when
# ``KNOWN_LOCALES`` changes, which is a deploy.
_CATALOG_MAX_AGE = 86400

# Built once per process: the catalogue is a module constant, so re-serialising
# it per request would buy nothing.
_CATALOG_PAYLOAD: dict[str, object] = {
    "locales": [info.model_dump() for info in KNOWN_LOCALES.values()],
    "languages": dict(LANGUAGE_NAMES),
}


@router.get("")
def list_locales(response: Response, auth=Depends(get_current_client_or_operator)):
    """Return every locale the platform supports.

    ``locales`` mirrors ``LocaleInfo`` field for field and is what a locale
    *selector* offers. ``languages`` maps a base language code to its display
    name, which is what a *conversation* carries: ``ChatSession.language_code``
    and ``ChatMessage.source_language`` are base codes, so a selector's
    locale-level names cannot label them.

    Authenticated because it is dashboard configuration data, not public widget
    config; the widget never calls it.
    """
    response.headers["Cache-Control"] = f"private, max-age={_CATALOG_MAX_AGE}"
    return _CATALOG_PAYLOAD
