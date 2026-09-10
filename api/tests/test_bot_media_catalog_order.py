"""The bot-wide media catalog comes back in a stable order.

``get_bot_media_urls`` is ``SELECT DISTINCT metadata_info->'media_urls' ...
LIMIT :limit`` and had no ORDER BY, so Postgres returned rows in whatever order
the plan produced. Two consequences. The topical card matcher broke a relevance
tie by whichever asset arrived first, so two equally good SOAR documents on the
Eventus bot could swap between identical questions. And on a knowledge base with
more distinct media payloads than ``limit``, which 100 came back was arbitrary,
so an asset could be in the model's catalog on one turn and missing the next.

These insert the same catalog into two bots in opposite orders and require the
same result from both. That asserts the property that matters, determinism,
without restating how Postgres orders jsonb.
"""

from __future__ import annotations

from app.db.models import Document
from app.db.repository import get_bot_media_urls
from tests.test_pricing_gate_e2e import _make_bot, _make_client

_PAYLOADS = [{"files": [{"url": f"https://acme.com/uploads/doc-{i}.pdf", "name": f"doc-{i}.pdf"}]} for i in range(8)]


def _add_media(db, bot, client, payload, n):
    db.add(
        Document(
            client_id=client.id,
            bot_id=bot.id,
            document_name=f"https://acme.com/page-{n}",
            source="crawl",
            file_hash=f"catalog-order-{bot.id}-{n}",
            content="page text",
            source_char_count=9,
            embedding=[0.0] * 768,
            metadata_info={"media_urls": payload},
        )
    )
    db.commit()


def _two_bots_opposite_orders(db):
    forward_client, reverse_client = _make_client(db), _make_client(db)
    forward, reverse = _make_bot(db, forward_client), _make_bot(db, reverse_client)
    for n, payload in enumerate(_PAYLOADS):
        _add_media(db, forward, forward_client, payload, n)
    for n, payload in enumerate(reversed(_PAYLOADS)):
        _add_media(db, reverse, reverse_client, payload, n)
    return forward, reverse


def test_the_order_does_not_depend_on_insertion_order(db):
    forward, reverse = _two_bots_opposite_orders(db)

    assert get_bot_media_urls(db, bot_id=forward.id) == get_bot_media_urls(db, bot_id=reverse.id)


def test_every_payload_is_returned_once(db):
    forward, _ = _two_bots_opposite_orders(db)

    result = get_bot_media_urls(db, bot_id=forward.id)

    assert len(result) == len(_PAYLOADS)
    assert sorted(p["files"][0]["url"] for p in result) == sorted(p["files"][0]["url"] for p in _PAYLOADS)


def test_under_a_limit_the_same_subset_comes_back(db):
    """The case that was quietly arbitrary: more payloads than the limit."""
    forward, reverse = _two_bots_opposite_orders(db)

    assert get_bot_media_urls(db, bot_id=forward.id, limit=3) == get_bot_media_urls(db, bot_id=reverse.id, limit=3)


def test_repeated_calls_agree(db):
    forward, _ = _two_bots_opposite_orders(db)

    first = get_bot_media_urls(db, bot_id=forward.id)

    assert all(get_bot_media_urls(db, bot_id=forward.id) == first for _ in range(3))
