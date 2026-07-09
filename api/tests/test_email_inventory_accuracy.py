"""Guard: keep emails/EMAIL_INVENTORY.md in lock-step with the actual senders.

The inventory doc is only useful if it's true. These tests fail whenever the set
of email-sending functions in ``app.services.email_service`` drifts from what the
doc documents — in either direction:

* a NEW ``send_*`` sender is added but not written up in the inventory, or
* the inventory references a ``send_*`` sender that has been removed/renamed.

When this test fails, update ``api/emails/EMAIL_INVENTORY.md`` (and, if the change
adds/removes a customer-visible email, the gallery in ``api/emails/gallery/`` and
its generator ``scripts/build_email_gallery.py``) so everything agrees again.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import app.services.email_service as es

INVENTORY = Path(__file__).resolve().parent.parent / "emails" / "EMAIL_INVENTORY.md"

# Low-level dispatch/plumbing helpers — these SEND, but they are not themselves a
# distinct email "type"; every real email routes through one of them. They are
# intentionally excluded from the documented catalogue.
PLUMBING: frozenset[str] = frozenset(
    {
        "send_email_async",
        "send_template_async",
        "send_email_to_multiple",
        "send_template_to_multiple",
    }
)


def _public_senders() -> set[str]:
    """Every user-facing ``send_*`` email function defined in email_service."""
    senders: set[str] = set()
    for name, obj in inspect.getmembers(es, inspect.isfunction):
        # Only functions actually defined in email_service (not imported symbols).
        if getattr(obj, "__module__", None) != es.__name__:
            continue
        if name.startswith("send_") and name not in PLUMBING:
            senders.add(name)
    return senders


def _senders_referenced_in_doc() -> set[str]:
    """`send_*` function names the inventory doc mentions (minus plumbing)."""
    text = INVENTORY.read_text(encoding="utf-8")
    # \b before send_ ensures we don't match task_send_* worker wrappers, since an
    # underscore is a word char (no boundary between "_" and "send").
    referenced = set(re.findall(r"\bsend_[a-z0-9_]+", text))
    return referenced - set(PLUMBING)


def test_inventory_file_exists() -> None:
    assert INVENTORY.is_file(), f"Email inventory missing at {INVENTORY}"


def test_every_sender_is_documented() -> None:
    """No email may be sent without a line in the inventory."""
    undocumented = sorted(fn for fn in _public_senders() if fn not in INVENTORY.read_text(encoding="utf-8"))
    assert not undocumented, (
        "These email senders exist in app/services/email_service.py but are NOT "
        f"documented in emails/EMAIL_INVENTORY.md: {undocumented}. "
        "Add each one to the inventory (and, if customer-visible, the gallery)."
    )


def test_no_stale_senders_documented() -> None:
    """The inventory must not reference senders that no longer exist."""
    stale = sorted(_senders_referenced_in_doc() - _public_senders())
    assert not stale, (
        "emails/EMAIL_INVENTORY.md references email senders that no longer exist "
        f"in app/services/email_service.py: {stale}. "
        "Remove or rename them in the inventory."
    )


def test_inventory_states_the_sender_count() -> None:
    """The '19 distinct emails' headline count must match reality.

    Keeps the summary honest: if the count in the doc and the real number of
    senders diverge, one of them is wrong.
    """
    actual = len(_public_senders())
    text = INVENTORY.read_text(encoding="utf-8")
    claimed = {int(m) for m in re.findall(r"(\d+)\s+distinct emails", text)}
    assert claimed == {actual}, (
        f"Inventory claims {claimed or 'no'} distinct emails but "
        f"email_service defines {actual}. Update the count in EMAIL_INVENTORY.md."
    )
