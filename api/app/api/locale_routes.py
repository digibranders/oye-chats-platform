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

import hashlib
import json
import logging

from fastapi import APIRouter, Depends, Request, Response

from app.api.auth import get_current_client_or_operator
from app.services.language_service import KNOWN_LOCALES, LANGUAGE_NAMES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/locales", tags=["locales"])

# Built once per process: the catalogue is a module constant, so re-serialising
# it per request would buy nothing.
_CATALOG_PAYLOAD: dict[str, object] = {
    "locales": [info.model_dump() for info in KNOWN_LOCALES.values()],
    "languages": dict(LANGUAGE_NAMES),
}

# The catalogue's identity is a hash of its own content, so a deploy that
# changes ``KNOWN_LOCALES`` changes the tag and every browser notices.
#
# This replaced ``max-age=86400``. That header was reasoned as "it changes only
# on a deploy" and drew the wrong conclusion from it: the URL never changes, so
# nothing could tell a browser the deploy had happened. When the 17 translated
# languages were switched on, every dashboard that had loaded this endpoint in
# the previous 24 hours kept offering the old four, and no refresh helped -
# a browser serves a fresh-by-max-age response without asking.
_CATALOG_ETAG = '"{}"'.format(
    hashlib.sha256(json.dumps(_CATALOG_PAYLOAD, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:32]
)


@router.get("")
def list_locales(
    request: Request,
    response: Response,
    auth=Depends(get_current_client_or_operator),
):
    """Return every locale the platform supports.

    ``locales`` mirrors ``LocaleInfo`` field for field and is what a locale
    *selector* offers. ``languages`` maps a base language code to its display
    name, which is what a *conversation* carries: ``ChatSession.language_code``
    and ``ChatMessage.source_language`` are base codes, so a selector's
    locale-level names cannot label them.

    Authenticated because it is dashboard configuration data, not public widget
    config; the widget never calls it.
    """
    # `no-cache` does NOT mean "do not store". It means "store it, but ask me
    # before reusing it". With the ETag above that costs one conditional request
    # and a 304 in the common case, and it is the difference between a language
    # going live on deploy and going live a day later.
    headers = {"ETag": _CATALOG_ETAG, "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == _CATALOG_ETAG:
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return _CATALOG_PAYLOAD
