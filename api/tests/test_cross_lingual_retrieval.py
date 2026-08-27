"""Cross-lingual retrieval integration tests (Phase 3 gap fix).

These exercise the REAL vector-search SQL against a real throwaway Postgres +
pgvector database (the same `pg_engine`/`db` fixture pattern as
test_retrieval_tenant_isolation.py), not a mocked search function. That
matters here specifically: Phase 3's cross-lingual claim is a statement about
what pgvector's `<=>` cosine-distance operator actually returns at a given
threshold, and a mock cannot prove or disprove that.

`gemini-embedding-001` itself is NOT called. Live embedding calls would make
this test non-deterministic, slow, and dependent on network/API-key
availability in CI, none of which any other test in this suite does either
(test_retrieval_tenant_isolation.py uses the same synthetic-unit-vector
pattern). Instead, the English document and the "Hindi query" are given
synthetic embeddings placed at a PRECISELY KNOWN cosine distance from each
other, math.acos/cos-derived so pgvector's own distance computation is being
tested, not a hand-typed approximation. What is real: the SQL, the ORDER BY,
the WHERE threshold clause, and pgvector's distance arithmetic.

Covers:
  - a known English chunk retrieved for a semantically-equivalent Hindi query,
    at the exact distance the cross-lingual relaxation is calibrated for
  - the same pair REJECTED under the English-tuned default threshold (0.78),
    proving the relaxation is load-bearing, not a no-op
  - the same pair ACCEPTED under CROSS_LINGUAL_MAX_DISTANCE (0.85), through
    BOTH repository.search_similar_documents directly AND rag_service's
    _vector_search wrapper (the actual function the pipeline calls)
  - pure-Devanagari keyword-arm behaviour (zero hits, documented degradation)
  - code-switched keyword-arm behaviour: CORRECTS an earlier assumption that
    an embedded English/Latin token would still match. It does not.
    plainto_tsquery ANDs every extracted lexeme, so a Devanagari filler word
    anywhere in the query defeats the match even when the English token is
    itself present in the document. See TestKeywordArmCrossLingualBehavior's
    docstring for the full explanation, verified against the live
    plainto_tsquery output, not assumed.
"""

import math

from sqlalchemy import text

from app.db.models import Bot, Client, Document
from app.db.repository import search_keyword_documents, search_similar_documents
from app.services.rag_service import CROSS_LINGUAL_MAX_DISTANCE, _vector_search

_seq = iter(range(1, 10_000))
_DIM = 768


def _make_client(db):
    n = next(_seq)
    client = Client(
        name=f"XLingual Test Client {n}",
        email=f"xlingual{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"xlingual-test-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client):
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-xlingual-{n}", name="XLingual Test Bot")
    db.add(bot)
    db.commit()
    return bot


def _unit_vector(dominant_dim: int, dim: int = _DIM) -> list[float]:
    vec = [0.0] * dim
    vec[dominant_dim % dim] = 1.0
    return vec


def _vector_at_cosine_distance(base: list[float], cosine_distance: float, dim: int = _DIM) -> list[float]:
    """A unit vector at EXACTLY ``cosine_distance`` from ``base`` (also unit).

    ``base`` is assumed to be the standard basis vector e0 (as `_unit_vector(0)`
    produces). The result mixes e0 and e1 so that
    ``dot(base, result) == 1 - cosine_distance``, which for two unit vectors
    IS pgvector's cosine distance (``<=>``). Verified against the live SQL
    computation in ``test_pgvector_computes_the_expected_distance`` below,
    rather than trusted as a hand-derived formula.
    """
    cos_sim = 1.0 - cosine_distance
    cos_sim = max(-1.0, min(1.0, cos_sim))
    vec = [0.0] * dim
    vec[0] = cos_sim
    vec[1] = math.sqrt(max(0.0, 1.0 - cos_sim * cos_sim))
    return vec


def _make_document(db, client, bot, content: str, embedding: list[float]) -> Document:
    n = next(_seq)
    doc = Document(
        client_id=client.id,
        bot_id=bot.id,
        document_name=f"doc-{n}.txt",
        source="upload",
        file_hash=f"hash-xlingual-{n}",
        content=content,
        embedding=embedding,
    )
    db.add(doc)
    db.commit()
    return doc


