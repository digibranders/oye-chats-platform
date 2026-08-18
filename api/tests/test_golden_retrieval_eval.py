"""Golden-set retrieval eval. Precision@k / recall@k (AR-22).

Before this file, every retrieval-affecting threshold (cosine cutoff,
relevance threshold, rerank on/off) was tuned by anecdotal single-bot
analysis in code comments, with zero systematic held-out evaluation anywhere
in the repository, a threshold/chunking/fusion change could silently drop
recall or precision with no regression signal, caught only by user
complaints.

This is a real, if intentionally small, golden-set harness: a fixed KB with
multiple documents per topic (so precision@k and recall@k are non-trivial,
not just 1-relevant-doc-out-of-1), a golden question per topic, and
precision@k/recall@k computed against real Postgres + pgvector retrieval
(no live LLM call needed). CI-gated the same way test_golden_eval.py is.
Part of the existing `pytest -x -q` run that already blocks deploys.

Scope note: vector-search only (not the full hybrid RRF fusion). That
would additionally require populating the TSVECTOR `search_vector` column,
which the app populates at ingestion time via code this test doesn't invoke
(no DB trigger). Vector search is the dominant, most consequential half of
retrieval and the only half with a stable, easily-faked deterministic
embedding for testing (one-hot vectors -> exact cosine distances). Extending
this to the full hybrid path is a natural next step, not required to get
real value from precision@k/recall@k today.
"""

from sqlalchemy.orm import Session

from app.db.models import Bot, Client, Document
from app.db.repository import search_similar_documents

_seq = iter(range(1, 10_000))


def _make_client(db: Session) -> Client:
    n = next(_seq)
    client = Client(
        name=f"Retrieval Eval Client {n}",
        email=f"retrieval-eval{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"retrieval-eval-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db: Session, client: Client) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-retrieval-eval-{n}", name="Retrieval Eval Bot")
    db.add(bot)
    db.commit()
    return bot


def _unit_vector(dominant_dim: int, dim: int = 768) -> list[float]:
    """One-hot unit vectors -> exact, predictable cosine distances: 0.0
    between two docs sharing a dominant dim, 1.0 between docs on different
    dims (orthogonal vectors). Lets the golden set define clean relevance
    groups without a real embedding model."""
    vec = [0.0] * dim
    vec[dominant_dim % dim] = 1.0
    return vec


def _make_document(db: Session, client: Client, bot: Bot, name: str, content: str, topic_dim: int) -> Document:
    doc = Document(
        client_id=client.id,
        bot_id=bot.id,
        document_name=name,
        source="upload",
        file_hash=f"hash-{topic_dim}-{name}",
        content=content,
        embedding=_unit_vector(topic_dim),
    )
    db.add(doc)
    db.commit()
    return doc


def precision_at_k(retrieved_ids: list[int], relevant_ids: set[int], k: int) -> float:
    top_k = retrieved_ids[:k]
    if not top_k:
        return 0.0
    hits = sum(1 for doc_id in top_k if doc_id in relevant_ids)
    return hits / len(top_k)


def recall_at_k(retrieved_ids: list[int], relevant_ids: set[int], k: int) -> float:
    if not relevant_ids:
        return 1.0
    top_k = retrieved_ids[:k]
    hits = sum(1 for doc_id in top_k if doc_id in relevant_ids)
    return hits / len(relevant_ids)


