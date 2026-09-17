"""A question about the company's own facts reads the company's own pages.

Reported from production on 2026-09-17, on a managed SOC's bot with about 7,900
chunks (mostly SOC blog posts and service pages):

* "where are the soc centers ?" was refused as off-topic (gate score 0.00);
* "list soc centers" and "list Security Operations Center" were answered with
  the services list;
* the answer was in the contact-us page ("Security Operations Center (SOC)
  Jeddah, KSA| Doha, QAT| ..."), and a replay of hybrid search plus rerank did
  not put that chunk in the top 15 for any of those phrasings.

Such a question now counts as on scope, and retrieval pins up to four chunks of
the company's contact, locations, about and team pages ahead of the retrieved
ones, where the relevance judge reads them.
"""

from __future__ import annotations

import itertools
import time

import pytest
from sqlalchemy import text

from app.db.models import Document
from app.db.repository import list_crawled_page_names, search_documents_in_pages
from app.services import rag_service as rs
from app.services.knowledge_links import company_fact_page_kind, company_fact_pages
from app.services.relevance_gate import GATE_MAX_CHUNKS
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _Doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

_SITE = "https://eventussecurity.com"
_CONTACT_US = f"{_SITE}/contact-us/"
_ADDRESS_CHUNK = (
    "Global Headquarters Eventus Security Pte Ltd 7030 Ang Mo Kio Avenue 5, Singapore. "
    "Security Operations Center (SOC) Jeddah, KSA| Doha, QAT| Ahmedabad, IN| Mumbai, IN"
)
_FORM_CHUNK = "Contact us. First name. Last name. Work email. Company. Country code +33 +91. Submit."

_ids = itertools.count(50_000_000)


class TestTheQuestionIsRecognised:
    @pytest.mark.parametrize(
        ("question", "kind"),
        [
            ("where are the soc centers ?", "locations"),
            ("list soc centers", "locations"),
            ("list Security Operations Center", "locations"),
            ("So what about the locations?", "locations"),
            ("where are your offices", "locations"),
            ("where are your centres", "locations"),
            ("where r ur branches", "locations"),
            ("list your locations", "locations"),
            ("which countries are you in", "locations"),
            ("are you available in France", "locations"),
            ("do you have an office in dubai", "locations"),
            ("where are you guys based", "locations"),
            ("where is your HQ", "locations"),
            ("what is your company's address", "locations"),
            ("where's the headquarters", "locations"),
            ("what is your phone number", "contact"),
            ("what's your email?", "contact"),
            ("how can i contact you", "contact"),
            ("who is your ceo", "team"),
            ("who founded the company", "team"),
            ("tell me about your leadership", "team"),
            ("how many employees do you have", "team"),
        ],
    )
    def test_a_facts_question(self, question, kind):
        assert kind in rs._asks_company_facts(question, "Eventus Security")

    @pytest.mark.parametrize(
        "question",
        [
            "where is my order",
            "location of the event venue",
            "where do I find the settings",
            "what is the capital of france",
            "can your team build a mobile app",
            "do you offer an email marketing service",
            "what does a soc analyst do",
            "list your services",
            "show all locations of the event",
            "",
        ],
    )
    def test_not_a_facts_question(self, question):
        assert rs._asks_company_facts(question, "Eventus Security") == frozenset()

    def test_naming_the_company_with_a_facts_noun_counts(self):
        assert rs._asks_company_facts("where is eventus located", "Eventus Security") == {"locations"}
        assert rs._asks_company_facts("eventus founders", "Eventus Security") == {"team"}
        assert rs._asks_company_facts("what does eventus do", "Eventus Security") == frozenset()

    @pytest.mark.parametrize(
        "question",
        [
            "where are the soc centers ?",
            "where are your offices",
            "where are your centres",
            "where are your centers",
            "where are your branches",
            "list your locations",
            "which countries are you in",
        ],
    )
    def test_a_facts_question_is_clearly_on_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, "Eventus Security") is True

    @pytest.mark.parametrize("question", ["where is my order", "where do I find the settings"])
    def test_the_negatives_stay_unknown_on_scope(self, question):
        assert rs._question_is_clearly_on_scope(question, "Eventus Security") is False

    @pytest.mark.parametrize(
        "text",
        [
            "where are the " * 2000,
            "your " * 4000,
            "list all the " * 2000,
            "which countries " * 2000,
            "how can i " * 2500,
            "a" * 20_000,
        ],
    )
    def test_linear_on_long_input(self, text):
        started = time.perf_counter()
        rs._asks_company_facts(text, "Eventus Security")
        rs._question_is_clearly_on_scope(text, "Eventus Security")
        assert time.perf_counter() - started < 0.5


