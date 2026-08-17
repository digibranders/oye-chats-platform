"""Cross-tenant isolation regression test for search_similar_documents (AR-21).

Before this fix, search_similar_documents' raw SQL filtered only on bot_id
when bot_id was provided — never AND-ing client_id even when both were
available, unlike search_keyword_documents and every other owner-scoped
query in this module (which route through `_owner_filter`'s bot_id AND
client_id defense-in-depth pattern). Not currently exploitable (bot_id and
client_id are both derived from the same authenticated Bot row on every
existing call path), but this is the single hottest query path in the
system — a future caller passing an attacker-influenced bot_id with a fixed
client_id would have had no second gate.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.models import Bot, Client, Document
from app.db.repository import (
    _owner_filter,
    get_ingested_documents,
    search_keyword_documents,
    search_similar_documents,
)

_seq = iter(range(1, 10_000))


def _make_client(db: Session) -> Client:
    n = next(_seq)
    client = Client(
        name=f"Isolation Test Client {n}",
        email=f"isolation{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"isolation-test-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db: Session, client: Client) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-isolation-{n}", name="Isolation Test Bot")
    db.add(bot)
    db.commit()
    return bot


def _unit_vector(dominant_dim: int, dim: int = 768) -> list[float]:
    vec = [0.0] * dim
    vec[dominant_dim % dim] = 1.0
    return vec


def _make_document(db: Session, client: Client, bot: Bot, content: str) -> Document:
    doc = Document(
        client_id=client.id,
        bot_id=bot.id,
        document_name=f"{content[:20]}.txt",
        source="upload",
        file_hash=f"hash-{bot.id}-{content[:8]}",
        content=content,
        embedding=_unit_vector(1),  # same embedding for both tenants — worst case for isolation
    )
    db.add(doc)
    db.commit()
    return doc


class TestSearchSimilarDocumentsClientIdAndFilter:
    def test_bot_id_and_client_id_both_scope_the_query(self, db):
        """The core AR-21 guarantee: passing bot_id AND client_id must never
        return a document belonging to a different client_id, even if (as a
        stand-in for a hypothetical future caller bug) the bot_id happened to
        collide or be attacker-influenced."""
        client_a = _make_client(db)
        client_b = _make_client(db)
        bot_a = _make_bot(db, client_a)
        _make_document(db, client_a, bot_a, "Client A secret pricing information")

        query_embedding = _unit_vector(1)

        # Correct tenant: bot_a + client_a — must find the document.
        results = search_similar_documents(db, bot_id=bot_a.id, client_id=client_a.id, query_embedding=query_embedding)
        assert len(results) == 1
        assert results[0][0].client_id == client_a.id

        # Mismatched tenant: bot_a (client_a's bot) queried with client_b's
        # client_id — must return nothing, proving the AND-filter is real
        # and not just bot_id being silently sufficient on its own.
        results = search_similar_documents(db, bot_id=bot_a.id, client_id=client_b.id, query_embedding=query_embedding)
        assert results == []

    def test_bot_id_only_still_works_unchanged(self, db):
        """Existing callers that only pass bot_id (no client_id) must see
        unchanged behavior — this fix is additive, not a breaking change."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_document(db, client, bot, "Some knowledge base content")

        results = search_similar_documents(db, bot_id=bot.id, query_embedding=_unit_vector(1))
        assert len(results) == 1

    def test_client_id_only_still_works_unchanged(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_document(db, client, bot, "Some other knowledge base content")

        results = search_similar_documents(db, client_id=client.id, query_embedding=_unit_vector(1))
        assert len(results) == 1


class TestOwnerFilterClientIdAndScope:
    """`_owner_filter` is the shared scope clause behind keyword search and every
    document-listing query. The AR-21 test above locks the same bot_id-AND-client_id
    defense-in-depth for the raw-SQL vector path only; these lock it for the
    ORM `_owner_filter` path, which no test previously exercised cross-tenant
    (mutations TI1/TI2 survived the original suite)."""

    def test_missing_scope_raises_loudly(self, db):
        """Neither bot_id nor client_id must fail loudly — falling through would
        emit ``client_id IS NULL`` and match legacy null-tenant rows (TI2)."""
        with pytest.raises(ValueError):
            _owner_filter(Document)

    def test_get_ingested_documents_requires_matching_client(self, db):
        """bot_id AND client_id: a mismatched client_id must scope the listing
        to empty even though the bot_id matches (TI1)."""
        client_a = _make_client(db)
        client_b = _make_client(db)
        bot_a = _make_bot(db, client_a)
        _make_document(db, client_a, bot_a, "Client A confidential onboarding doc")

        # Correct tenant sees its own source.
        own = get_ingested_documents(db, bot_id=bot_a.id, client_id=client_a.id)
        assert len(own) == 1

        # bot_a's id with the WRONG client_id must return nothing — proving the
        # client_id AND-clause is real, not bot_id silently sufficient on its own.
        cross = get_ingested_documents(db, bot_id=bot_a.id, client_id=client_b.id)
        assert cross == []

    def test_keyword_search_requires_matching_client(self, db):
        """The keyword (full-text) retrieval path must also enforce both ids."""
        client_a = _make_client(db)
        client_b = _make_client(db)
        bot_a = _make_bot(db, client_a)
        doc = _make_document(db, client_a, bot_a, "quarterly revenue pricing secret")
        # search_vector is not a generated column; populate it like ingestion does.
        db.execute(
            text("UPDATE documents SET search_vector = to_tsvector('english', content) WHERE id = :id"),
            {"id": doc.id},
        )
        db.commit()

        own = search_keyword_documents(db, bot_id=bot_a.id, client_id=client_a.id, query="pricing")
        assert len(own) == 1

        cross = search_keyword_documents(db, bot_id=bot_a.id, client_id=client_b.id, query="pricing")
        assert cross == []