class TestGoldenRetrievalPrecisionRecall:
    """A 7-document KB across 3 topics (3 pricing docs, 2 hours docs, 2 team
    docs). Precision@k/recall@k are non-trivial here because each topic has
    MULTIPLE relevant documents, unlike test_golden_eval.py's simpler
    1-relevant-doc fixture."""

    def _build_kb(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)

        pricing_docs = [
            _make_document(db, client, bot, "pricing-standard.txt", "Standard plan costs $49/month.", topic_dim=1),
            _make_document(db, client, bot, "pricing-enterprise.txt", "Enterprise plan costs $199/month.", topic_dim=1),
            _make_document(db, client, bot, "pricing-discount.txt", "Annual billing gets a 20% discount.", topic_dim=1),
        ]
        hours_docs = [
            _make_document(db, client, bot, "hours-weekday.txt", "Open Monday to Friday, 9am to 6pm.", topic_dim=2),
            _make_document(db, client, bot, "hours-holiday.txt", "Closed on public holidays.", topic_dim=2),
        ]
        team_docs = [
            _make_document(db, client, bot, "team-ceo.txt", "Our CEO is Jane Doe.", topic_dim=3),
            _make_document(db, client, bot, "team-size.txt", "We have 25 employees.", topic_dim=3),
        ]

        return {
            "bot": bot,
            "pricing_ids": {d.id for d in pricing_docs},
            "hours_ids": {d.id for d in hours_docs},
            "team_ids": {d.id for d in team_docs},
        }

    def test_pricing_question_precision_and_recall(self, db):
        kb = self._build_kb(db)
        # search_similar_documents' default max_distance=0.78 excludes
        # anything at cosine distance 1.0 (our orthogonal off-topic docs)
        # entirely from the SQL results. Pass a looser max_distance so all
        # 7 docs come back and precision@5 can show real dilution from
        # off-topic docs, rather than trivially only ever seeing the 3
        # on-topic ones the default threshold already filtered down to.
        results = search_similar_documents(
            db, bot_id=kb["bot"].id, query_embedding=_unit_vector(1), k=5, max_distance=1.5
        )
        retrieved_ids = [doc.id for doc, _distance in results]

        # All 3 pricing docs must rank ahead of the 4 off-topic docs (exact
        # cosine distance 0.0 vs 1.0, a broken distance metric or fusion
        # regression would show up here as pricing docs NOT ranking first).
        assert precision_at_k(retrieved_ids, kb["pricing_ids"], k=3) == 1.0
        assert recall_at_k(retrieved_ids, kb["pricing_ids"], k=3) == 1.0
        # At k=5 (2 off-topic docs padding the results), precision necessarily
        # drops but recall must stay perfect. Every relevant doc was found.
        assert precision_at_k(retrieved_ids, kb["pricing_ids"], k=5) == 3 / 5
        assert recall_at_k(retrieved_ids, kb["pricing_ids"], k=5) == 1.0

    def test_hours_question_precision_and_recall(self, db):
        kb = self._build_kb(db)
        results = search_similar_documents(db, bot_id=kb["bot"].id, query_embedding=_unit_vector(2), k=2)
        retrieved_ids = [doc.id for doc, _distance in results]

        assert precision_at_k(retrieved_ids, kb["hours_ids"], k=2) == 1.0
        assert recall_at_k(retrieved_ids, kb["hours_ids"], k=2) == 1.0

    def test_team_question_does_not_leak_pricing_docs_into_top_k(self, db):
        """Regression guard on the metric itself: a team question's top-k
        must not silently include pricing/hours docs. If it did, precision
        would show < 1.0 here and the test would catch a real fusion bug."""
        kb = self._build_kb(db)
        results = search_similar_documents(db, bot_id=kb["bot"].id, query_embedding=_unit_vector(3), k=2)
        retrieved_ids = [doc.id for doc, _distance in results]

        assert precision_at_k(retrieved_ids, kb["team_ids"], k=2) == 1.0
        assert not (set(retrieved_ids) & kb["pricing_ids"])
        assert not (set(retrieved_ids) & kb["hours_ids"])


class TestPrecisionRecallHelpers:
    """Unit tests for the metric functions themselves, the eval harness's
    own arithmetic must be correct or the assertions above are meaningless."""

    def test_precision_at_k_all_relevant(self):
        assert precision_at_k([1, 2, 3], {1, 2, 3}, k=3) == 1.0

    def test_precision_at_k_none_relevant(self):
        assert precision_at_k([1, 2, 3], {99}, k=3) == 0.0

    def test_precision_at_k_partial(self):
        assert precision_at_k([1, 2, 3, 4], {1, 2}, k=4) == 0.5

    def test_recall_at_k_finds_all(self):
        assert recall_at_k([1, 2, 3], {1, 2}, k=3) == 1.0

    def test_recall_at_k_misses_some(self):
        assert recall_at_k([1, 3], {1, 2}, k=2) == 0.5

    def test_recall_at_k_empty_relevant_set_is_vacuously_perfect(self):
        assert recall_at_k([1, 2], set(), k=2) == 1.0

    def test_precision_at_k_empty_retrieval(self):
        assert precision_at_k([], {1, 2}, k=5) == 0.0
