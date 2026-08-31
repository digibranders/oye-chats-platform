"""The trial's free crawl is an allowance of PAGES, not a whole free crawl.

It used to be a boolean: `first_training_free` made the account's first crawl
cost nothing, bounded only by the plan's 100-page ceiling. At 5 credits a page
that is 500 credits given away, which is the entire trial grant, so a customer
with a large site could be handed their whole budget in one crawl while a
customer with a small one got a fraction of the same offer.

It is now a fixed 25 pages. The first 25 crawl-sourced pages on the ACCOUNT are
free; everything past that is charged at the normal `url_scan` rate.

Two things this must get right, because both are money:

* **Pages, not chunks.** A crawled page becomes many `Document` rows, one per
  chunk, so counting rows would exhaust a 25-page allowance inside the first
  page or two. The count is `distinct(document_name)`, which is the page URL for
  a crawl, and is what the rest of the codebase already counts pages by.
* **Per account, not per bot.** `bot_id` is an OPTIONAL query parameter on every
  crawl route, so a per-bot allowance is farmable: one crawl with it omitted and
  one with it set are two scopes and both would come out free.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import Client, Document, Plan

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

FREE_PAGES = 25
URL_SCAN_COST = 5


def _plan(db, slug, *, free_pages=None):
    limits = {"bots": 1, "credits": 500, "max_crawl_pages": 100}
    if free_pages is not None:
        limits["free_training_pages"] = free_pages
    p = Plan(
        slug=slug,
        name=slug.title(),
        credits_per_month=500,
        monthly_price_cents=0,
        annual_price_cents=0,
        trial_days=14 if slug == "trial" else 0,
        is_default=slug == "trial",
        is_active=True,
        is_public=slug != "trial",
        sort_order=1,
        limits=limits,
        features={},
    )
    db.add(p)
    db.flush()
    return p


def _client_on(db, plan, email):
    from app.services.plan_service import assign_default_plan_to_client

    c = Client(name="T", email=email, api_key=f"k-{email}", hashed_password="h")
    db.add(c)
    db.flush()
    if plan.is_default:
        assign_default_plan_to_client(db, c.id)
    db.commit()
    return c


def _crawled_pages(db, client, urls):
    """One crawled page becomes several chunks, exactly as the pipeline writes."""
    for url in urls:
        for chunk in range(3):
            db.add(
                Document(
                    client_id=client.id,
                    document_name=url,
                    source="crawl",
                    file_hash=f"{url}-{chunk}",
                    content="x",
                    # NOT NULL on the model. The value is irrelevant here; what
                    # matters is that the row exists and names its page.
                    embedding=[0.0] * 768,
                )
            )
    db.flush()
    db.commit()


def test_a_fresh_trial_gets_exactly_twenty_five_free_pages(db):
    from app.api.document_routes import resolve_crawl_pricing

    plan = _plan(db, "trial", free_pages=FREE_PAGES)
    c = _client_on(db, plan, "fresh@example.com")

    cost, free = resolve_crawl_pricing(db, c.id, None)
    assert free == FREE_PAGES
    # The price is the normal one. Nothing is discounted; a page is either
    # inside the allowance or charged in full.
    assert cost == URL_SCAN_COST


def test_the_allowance_counts_pages_not_chunks(db):
    from app.api.document_routes import resolve_crawl_pricing

    plan = _plan(db, "trial", free_pages=FREE_PAGES)
    c = _client_on(db, plan, "chunks@example.com")
    # Ten pages, three chunks each. Counting rows would say 30 and wrongly
    # report the allowance spent.
    _crawled_pages(db, c, [f"https://acme.com/p{i}" for i in range(10)])

    _cost, free = resolve_crawl_pricing(db, c.id, None)
    assert free == FREE_PAGES - 10


def test_the_allowance_runs_out_and_does_not_go_negative(db):
    from app.api.document_routes import resolve_crawl_pricing

    plan = _plan(db, "trial", free_pages=FREE_PAGES)
    c = _client_on(db, plan, "spent@example.com")
    _crawled_pages(db, c, [f"https://acme.com/p{i}" for i in range(40)])

    _cost, free = resolve_crawl_pricing(db, c.id, None)
    assert free == 0


def test_a_plan_without_the_allowance_gets_none_of_it(db):
    from app.api.document_routes import resolve_crawl_pricing

    plan = _plan(db, "starter")  # no free_training_pages key at all
    c = Client(name="S", email="paid@example.com", api_key="k-paid", hashed_password="h")
    db.add(c)
    db.flush()
    from app.db.models import Subscription

    db.add(Subscription(client_id=c.id, plan_id=plan.id, status="active", billing_cycle="monthly"))
    db.commit()

    cost, free = resolve_crawl_pricing(db, c.id, None)
    assert free == 0
    assert cost == URL_SCAN_COST


def test_the_allowance_is_per_account_so_a_second_bot_cannot_refresh_it(db):
    from app.api.document_routes import resolve_crawl_pricing

    plan = _plan(db, "trial", free_pages=FREE_PAGES)
    c = _client_on(db, plan, "twobots@example.com")
    _crawled_pages(db, c, [f"https://acme.com/p{i}" for i in range(25)])

    # `bot_id` is an optional query param on every crawl route, so asking as a
    # different bot — or as none — must not hand the allowance back.
    for bot_id in (None, 1, 2):
        _cost, free = resolve_crawl_pricing(db, c.id, bot_id)
        assert free == 0, f"allowance reappeared for bot_id={bot_id}"


def test_an_uploaded_document_does_not_spend_the_allowance(db):
    """The predicate is crawl-sourced pages, not documents.

    A customer who uploaded a PDF on day one has not used any of their free
    website pages, and charging them for it would be the metering this exists
    to remove.
    """
    from app.api.document_routes import resolve_crawl_pricing

    plan = _plan(db, "trial", free_pages=FREE_PAGES)
    c = _client_on(db, plan, "upload@example.com")
    db.add(
        Document(
            client_id=c.id,
            document_name="handbook.pdf",
            source="upload",
            file_hash="h-upload",
            content="hello",
            embedding=[0.0] * 768,
        )
    )
    db.flush()
    db.commit()

    _cost, free = resolve_crawl_pricing(db, c.id, None)
    assert free == FREE_PAGES
