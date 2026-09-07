"""The dedup-hash normaliser must drop volatile metadata and nothing else.

``_normalize_for_dedup_hash`` decides whether a re-crawled page is "unchanged"
(skipped, unbilled) or "changed" (re-ingested). It used to drop ANY line that
began with updated / published / posted / created / copyright, so "Updated
pricing: the Pro plan is now $99/month" hashed identically to the page before
the price change: the re-crawl skipped it and the customer's edit never reached
the knowledge base. Pure-function tests, no database and no network.
"""

import pytest

from app.ingestion.pipeline import _is_dedup_metadata_line, _normalize_for_dedup_hash, calculate_hash

# Lines that begin with a label word but carry substance. Every one of them
# must reach the hash, or an edit to it is invisible to the re-crawl.
KEPT = [
    "Updated pricing: the Pro plan is now $99/month (was $79).",
    "Created for teams of 5-50 people, our Growth plan includes SSO.",
    "Published research from our lab shows 3x faster onboarding.",
    "| Posted price | $49 |",
    # A month name inside prose is not a date line.
    "Updated guidance for March: our lab now supports 3 new assays.",
    # Copyright as a topic, not a notice: no year, so nothing volatile in it.
    "Copyright law protects original works of authorship.",
    # A percentage or a currency symbol is a price, whatever the line says.
    "Updated: 20% off until March 2026",
    "Posted: €49 on 2026-03-01",
    # Over the length cap: prose that happens to open with a label.
    "Updated " + "March 2026 " * 12,
]

# Pure metadata: a label plus a date-shaped remainder, or a copyright notice.
DROPPED = [
    "Last updated: 12 March 2026",
    "Published on March 3, 2026",
    "Updated 2 days ago",
    "© 2026 Acme Inc",
    "Posted: 2026-03-01",
    "Last modified 03/15/2026",
    "Created yesterday",
    "Updated just now",
    "Published on the 3rd of March, 2026 at 10:00 UTC",
    "Last reviewed: Jan 2026",
    "| Last updated | 12 March 2026 |",
    "> Posted an hour ago",
    "(c) 2026",
    "Copyright 2026 Acme Inc. All rights reserved.",
    # Long copyright footers are common and their year still flips every
    # January; the length cap must not apply to them.
    "Copyright © 2019-2026 Acme Inc. All rights reserved. Acme and the Acme logo are trademarks "
    "of Acme Inc. registered in the U.S. and other countries.",
]


@pytest.mark.parametrize("line", KEPT)
def test_substantive_lines_that_open_with_a_label_word_are_kept(line):
    assert not _is_dedup_metadata_line(line)


@pytest.mark.parametrize("line", DROPPED)
def test_date_shaped_metadata_lines_are_dropped(line):
    assert _is_dedup_metadata_line(line)


def _hash(page: str) -> str:
    return calculate_hash(_normalize_for_dedup_hash(page))


def test_a_price_change_flips_the_hash():
    """The regression: the price line was dropped wholesale, so the two pages
    hashed identically and the re-crawl skipped the new price."""
    before = "# Pricing\nUpdated pricing: the Pro plan is now $79/month.\nLast updated: 12 March 2026"
    after = "# Pricing\nUpdated pricing: the Pro plan is now $99/month (was $79).\nLast updated: 3 April 2026"
    assert _hash(before) != _hash(after)


def test_a_bumped_timestamp_alone_does_not_flip_the_hash():
    """The billing guarantee the normaliser exists for: a re-crawl that changed
    nothing but the footer date is free."""
    before = "# Pricing\nThe Pro plan is $99/month.\nLast updated: 12 March 2026\n© 2025 Acme Inc"
    after = "# Pricing\nThe Pro plan is $99/month.\nLast updated: 3 April 2026\n© 2026 Acme Inc"
    assert _hash(before) == _hash(after)


def test_a_long_copyright_footer_ticking_over_does_not_flip_the_hash():
    footer = (
        "Copyright © 2019-{year} Acme Inc. All rights reserved. Acme and the Acme logo are trademarks "
        "of Acme Inc. registered in the U.S. and other countries."
    )
    assert _hash("Body copy.\n" + footer.format(year=2025)) == _hash("Body copy.\n" + footer.format(year=2026))


def test_a_kept_label_line_still_has_its_date_normalised():
    """Keeping a line is safe because the date inside it is still replaced by
    ``<DATE>``; only the substantive words decide the hash."""
    before = "Published on March 3, 2026 by Jane Doe\nBody copy."
    after = "Published on April 9, 2026 by Jane Doe\nBody copy."
    assert _hash(before) == _hash(after)
    assert _hash(after) != _hash("Published on April 9, 2026 by John Roe\nBody copy.")


def test_only_the_metadata_lines_leave_the_hash_input():
    page = "# Pricing\nLast updated: 12 March 2026\nPro is $99.\nPublished on March 3, 2026 by Jane Doe\n© 2026 Acme"
    assert _normalize_for_dedup_hash(page) == "# Pricing\nPro is $99.\nPublished on <DATE> by Jane Doe"


def test_pages_that_differ_only_by_an_event_date_still_collide():
    """Pinned by ``test_crawl_ingest_accounting``: dates inside prose are
    normalised, and the per-URL scope of the lookup (not the hash) is what
    keeps two such pages apart."""
    spring = "# Quarterly Webinar\nJoin us on 2026-03-14 for the quarterly product webinar."
    summer = "# Quarterly Webinar\nJoin us on 2026-06-20 for the quarterly product webinar."
    assert _hash(spring) == _hash(summer)
