"""The document-upload rate, pinned: 1 credit per 250 words, rounded up.

This replaced a five-bucket word-tier table. That model needed its four
EXCLUSIVE boundaries restated in the customer-facing table in
``app/src/features/workspace/UsagePage.tsx``, which stated them INCLUSIVELY
("Up to 100 words → 5 credits") so every bounded boundary advertised one price
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
    cache is dropped on both sides of every one of them. Otherwise an override
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
        (250, 1, "a whole block exactly, no rounding up onto a second credit"),
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


def test_the_rate_is_served_to_the_client_not_reprinted_by_it(db):
    """The advertised rate and the charged rate are the same value, once.

    This used to grep ``UsagePage.tsx`` for the string "1 credit per 250 words",
    because the console printed the rate as prose and nothing tied the two
    together — the five-bucket table it replaced had drifted from the backend
    for exactly that reason. Pinning a literal across two repositories only
    moves the drift into the test: the console rebuild dropped the sentence and
    the guard failed, while the real defect was that a customer could no longer
    see what an upload costs at all.

    So the rate is now *served*. ``GET /credits/balance`` carries
    ``document_upload_words_per_credit`` out of the same ``pricing_config`` key
    ``get_document_upload_cost_for_size`` charges from, and the console renders
    what it is given. There is one number, in one place, and a super-admin who
    retunes it moves the price and the copy together.

    What this test pins is that the value reaching the client is the value that
    charges — including when it has been overridden, which is the case the old
    grep could never have caught.
    """
    from app.api.subscription_routes import _credit_costs_payload

    served = _credit_costs_payload(db)
    assert "document_upload_words_per_credit" in served, (
        "GET /credits/balance no longer serves the document-upload rate; the console "
        "cannot state what an upload costs without it"
    )
    assert served["document_upload_words_per_credit"] == WORDS_PER_CREDIT

    # An override moves both halves, which is the whole point of serving it.
    _override(db, "credit_cost.document_upload_words_per_credit", 500)
    assert _credit_costs_payload(db)["document_upload_words_per_credit"] == 500
    # 2 credits for 1000 words at 1-per-500, plus the per-file floor.
    assert get_document_upload_cost_for_size(db, 1000) == 2 + get_document_upload_cost_for_size(db, 1) - 1


def test_a_broken_rate_override_is_never_served_as_free(db):
    """A super-admin can save anything into the untyped JSONB ``value``.

    Serving 0 or a negative rate would render in the console as "1 credit per 0
    words" or worse be read as free, beside an action that still charges. The
    payload must fall back to the shipped rate exactly as the deduction does.
    """
    from app.api.subscription_routes import _credit_costs_payload

    for broken in (0, -1, "not a number", None):
        _override(db, "credit_cost.document_upload_words_per_credit", broken)
        assert _credit_costs_payload(db)["document_upload_words_per_credit"] == WORDS_PER_CREDIT


def test_a_zeroed_floor_is_never_advertised_below_what_an_upload_charges(db):
    """The floor the console prints is the floor the deduction applies.

    ``credit_cost.document_upload`` is the per-file minimum and, like the rate,
    it is untyped JSONB a super admin can save as ``0``.
    ``get_document_upload_cost_for_size`` clamps it to at least 1 credit (see
    ``test_a_zeroed_minimum_never_makes_an_upload_free``), but the balance
    payload used to serve the raw config value beside it — so the console
    advertised a free upload that ingestion still charged for. That is the same
    price/charge divergence the rate above exists to prevent, one field over.
    """
    from app.api.subscription_routes import _credit_costs_payload

    _override(db, "credit_cost.document_upload", 0)
    served = _credit_costs_payload(db)["document_upload"]
    # An empty document is charged exactly the floor, so it reads the clamped
    # value straight out of the charge path rather than restating the clamp.
    assert served == get_document_upload_cost_for_size(db, 0)
    assert served == 1, "a zeroed floor must reach the console as the 1 credit it actually costs"


@pytest.mark.parametrize("broken", [-3, None, "free", [0]])
def test_an_unusable_floor_is_served_as_what_it_charges(db, broken):
    from app.api.subscription_routes import _credit_costs_payload

    _override(db, "credit_cost.document_upload", broken)
    assert _credit_costs_payload(db)["document_upload"] == get_document_upload_cost_for_size(db, 0)


def test_a_real_floor_override_moves_both_halves(db):
    """The clamp must not flatten a legitimate super-admin price to 1."""
    from app.api.subscription_routes import _credit_costs_payload

    _override(db, "credit_cost.document_upload", 7)
    assert _credit_costs_payload(db)["document_upload"] == 7
    assert get_document_upload_cost_for_size(db, 1) == 7