def _populate_search_vector(db, doc: Document) -> None:
    """Mirror ingestion: search_vector is not a generated column."""
    db.execute(
        text("UPDATE documents SET search_vector = to_tsvector('english', content) WHERE id = :id"),
        {"id": doc.id},
    )
    db.commit()


class TestPgvectorDistanceSanity:
    """Confirms our synthetic-vector construction actually produces the
    distance pgvector computes, before trusting any test built on top of it."""

    def test_pgvector_computes_the_expected_distance(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        base = _unit_vector(0)
        target_distance = 0.80
        query = _vector_at_cosine_distance(base, target_distance)
        _make_document(db, client, bot, "distance sanity check document", embedding=base)

        # max_distance=2.0 admits everything; we read the raw computed distance.
        results = search_similar_documents(
            db, bot_id=bot.id, client_id=client.id, query_embedding=query, max_distance=2.0
        )
        assert len(results) == 1
        _doc, distance = results[0]
        assert math.isclose(distance, target_distance, abs_tol=1e-6), (
            f"expected pgvector cosine distance {target_distance}, got {distance}"
        )


class TestCrossLingualVectorRetrieval:
    """The actual Phase 3 acceptance case: a Hindi query retrieves an English
    chunk, at a distance that requires the cross-lingual relaxation to admit."""

    def _setup_pair(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        english_embedding = _unit_vector(0)
        # 0.80: strictly between the English-tuned default (0.78, EXCLUDES it)
        # and CROSS_LINGUAL_MAX_DISTANCE (0.85, INCLUDES it). Not tuned to the
        # edge; comfortable margin on both sides so this is not a
        # floating-point-flaky boundary test.
        hindi_query_embedding = _vector_at_cosine_distance(english_embedding, 0.80)
        doc = _make_document(
            db,
            client,
            bot,
            "Our Enterprise plan includes SSO, priority support, and a dedicated account manager.",
            embedding=english_embedding,
        )
        return client, bot, doc, hindi_query_embedding

    def test_default_english_tuned_threshold_rejects_the_cross_lingual_pair(self, db):
        """Proves the relaxation is load-bearing: without it, a real
        cross-lingual match this close is thrown away by the English-tuned
        default (0.78), which is exactly the failure mode Phase 3 documents
        (_no_info_pivot firing more often for non-English visitors)."""
        client, bot, _doc, query = self._setup_pair(db)

        results = search_similar_documents(db, bot_id=bot.id, client_id=client.id, query_embedding=query)
        assert results == []

    def test_cross_lingual_max_distance_admits_the_match_via_repository(self, db):
        """The real repository function, called with the exact constant
        rag_service uses for a non-English session."""
        client, bot, doc, query = self._setup_pair(db)

        results = search_similar_documents(
            db,
            bot_id=bot.id,
            client_id=client.id,
            query_embedding=query,
            max_distance=CROSS_LINGUAL_MAX_DISTANCE,
        )
        assert len(results) == 1
        found_doc, distance = results[0]
        assert found_doc.id == doc.id
        assert "Enterprise plan" in found_doc.content
        assert distance < CROSS_LINGUAL_MAX_DISTANCE

    def test_cross_lingual_max_distance_admits_the_match_via_pipeline_wrapper(self, db):
        """The actual function rag_pipeline_stream/rag_pipeline call
        (rag_service._vector_search), not the repository function directly.
        This is the real, unmocked path from a non-English session down to
        pgvector."""
        client, bot, doc, query = self._setup_pair(db)

        # English/disabled path: no override, same as every existing bot today.
        default_results = _vector_search(client.id, bot.id, query, k=15)
        assert default_results == []

        # Non-English session path: exactly what chat_routes/rag_service pass
        # when _lang_is_non_english(language) is True.
        relaxed_results = _vector_search(client.id, bot.id, query, k=15, max_distance=CROSS_LINGUAL_MAX_DISTANCE)
        assert len(relaxed_results) == 1
        found_doc, _distance = relaxed_results[0]
        assert found_doc.id == doc.id


class TestKeywordArmCrossLingualBehavior:
    """The keyword arm's real, verified degradation for non-English queries.

    CORRECTION vs. the original Phase 3 plan/comments: the assumption was that
    a code-switched query ("मुझे pricing चाहिए") would still hit the keyword arm
    on its embedded English token, so the degradation was "partial" rather than
    total. That assumption is FALSE, disproven here against real Postgres.

    ``search_keyword_documents`` compiles to
    ``search_vector @@ plainto_tsquery('english', query)``, and
    ``plainto_tsquery`` ANDs together every lexeme it extracts from the input,
    including untranslated Devanagari words (Postgres's 'english' text-search
    config still tokenizes non-Latin scripts as generic word lexemes; it just
    doesn't stem or stopword them). So `मुझे pricing चाहिए` compiles to
    `'मुझे' & 'price' & 'चाहिए'` — three ANDed terms — and the match fails
    whenever ANY of them is absent from the document's tsvector, which two of
    them always will be for an English-only knowledge base. The keyword arm
    therefore contributes ZERO hits for essentially any multi-word,
    non-English visitor message, not only pure-script ones. The corrected
    behaviour is verified below with the actual `plainto_tsquery` output
    inline, not asserted from memory.
    """

    def test_pure_devanagari_query_yields_no_keyword_hits(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        doc = _make_document(
            db,
            client,
            bot,
            "Our premium pricing plans start at $49 per month for the Pro tier.",
            embedding=_unit_vector(0),
        )
        _populate_search_vector(db, doc)

        # "हमारी प्रीमियम मूल्य निर्धारण योजनाएं क्या हैं" -- no Latin tokens at all.
        results = search_keyword_documents(
            db, bot_id=bot.id, client_id=client.id, query="हमारी प्रीमियम मूल्य निर्धारण योजनाएं क्या हैं"
        )
        assert results == []

    def test_code_switched_query_also_yields_no_keyword_hits(self, db):
        """The corrected finding. A code-switched sentence carrying one real
        English token that IS in the document still returns ZERO hits, because
        plainto_tsquery ANDs it with the surrounding Devanagari tokens, which
        are NOT in an English-only document's tsvector."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        doc = _make_document(
            db,
            client,
            bot,
            "Our premium pricing plans start at $49 per month for the Pro tier.",
            embedding=_unit_vector(0),
        )
        _populate_search_vector(db, doc)

        # Confirm the actual compiled query before asserting on its effect,
        # so this test documents WHY it fails, not just THAT it fails.
        compiled = db.execute(text("SELECT plainto_tsquery('english', :q)::text"), {"q": "मुझे pricing चाहिए"}).scalar()
        assert compiled == "'मुझे' & 'price' & 'चाहिए'"

        results = search_keyword_documents(db, bot_id=bot.id, client_id=client.id, query="मुझे pricing चाहिए")
        assert results == []

    def test_isolated_english_token_with_no_other_lexeme_does_match(self, db):
        """The one case where an English word DOES survive from a
        code-switched message: when it is the ONLY content the query
        contributes (e.g. the visitor's whole reply is just "pricing?"),
        which is really the pure-English case, not genuine code-switching."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        doc = _make_document(
            db,
            client,
            bot,
            "Our premium pricing plans start at $49 per month for the Pro tier.",
            embedding=_unit_vector(0),
        )
        _populate_search_vector(db, doc)

        results = search_keyword_documents(db, bot_id=bot.id, client_id=client.id, query="pricing?")
        assert len(results) == 1
        assert results[0][0].id == doc.id

    def test_pure_english_query_matches_normally_unaffected(self, db):
        """Sanity control: the keyword arm's ordinary English behaviour, the
        thing every existing (multilingual-disabled) bot relies on, must be
        completely unaffected by anything Phase 3 changed."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        doc = _make_document(
            db,
            client,
            bot,
            "Our premium pricing plans start at $49 per month for the Pro tier.",
            embedding=_unit_vector(0),
        )
        _populate_search_vector(db, doc)

        results = search_keyword_documents(db, bot_id=bot.id, client_id=client.id, query="pricing plans")
        assert len(results) == 1
        assert results[0][0].id == doc.id