class TestThePagesAreRecognised:
    @pytest.mark.parametrize(
        ("url", "kind"),
        [
            (_CONTACT_US, "contact"),
            ("https://x.com/contact", "contact"),
            ("https://x.com/en/contact-us", "contact"),
            ("https://x.com/about-us/contact", "contact"),
            ("https://x.com/locations", "locations"),
            ("https://x.com/our-offices/", "locations"),
            ("https://x.com/about-us", "about"),
            ("https://x.com/company", "about"),
            ("https://x.com/about/leadership", "team"),
            ("https://x.com/en-us/our-team", "team"),
        ],
    )
    def test_a_facts_page(self, url, kind):
        assert company_fact_page_kind(url) == kind

    @pytest.mark.parametrize(
        "url",
        [
            "https://x.com/",
            "https://x.com/blog/our-team-at-rsa",
            "https://x.com/soc/what-is-a-security-operations-center",
            "https://x.com/careers",
            "https://x.com/company/about/team/extra",
            "company-profile.pdf",
            None,
            "javascript:alert(1)",
        ],
    )
    def test_not_a_facts_page(self, url):
        assert company_fact_page_kind(url) is None

    def test_pages_are_ranked_for_the_question(self):
        urls = [_CONTACT_US, f"{_SITE}/about-us/", f"{_SITE}/leadership/", f"{_SITE}/blog/x"]
        assert company_fact_pages(urls, {"locations"}) == {_CONTACT_US: 0, f"{_SITE}/about-us/": 2}
        assert company_fact_pages(urls, {"team"}) == {f"{_SITE}/leadership/": 0, f"{_SITE}/about-us/": 1}
        assert company_fact_pages(urls, set()) == {}


def _document(db, bot, name, content, source="crawl", active=True):
    doc = Document(
        client_id=bot.client_id,
        bot_id=bot.id,
        document_name=name,
        source=source,
        is_active=active,
        file_hash=f"hash-{bot.id}-{next(_ids)}",
        content=content,
        embedding=[0.0] * 767 + [1.0],
    )
    db.add(doc)
    db.flush()
    # Ingestion fills the keyword index; it is not a generated column.
    db.execute(
        text("UPDATE documents SET search_vector = to_tsvector('english', content) WHERE id = :id"), {"id": doc.id}
    )
    db.commit()
    return doc


def _eventus_shaped_kb(db, bot, articles=40):
    """Many SOC articles and careers pages, and one contact page whose second
    chunk holds the SOC cities."""
    for n in range(articles):
        _document(
            db,
            bot,
            f"{_SITE}/soc/article-{n}/",
            f"What is a SOC {n}? A security operations center (SOC) monitors, detects and responds to threats.",
        )
    _document(db, bot, f"{_SITE}/careers/soc-analyst/", "Careers: SOC analyst roles at our security operations center.")
    form = _document(db, bot, _CONTACT_US, _FORM_CHUNK)
    address = _document(db, bot, _CONTACT_US, _ADDRESS_CHUNK)
    return form, address


