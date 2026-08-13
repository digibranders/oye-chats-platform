"""The document-upload rate, pinned: 1 credit per 250 words, rounded up.

This replaced a five-bucket word-tier table. That model needed its four
EXCLUSIVE boundaries restated in the customer-facing table in
``app/src/features/workspace/UsagePage.tsx``, which stated them INCLUSIVELY —
"Up to 100 words → 5 credits" — so every bounded boundary advertised one price
and charged the next bucket up, 3x at 100 words. Two representations of the
same pricing drifted because neither was pinned.

These tests pin the CHARGED side, and the last one pins the advertised side to
it: a rate has one number to keep in sync instead of eight, but it still has
that one.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import PricingConfig
from app.services.credit_service import (
    get_document_upload_cost_for_size,
    invalidate_pricing_cache,
)

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

WORDS_PER_CREDIT = 250


@pytest.fixture(autouse=True)
def _clean_pricing_cache():
    """The pricing cache is process-global with a 60s TTL.

    Tests here both depend on the shipped defaults and write overrides, so the
    cache is dropped on both sides of every one of them — otherwise an override
    outlives its test and prices the next one.
    """
    invalidate_pricing_cache()
    yield
    invalidate_pricing_cache()


def _override(db, key: str, value: object) -> None:
    """Write one pricing_config row the way the super-admin panel would."""
    db.merge(PricingConfig(key=key, value=value))
    db.commit()
    invalidate_pricing_cache()


@pytest.mark.parametrize(
    ("words", "expected", "why"),
    [
        (0, 1, "an empty doc still pays the per-file minimum"),
        (1, 1, "a one-word doc is one credit, not a fraction of one"),
        (249, 1, "still inside the first block"),
        (250, 1, "a whole block exactly — no rounding up onto a second credit"),
        (251, 2, "one word into the second block costs the whole block"),
        (500, 2, "two whole blocks"),
        (501, 3, "and one word past two blocks is three"),
        (10000, 40, "10,000 / 250 with nothing left over"),
        (10001, 41, "the remainder block is charged in full"),
    ],
)
def test_upload_cost_is_one_credit_per_250_words_rounded_up(db, words, expected, why):
    assert get_document_upload_cost_for_size(db, words) == expected, why


# The rate lives in pricing_config, not in a constant: the bucket table it
# replaced was editable from the super-admin pricing panel, and the flat rate
# has to stay editable too, or repricing uploads becomes a deploy.
@pytest.mark.parametrize(
    ("rate", "words", "expected"),
    [
        (500, 500, 1),  # halve the price: 500 words now fits one credit
        (500, 501, 2),
        (100, 250, 3),  # raise it: 250 words is three 100-word blocks
    ],
)
def test_a_super_admin_rate_override_is_honoured(db, rate, words, expected):
    _override(db, "credit_cost.document_upload_words_per_credit", rate)
    assert get_document_upload_cost_for_size(db, words) == expected


@pytest.mark.parametrize("broken", [0, -250, None, "lots", [250]])
def test_an_unusable_rate_fails_closed_to_the_shipped_default(db, broken):
    """A divisor of 0/null/garbage must not make uploads free (or crash).

    ``value`` in the pricing panel is an untyped JSONB field, so a super admin
    can save any of these. Falling back to the shipped 250 keeps charging;
    falling back to "no rate" would hand out free ingestion.
    """
    _override(db, "credit_cost.document_upload_words_per_credit", broken)
    assert get_document_upload_cost_for_size(db, 1000) == 4


def test_a_zeroed_minimum_never_makes_an_upload_free(db):
    """``credit_cost.document_upload`` is the per-file floor, not an opt-out."""
    _override(db, "credit_cost.document_upload", 0)
    assert get_document_upload_cost_for_size(db, 1) == 1


def test_the_advertised_rate_matches_the_charged_rate():
    """Reads the UI's own copy and checks it states the rate we charge.

    A comment saying "keep these in sync" is not a guard. The old bucket labels
    drifted from the backend precisely because nothing read them.
    """
    import re
    from pathlib import Path

    source = Path(__file__).resolve().parents[2] / "app" / "src" / "features" / "workspace" / "UsagePage.tsx"
    if not source.exists():  # pragma: no cover - the app tree is optional in some checkouts
        pytest.skip("admin app source not present")

    text = source.read_text()
    stated = re.search(r"(\d+) credits? per ([\d,]+) words", text)
    assert stated, "could not find the document-upload rate in the Usage page copy; did it move?"

    credits = int(stated.group(1))
    words = int(stated.group(2).replace(",", ""))
    assert (credits, words) == (1, WORDS_PER_CREDIT), (
        f"the Usage page advertises {credits} credit(s) per {words} words, but uploads are "
        f"charged 1 per {WORDS_PER_CREDIT}"
    )
