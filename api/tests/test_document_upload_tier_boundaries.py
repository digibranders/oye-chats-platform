"""The document-upload price boundaries, pinned.

``max_words`` in ``credit_cost.document_upload_tiers`` is EXCLUSIVE, but the
customer-facing table in ``app/src/features/workspace/UsagePage.tsx`` was
labelled inclusively — "Up to 100 words → 5 credits". Every one of the four
bounded boundaries therefore advertised one price and charged the next tier up,
3x at 100 words. Two representations of the same pricing drifted because
neither was pinned.

These tests pin the CHARGED side. The labels are stated to match; if the caps
here ever move, the labels move with them.
"""

from __future__ import annotations

import os

import pytest

from app.services.credit_service import get_document_upload_cost_for_size

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.mark.parametrize(
    ("words", "expected", "why"),
    [
        # Just below each cap — the tier the customer was quoted.
        (0, 5, "an empty doc still costs the entry tier"),
        (99, 5, "under 100"),
        (499, 15, "under 500"),
        (1999, 30, "under 2,000"),
        (9999, 75, "under 10,000"),
        # ON each cap — exclusive, so these fall into the NEXT tier. This is
        # the exact set of inputs the old inclusive labels mispriced.
        (100, 15, "exactly 100 is NOT 'up to 100'"),
        (500, 30, "exactly 500 is NOT '100-500'"),
        (2000, 75, "exactly 2,000 is NOT '500-2,000'"),
        (10000, 150, "exactly 10,000 is NOT '2,000-10,000'"),
        # Past the last bounded tier.
        (50000, 150, "the catch-all tier"),
    ],
)
def test_upload_cost_at_and_around_every_tier_boundary(db, words, expected, why):
    assert get_document_upload_cost_for_size(db, words) == expected, why


def test_the_advertised_labels_match_the_charged_tiers():
    """Reads the UI's own tier labels and re-derives the boundary from them.

    A comment saying "keep these in sync" is not a guard. This parses the
    labels out of the React source and checks each stated upper bound is one
    below a real cap — so relabelling them inclusively again fails here.
    """
    import re
    from pathlib import Path

    source = Path(__file__).resolve().parents[2] / "app" / "src" / "features" / "workspace" / "UsagePage.tsx"
    if not source.exists():  # pragma: no cover - the app tree is optional in some checkouts
        pytest.skip("admin app source not present")

    text = source.read_text()
    labels = re.findall(r"\{ label: '([^']+ words)', cost: (\d+) \}", text)
    assert labels, "could not find the document-upload tier labels; did they move?"

    # Each bounded label must describe a range that ENDS one below a cap.
    # Two phrasings are legitimate and they mean different things:
    #   "Under 100 words"  — 100 is stated exclusively, so the cap IS 100.
    #   "100–499 words"    — 499 is stated inclusively, so the cap is 499 + 1.
    # The bug this guards against is writing the second form with the cap
    # itself ("100–500"), which advertises a price the boundary does not pay.
    caps = {100, 500, 2000, 10000}
    checked = 0
    for label, _cost in labels:
        bounds = [int(n.replace(",", "")) for n in re.findall(r"[\d,]+", label)]
        if "+" in label or not bounds:
            continue  # the catch-all tier has no upper bound to check
        implied_cap = bounds[-1] if label.lower().startswith("under") else bounds[-1] + 1
        assert implied_cap in caps, (
            f"label {label!r} implies a tier cap of {implied_cap}, which is not one of "
            f"{sorted(caps)} — an inclusive label like '100–500' overcharges at that boundary"
        )
        checked += 1
    assert checked == len(caps), f"expected to check {len(caps)} bounded labels, checked {checked}"