class TestTheRepositoryHelpers:
    def test_page_names_are_the_active_crawled_ones(self, db):
        bot = _make_bot(db, _make_client(db))
        _document(db, bot, _CONTACT_US, "a")
        _document(db, bot, _CONTACT_US, "b")
        _document(db, bot, "contact-us.pdf", "uploaded", source="upload")
        _document(db, bot, f"{_SITE}/about-us/", "gone", active=False)
        other = _make_bot(db, _make_client(db))
        _document(db, other, f"{_SITE}/locations/", "another tenant")

        assert list_crawled_page_names(db, bot_id=bot.id, client_id=bot.client_id) == [_CONTACT_US]

    def test_chunks_of_the_named_pages_rank_by_any_query_term(self, db):
        bot = _make_bot(db, _make_client(db))
        form, address = _eventus_shaped_kb(db, bot, articles=3)

        rows = search_documents_in_pages(
            db,
            page_names=[_CONTACT_US],
            query="where are the soc centers ?",
            k=10,
            bot_id=bot.id,
            client_id=bot.client_id,
        )

        assert [doc.id for doc, _rank in rows] == [address.id, form.id]
        assert rows[0][1] > rows[1][1]

    def test_a_query_with_no_terms_keeps_document_order(self, db):
        bot = _make_bot(db, _make_client(db))
        form, address = _eventus_shaped_kb(db, bot, articles=0)

        rows = search_documents_in_pages(
            db, page_names=[_CONTACT_US], query="where are the", k=10, bot_id=bot.id, client_id=bot.client_id
        )

        assert [doc.id for doc, _rank in rows] == [form.id, address.id]

    def test_no_pages_reads_nothing(self, db):
        assert search_documents_in_pages(db, page_names=[], query="soc", k=4, bot_id=1) == []


class TestThePinnedChunks:
    @pytest.mark.parametrize("query", ["where are the soc centers ?", "list your locations", ""])
    def test_the_chunk_stating_the_fact_comes_first(self, db, query):
        bot = _make_bot(db, _make_client(db))
        form, address = _eventus_shaped_kb(db, bot)

        pinned = rs._company_fact_chunks(bot.client_id, bot.id, query, frozenset({"locations"}))

        assert [doc.id for doc in pinned] == [address.id, form.id]

    def test_capped(self, db):
        bot = _make_bot(db, _make_client(db))
        for n in range(10):
            _document(db, bot, f"{_SITE}/locations/", f"Office {n} is located on Main Street.")

        pinned = rs._company_fact_chunks(bot.client_id, bot.id, "offices", frozenset({"locations"}))

        assert len(pinned) == rs.COMPANY_FACTS_PIN_LIMIT

    def test_a_bot_without_such_pages_pins_nothing(self, db):
        bot = _make_bot(db, _make_client(db))
        _document(db, bot, f"{_SITE}/soc/article/", "What is a SOC?")

        assert rs._company_fact_chunks(bot.client_id, bot.id, "soc", frozenset({"locations"})) == []

    def test_a_database_failure_pins_nothing(self, monkeypatch):
        def boom(*_a, **_k):
            raise RuntimeError("database unavailable")

        monkeypatch.setattr(rs, "list_crawled_page_names", boom)
        assert rs._company_fact_chunks(1, 1, "soc", frozenset({"locations"})) == []

    def test_merge_puts_pinned_first_without_duplicates_and_keeps_the_length(self):
        retrieved = [_Doc(id=n, content=str(n)) for n in range(15)]
        pinned = [_Doc(id=100, content="a"), _Doc(id=3, content="3")]

        merged = rs._pin_company_fact_chunks(retrieved, pinned, 15)

        assert [doc.id for doc in merged] == [100, 3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
        assert rs._pin_company_fact_chunks(retrieved, [], 15) == retrieved


class _Judge:
    def __init__(self, relevant: bool) -> None:
        self.relevant = relevant
        self.calls: list[tuple[str, list]] = []

    def __call__(self, query, chunks, **_kwargs):
        self.calls.append((query, list(chunks)))
        return self.relevant, 1.0 if self.relevant else 0.0


def _soc_articles(count: int = 15) -> list[_Doc]:
    return [
        _Doc(
            id=next(_ids),
            content=f"SOC article {n}: a security operations center monitors threats.",
            document_name=f"{_SITE}/soc/article-{n}/",
            media_urls=None,
        )
        for n in range(count)
    ]


def _eventus_bot(db, monkeypatch, session_id, *, relevant):
    client = _make_client(db)
    bot = _make_bot(db, client)
    bot.company_name = "Eventus Security"
    db.commit()
    _make_session(db, bot, client, session_id)
    _form, address = _eventus_shaped_kb(db, bot, articles=5)
    retrieved = _soc_articles()
    cap = _stub_pipeline(monkeypatch, retrieved=retrieved, chunks=("GENERATED ANSWER",))
    judge = _Judge(relevant)
    monkeypatch.setattr(rs, "check_relevance", judge)
    metrics: list[tuple[str, dict]] = []
    real_metric = rs._safety_net_metric

    def spy_metric(name, **tags):
        metrics.append((name, tags))
        real_metric(name, **tags)

    monkeypatch.setattr(rs, "_safety_net_metric", spy_metric)
    monkeypatch.setattr(rs, "CAG_LITE_THRESHOLD", 0)
    return bot, cap, judge, metrics, address, retrieved


class TestThePipeline:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "question", ["where are the soc centers ?", "list soc centers", "list Security Operations Center"]
    )
    async def test_the_contact_chunk_reaches_the_judge_and_the_model(self, db, monkeypatch, question):
        session_id = f"facts-{abs(hash(question))}"
        bot, cap, judge, metrics, address, retrieved = _eventus_bot(db, monkeypatch, session_id, relevant=True)

        frames = await _drive_stream(bot, question, session_id)

        judged = judge.calls[-1][1]
        assert address.id in [doc.id for doc in judged[:GATE_MAX_CHUNKS]]
        assert len(judged) == 15, "the 15-result contract holds"
        assert judged[2:] == retrieved[:13], "the retrieved chunks keep their order behind the pinned ones"
        assert "Jeddah, KSA" in cap["prompts"][-1][1]
        assert _answer_text(frames).endswith("GENERATED ANSWER")
        pinned = [tags for name, tags in metrics if name == "company_facts_pinned"]
        assert pinned and pinned[0]["pinned"] == 2 and pinned[0]["kinds"] == "locations"

    @pytest.mark.asyncio
    async def test_a_refusing_judge_no_longer_refuses_it(self, db, monkeypatch):
        """The judge can still score low; the question is on scope, so the
        model answers from the contact chunk instead of the scope line."""
        bot, cap, _judge, metrics, _address, _retrieved = _eventus_bot(db, monkeypatch, "facts-refuse", relevant=False)

        frames = await _drive_stream(bot, "where are the soc centers ?", "facts-refuse")

        assert _answer_text(frames).endswith("GENERATED ANSWER")
        assert "Jeddah, KSA" in cap["prompts"][-1][1]
        assert "gate_relaxed_on_scope" in [name for name, _tags in metrics]

    @pytest.mark.asyncio
    async def test_any_other_question_pins_nothing(self, db, monkeypatch):
        bot, _cap, judge, metrics, _address, retrieved = _eventus_bot(db, monkeypatch, "facts-none", relevant=True)

        await _drive_stream(bot, "what does a soc analyst do", "facts-none")

        assert judge.calls[-1][1] == retrieved
        assert "company_facts_pinned" not in [name for name, _tags in metrics]

    @pytest.mark.asyncio
    async def test_cag_lite_is_untouched(self, db, monkeypatch):
        """A small knowledge base already hands the model every chunk."""
        bot, _cap, judge, metrics, address, _retrieved = _eventus_bot(db, monkeypatch, "facts-cag", relevant=True)
        monkeypatch.setattr(rs, "CAG_LITE_THRESHOLD", 1000)

        def must_not_run(*_a, **_k):
            raise AssertionError("CAG-lite does not pin")

        monkeypatch.setattr(rs, "_company_fact_chunks", must_not_run)

        await _drive_stream(bot, "where are the soc centers ?", "facts-cag")

        assert address.id in [doc.id for doc in judge.calls[-1][1]]
        assert "company_facts_pinned" not in [name for name, _tags in metrics]
