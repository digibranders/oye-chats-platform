"""A document request returns a download card without calling the answer model.

``test_document_request.py`` pins the noun prefilter, the classifier and which
files match. These pin where the streaming pipeline answers one: ahead of the QA
cache, the relevance gate and generation, behind an explicit request for a
person, never for a conversation the English judges stand down for, and only
when the classifier (stubbed here, never a real model) says the visitor wants a
file sent, or asks whether one exists and the catalog has it exactly.
"""

import time

import pytest

from app.db.models import ChatSession
from app.services import document_request
from app.services import rag_service as rs
from app.services.document_request import TOPIC_MIN_OVERLAP, DocumentIntentDecision
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _doc,
    _drive_stream,
    _final_meta,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

RED = "https://acme.com/files/Red-Teaming.pdf"
RED_DATASHEET = "https://acme.com/files/Red-Teaming-Datasheet.pdf"
BROCHURE = "https://acme.com/files/Acme-Company-Brochure-2025.pdf"
PROFILE = "https://acme.com/files/Acme-Company-Profile.pdf"
EXHIBITOR = "https://expomax.example.com/files/Exhibitor-Brochure.pdf"
SKYLINE = "https://skyline.example.com/files/Skyline-Heights-Brochure.pdf"
RETAIL_CASE_STUDY = "https://acme.com/files/Retail-Case-Study.pdf"
CATALOG = [{"files": [{"url": RED, "name": "Red-Teaming.pdf"}]}]
PROFILE_CATALOG = [{"files": [{"url": PROFILE, "name": "Acme-Company-Profile.pdf"}]}]
RETAIL_CATALOG = [{"files": [{"url": RETAIL_CASE_STUDY, "name": "Retail-Case-Study.pdf"}]}]
DATASHEET_REQUEST = "can you send me the red teaming datasheet?"
PRICING_PAGE = "https://acme.com/pricing"
PRICING_BROCHURE = "https://acme.com/files/Pricing-Brochure.pdf"
PRICING_PDF_REQUEST = "can you send me your pricing pdf?"
PRICING_ANSWER = "Starter costs ₹999 per month and Growth costs ₹2,499 per month."


class _Classifier:
    """Stands in for the gate model behind ``document_request.decide_document_intent``."""

    def __init__(self) -> None:
        self.answer = "no"
        self.delay_s = 0.0
        self.calls: list[str] = []

    def __call__(self, question: str) -> str:
        self.calls.append(question)
        if self.delay_s:
            time.sleep(self.delay_s)
        return self.answer


@pytest.fixture(autouse=True)
def classifier(monkeypatch):
    """No test here reaches a real model. A test that reaches the route sets the label it needs."""
    fake = _Classifier()
    monkeypatch.setattr(document_request, "_classify_document_request_raw", fake)
    return fake


def _bot(db, session_id, **session_kwargs):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, session_id, **session_kwargs)
    return bot


def _cards(db, session_id):
    db.expire_all()
    return db.query(ChatSession).filter(ChatSession.id == session_id).one().inline_cards_shown or {}


def _catalog(monkeypatch, catalog):
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: catalog)


def _count_catalog_fetches(monkeypatch, catalog):
    calls = []

    def fetch(*_a, **_k):
        calls.append(1)
        return catalog

    monkeypatch.setattr(rs, "get_bot_media_urls", fetch)
    return calls


def _record_metrics(monkeypatch):
    recorded: list[tuple[str, dict]] = []
    original = rs._safety_net_metric

    def record(name, **tags):
        recorded.append((name, tags))
        original(name, **tags)

    monkeypatch.setattr(rs, "_safety_net_metric", record)
    return recorded


def _names(metrics):
    return [name for name, _ in metrics]


def _tags(metrics, name):
    (tags,) = [tags for recorded, tags in metrics if recorded == name]
    return tags


@pytest.mark.asyncio
async def test_a_named_datasheet_comes_back_as_a_card(db, monkeypatch, classifier):
    bot = _bot(db, "docs-1", inline_cards_shown={"unhelped_streak": 1})
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "send"

    frames = await _drive_stream(bot, DATASHEET_REQUEST, "docs-1")

    assert classifier.calls == [DATASHEET_REQUEST]
    meta = _final_meta(frames)
    assert meta["media_card"] == {"type": "download", "url": RED, "name": "Red-Teaming.pdf"}
    assert "media_secondary" not in meta
    assert meta["qualification_pending"] is False
    answer = _answer_text(frames)
    assert "**Red Teaming** is ready to download below." in answer
    assert "email" not in answer.lower()
    assert cap["prompts"] == []
    bot_msg = _messages(db, "docs-1", role="bot")[-1]
    assert bot_msg.id == meta["message_id"]
    assert bot_msg.is_unanswered is False
    cards = _cards(db, "docs-1")
    assert cards.get(f"media:{RED}") is True
    # Documents were offered, so the unhelped run ends.
    assert "unhelped_streak" not in cards
    assert _tags(metrics, "document_request") == {
        "path": "stream",
        "found": "1",
        "exact": "True",
        "document_intent": "send",
        "document_intent_fallback": "False",
        "session": "docs-1",
        "bot_id": bot.id,
    }


@pytest.mark.asyncio
async def test_a_request_the_old_rules_missed_gets_the_file_when_the_classifier_says_send(db, monkeypatch, classifier):
    bot = _bot(db, "docs-whatsapp")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Skyline Heights has 2 and 3 BHK homes."),))
    _catalog(monkeypatch, [{"files": [{"url": SKYLINE, "name": "Skyline-Heights-Brochure.pdf"}]}])
    question = "whatsapp me the Skyline Heights brochure"
    # The rules this replaced read it as no request at all.
    assert document_request.fallback_document_intent(question) == "no"
    classifier.answer = "send"

    frames = await _drive_stream(bot, question, "docs-whatsapp")

    assert _final_meta(frames)["media_card"]["url"] == SKYLINE
    assert "Here you go: **Skyline Heights Brochure** is ready to download below." in _answer_text(frames)
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_request_with_no_exact_file_gets_the_nearest_one_and_says_so(db, monkeypatch, classifier):
    bot = _bot(db, "docs-send-inexact")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme has run projects for three banks."),))
    _catalog(monkeypatch, RETAIL_CATALOG)
    classifier.answer = "send"

    frames = await _drive_stream(bot, "can you send me a case study on banks?", "docs-send-inexact")

    assert _final_meta(frames)["media_card"]["url"] == RETAIL_CASE_STUDY
    assert (
        "I don't have that exact document, but **Retail Case Study** is available to download below."
        in _answer_text(frames)
    )
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_second_matching_file_rides_as_the_chip(db, monkeypatch, classifier):
    bot = _bot(db, "docs-2")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),))
    _catalog(
        monkeypatch,
        [
            {"files": [{"url": RED_DATASHEET, "name": "Red-Teaming-Datasheet.pdf"}]},
            {"files": [{"url": RED, "name": "Red-Teaming.pdf"}]},
        ],
    )
    classifier.answer = "send"

    frames = await _drive_stream(bot, "share the red teaming datasheets please", "docs-2")

    meta = _final_meta(frames)
    assert meta["media_card"]["url"] == RED_DATASHEET
    assert meta["media_secondary"] == [{"type": "download", "url": RED, "name": "Red-Teaming.pdf"}]
    assert "**Red Teaming Datasheet** and **Red Teaming** are ready to download below." in _answer_text(frames)


@pytest.mark.asyncio
async def test_a_cached_answer_does_not_hide_the_route(db, monkeypatch, classifier):
    bot = _bot(db, "docs-3")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),))
    _catalog(monkeypatch, CATALOG)
    classifier.answer = "send"
    lookups = []

    def cache_hit(cache_key, bot_id):
        lookups.append(cache_key)
        return {"answer": "That specific detail sits with the team.", "sources": []}

    monkeypatch.setattr(rs, "_qa_cache_lookup", cache_hit)

    frames = await _drive_stream(bot, DATASHEET_REQUEST, "docs-3")

    assert lookups == []
    assert _final_meta(frames)["media_card"]["url"] == RED
    assert "sits with the team" not in _answer_text(frames)


@pytest.mark.asyncio
async def test_no_file_on_a_plan_with_a_human_offers_the_team_in_words(db, monkeypatch, classifier):
    bot = _bot(db, "docs-4", inline_cards_shown={"unhelped_streak": 1})
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)
    classifier.answer = "send"

    frames = await _drive_stream(bot, "email me the kubernetes hardening datasheet", "docs-4")

    meta = _final_meta(frames)
    assert "connect you with the team" in _answer_text(frames)
    assert cap["prompts"] == []
    # An offer in words, not a form: no card, no handoff, no message card.
    assert "media_card" not in meta
    assert "suggest_handoff" not in meta
    assert "show_leave_message" not in meta
    assert _messages(db, "docs-4", role="bot")[-1].is_unanswered is True
    cards = _cards(db, "docs-4")
    assert cards.get("unhelped_streak") == 1
    assert "handoff_offered" not in cards
    assert "leave_message" not in cards


@pytest.mark.asyncio
async def test_a_yes_to_the_no_file_offer_opens_the_handoff(db, monkeypatch, classifier):
    bot = _bot(db, "docs-5")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, [])
    classifier.answer = "send"

    await _drive_stream(bot, "can you send me your brochure?", "docs-5")
    frames = await _drive_stream(bot, "yes", "docs-5")

    assert _final_meta(frames)["suggest_handoff"] is True
    # "yes" names no document, so only the first turn asked.
    assert classifier.calls == ["can you send me your brochure?"]


@pytest.mark.asyncio
async def test_a_request_the_relevance_gate_rejects_still_gets_the_file(db, monkeypatch, classifier):
    bot = _bot(db, "docs-6")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), relevant=False)
    _catalog(monkeypatch, CATALOG)
    classifier.answer = "exists"

    frames = await _drive_stream(bot, "do you have a red teaming datasheet", "docs-6")

    assert _final_meta(frames)["media_card"]["url"] == RED
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_non_english_conversation_keeps_the_model(db, monkeypatch, classifier):
    bot = _bot(db, "docs-7")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), chunks=("Generated.",))
    _catalog(monkeypatch, CATALOG)
    monkeypatch.setattr(rs, "_english_judges_bypassed", lambda *_a, **_k: True)
    classifier.answer = "send"

    frames = await _drive_stream(bot, "can you send me your brochure?", "docs-7")

    assert len(cap["prompts"]) == 1
    assert "download below" not in _answer_text(frames)
    assert classifier.calls == []


@pytest.mark.asyncio
async def test_an_explicit_request_for_a_person_goes_to_the_handoff(db, monkeypatch, classifier):
    bot = _bot(db, "docs-8")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)
    # The real classifier treats a keyword match as authoritative.
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: rs.detect_handoff_intent_keywords(q))
    classifier.answer = "send"

    frames = await _drive_stream(bot, "I want to talk to a human and get the brochure", "docs-8")

    meta = _final_meta(frames)
    assert meta["suggest_handoff"] is True
    assert "media_card" not in meta
    assert "form below" in _answer_text(frames)
    assert cap["prompts"] == []
    assert classifier.calls == []


@pytest.mark.asyncio
async def test_a_question_about_making_brochures_reaches_the_model(db, monkeypatch, classifier):
    bot = _bot(db, "docs-9")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme designs brochures."),), chunks=("We do.",))
    _catalog(monkeypatch, CATALOG)
    classifier.answer = "no"

    frames = await _drive_stream(bot, "do you design brochures?", "docs-9")

    assert len(cap["prompts"]) == 1
    assert "download below" not in _answer_text(frames)


@pytest.mark.asyncio
async def test_a_document_the_visitor_does_not_want_gets_the_model_answer(db, monkeypatch, classifier):
    """The old rules answered this with the exhibitor brochure and "Here you go"."""
    bot = _bot(db, "docs-not-wanted")
    hall = "Hall 1 is 40 by 60 metres."
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc(hall),), chunks=(hall,))
    _catalog(monkeypatch, [{"files": [{"url": EXHIBITOR, "name": "Exhibitor-Brochure.pdf"}]}])
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "no"
    question = "we don't want the exhibitor brochure, just tell us the hall dimensions"

    frames = await _drive_stream(bot, question, "docs-not-wanted")

    answer = _answer_text(frames)
    assert "Here you go" not in answer and "download below" not in answer
    assert "media_card" not in (_final_meta(frames) or {})
    assert hall in answer
    assert len(cap["prompts"]) == 1
    # One bot message, and it is the model's answer (after the returning-visitor greeting), not the route's.
    (bot_message,) = _messages(db, "docs-not-wanted", role="bot")
    assert bot_message.content.endswith(hall)
    assert "download below" not in bot_message.content
    assert f"media:{EXHIBITOR}" not in _cards(db, "docs-not-wanted")
    assert classifier.calls == [question]
    assert "document_request" not in _names(metrics)
    fell_through = _tags(metrics, "document_request_fell_through")
    assert fell_through["document_intent"] == "no"
    assert fell_through["document_intent_fallback"] == "False"


@pytest.mark.asyncio
async def test_a_no_from_the_classifier_falls_through_even_with_an_exact_file(db, monkeypatch, classifier):
    """The catalog matching the message exactly is never a reason to answer with it:
    only the classifier decides whether the visitor asked for a file. The topical
    attach may still offer the file under the model's answer; the route saves and
    sends nothing of its own."""
    bot = _bot(db, "docs-no-exact")
    knowledge = "Our red teaming datasheet covers scope, cadence and reporting."
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc(knowledge),), chunks=(knowledge,))
    _catalog(monkeypatch, CATALOG)
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "no"
    pick = document_request.pick_documents(DATASHEET_REQUEST, "Acme", CATALOG)
    assert (pick.docs[0]["url"], pick.exact) == (RED, True)

    frames = await _drive_stream(bot, DATASHEET_REQUEST, "docs-no-exact")

    assert classifier.calls == [DATASHEET_REQUEST]
    assert len(cap["prompts"]) == 1
    answer = _answer_text(frames)
    assert knowledge in answer
    assert "Here you go" not in answer and "download below" not in answer
    (bot_message,) = _messages(db, "docs-no-exact", role="bot")
    assert bot_message.content.endswith(knowledge)
    assert "document_request" not in _names(metrics)
    fell_through = _tags(metrics, "document_request_fell_through")
    assert (fell_through["exact"], fell_through["document_intent"]) == ("True", "no")


@pytest.mark.asyncio
async def test_a_question_with_no_exact_file_reaches_the_model(db, monkeypatch, classifier):
    """A question about documents is not the same as a request for one. On a
    bot whose case studies are web pages, not files, "I don't have a
    downloadable document" would replace a real answer with a refusal."""
    bot = _bot(db, "docs-10")
    cap = _stub_pipeline(
        monkeypatch,
        retrieved=(_doc("Acme has worked with several fintech clients."),),
        chunks=("We've worked with several fintech clients.",),
    )
    _catalog(monkeypatch, [])
    classifier.answer = "exists"

    frames = await _drive_stream(bot, "do you have case studies of fintech clients?", "docs-10")

    assert len(cap["prompts"]) == 1
    answer = _answer_text(frames)
    assert "We've worked with several fintech clients." in answer
    assert "don't have a downloadable document" not in answer


@pytest.mark.asyncio
async def test_asking_whether_a_document_exists_with_only_a_near_file_reaches_the_model(db, monkeypatch, classifier):
    bot = _bot(db, "docs-exists-inexact")
    knowledge = "Acme has run projects for three banks."
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc(knowledge),), chunks=(knowledge,))
    _catalog(monkeypatch, RETAIL_CATALOG)
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "exists"

    frames = await _drive_stream(bot, "do you have a case study on banks?", "docs-exists-inexact")

    assert knowledge in _answer_text(frames)
    assert len(cap["prompts"]) == 1
    assert "document_request" not in _names(metrics)
    fell_through = _tags(metrics, "document_request_fell_through")
    assert (fell_through["found"], fell_through["exact"], fell_through["document_intent"]) == ("1", "False", "exists")


@pytest.mark.asyncio
async def test_a_question_with_an_exact_kind_match_still_gets_the_card(db, monkeypatch, classifier):
    """An inexact or empty pick falls through to the model, but an exact catalog
    match (here, by document kind) still answers a question about one with the card."""
    bot = _bot(db, "docs-11")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme is a security company."),))
    _catalog(monkeypatch, PROFILE_CATALOG)
    classifier.answer = "exists"

    frames = await _drive_stream(bot, "do you have a company profile?", "docs-11")

    assert _final_meta(frames)["media_card"]["url"] == PROFILE
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_delivery_request_with_no_match_still_gets_the_no_file_offer(db, monkeypatch, classifier):
    bot = _bot(db, "docs-12", inline_cards_shown={"unhelped_streak": 1})
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, [])
    classifier.answer = "send"

    frames = await _drive_stream(bot, "can you send me your brochure?", "docs-12")

    answer = _answer_text(frames)
    assert "connect you with the team" in answer
    assert cap["prompts"] == []
    assert "media_card" not in (_final_meta(frames) or {})


@pytest.mark.asyncio
async def test_a_document_request_with_person_words_uses_the_cache(db, monkeypatch, classifier):
    """The cache skip and the document route are gated on the same helper
    (``_document_route_applies``), so they always agree: a request for a
    person is left to the handoff, and the cache is not skipped for it."""
    bot = _bot(db, "docs-13")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, CATALOG)
    monkeypatch.setattr(rs, "detect_handoff_intent", lambda q, **_k: rs.detect_handoff_intent_keywords(q))
    lookups = []

    def cache_miss(cache_key, bot_id):
        lookups.append(cache_key)
        return None

    monkeypatch.setattr(rs, "_qa_cache_lookup", cache_miss)

    frames = await _drive_stream(bot, "send me the brochure and let me talk to a human", "docs-13")

    assert lookups != []
    assert "media_card" not in (_final_meta(frames) or {})
    assert classifier.calls == []


@pytest.mark.asyncio
async def test_an_email_address_in_the_request_still_gets_the_brochure(db, monkeypatch, classifier):
    bot = _bot(db, "docs-14")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), support=True)
    _catalog(monkeypatch, [{"files": [{"url": BROCHURE, "name": "Acme-Company-Brochure-2025.pdf"}]}])
    classifier.answer = "send"

    frames = await _drive_stream(bot, "can you email the brochure to rahul.sharma@gmail.com", "docs-14")

    assert _final_meta(frames)["media_card"]["url"] == BROCHURE
    assert "**Acme Company Brochure 2025** is ready to download below." in _answer_text(frames)
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_document_question_left_to_the_model_is_counted_and_fetches_the_catalog_once(
    db, monkeypatch, classifier
):
    bot = _bot(db, "docs-15")
    cap = _stub_pipeline(
        monkeypatch,
        retrieved=(_doc("Acme has worked with several fintech clients."),),
        chunks=("We've worked with several fintech clients.",),
    )
    calls = _count_catalog_fetches(monkeypatch, [])
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "exists"

    await _drive_stream(bot, "do you have case studies of fintech clients?", "docs-15")

    assert len(cap["prompts"]) == 1
    assert "document_request_fell_through" in _names(metrics)
    assert "document_request" not in _names(metrics)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_a_turn_that_names_no_document_never_asks_the_classifier_and_fetches_the_catalog_once(
    db, monkeypatch, classifier
):
    bot = _bot(db, "docs-16")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), chunks=("We open at 9.",))
    calls = _count_catalog_fetches(monkeypatch, [])
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "send"

    await _drive_stream(bot, "when do you open", "docs-16")

    assert classifier.calls == []
    assert len(cap["prompts"]) == 1
    assert "document_request_fell_through" not in _names(metrics)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_a_classifier_that_misses_the_deadline_hands_the_turn_to_the_fallback_rules(db, monkeypatch, classifier):
    """The late classifier would have said NO; the rules read a request for the
    datasheet, so the visitor still gets the file."""
    bot = _bot(db, "docs-timeout")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),))
    _catalog(monkeypatch, CATALOG)
    metrics = _record_metrics(monkeypatch)
    monkeypatch.setattr(rs, "_DOCUMENT_INTENT_TIMEOUT_S", 0.05)
    classifier.answer, classifier.delay_s = "no", 0.5

    frames = await _drive_stream(bot, DATASHEET_REQUEST, "docs-timeout")

    assert _final_meta(frames)["media_card"]["url"] == RED
    assert cap["prompts"] == []
    assert classifier.calls == [DATASHEET_REQUEST]
    tags = _tags(metrics, "document_request")
    assert (tags["document_intent"], tags["document_intent_fallback"]) == ("send", "True")


@pytest.mark.asyncio
@pytest.mark.parametrize("label", ["send", "exists", "no"])
async def test_a_turn_asks_the_classifier_once_though_the_cache_skip_and_the_route_both_check_for_a_document(
    db, monkeypatch, classifier, label
):
    bot = _bot(db, f"docs-once-{label}")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme does red teaming."),), chunks=("Acme does red teaming.",))
    _catalog(monkeypatch, CATALOG)
    checked: list[object] = []
    real_check = rs.mentions_document

    def _counting_check(message: object) -> bool:
        checked.append(message)
        return real_check(message)

    monkeypatch.setattr(rs, "mentions_document", _counting_check)
    classifier.answer = label

    await _drive_stream(bot, DATASHEET_REQUEST, f"docs-once-{label}")

    assert checked == [DATASHEET_REQUEST, DATASHEET_REQUEST]
    assert classifier.calls == [DATASHEET_REQUEST]


@pytest.mark.asyncio
async def test_the_bounded_check_uses_the_fallback_rules_on_a_timeout(monkeypatch, classifier):
    monkeypatch.setattr(rs, "_DOCUMENT_INTENT_TIMEOUT_S", 0.05)
    classifier.answer, classifier.delay_s = "no", 0.5

    decision = await rs._detect_document_intent_bounded("can you send me your brochure?")

    assert decision == DocumentIntentDecision("send", by_fallback=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("label", ["send", "exists", "no"])
async def test_the_bounded_check_takes_the_classifier_answer_in_time(monkeypatch, classifier, label):
    monkeypatch.setattr(rs, "_DOCUMENT_INTENT_TIMEOUT_S", 1.0)
    classifier.answer = label

    decision = await rs._detect_document_intent_bounded("do you design brochures?")

    assert decision == DocumentIntentDecision(label, by_fallback=False)


@pytest.mark.asyncio
async def test_the_bounded_check_uses_the_fallback_rules_when_the_worker_fails(monkeypatch):
    def _broken(_question: str) -> DocumentIntentDecision:
        raise RuntimeError("worker died")

    monkeypatch.setattr(rs, "decide_document_intent", _broken)

    decision = await rs._detect_document_intent_bounded("can you send me your brochure?")

    assert decision == DocumentIntentDecision("send", by_fallback=True)


def test_the_document_classifier_gets_the_urgent_classifier_deadline():
    assert rs._DOCUMENT_INTENT_TIMEOUT_S == rs._URGENT_INTENT_TIMEOUT_S


def test_the_document_pick_and_the_topical_card_share_one_overlap_bar():
    assert rs._TOPICAL_MEDIA_MIN_OVERLAP == TOPIC_MIN_OVERLAP


def _bot_with_a_pricing_page(db, monkeypatch, session_id):
    """A paid bot whose pricing gate answers from its pricing page: the gate narrows
    the context to that page and lets generation run."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, pricing_url=PRICING_PAGE)
    _make_session(db, bot, client, session_id)
    cap = _stub_pipeline(
        monkeypatch,
        retrieved=(_doc(f"Acme pricing: {PRICING_ANSWER}", name=PRICING_PAGE),),
        chunks=(PRICING_ANSWER,),
        support=True,
    )
    return bot, cap


@pytest.mark.asyncio
async def test_a_pricing_pdf_request_on_a_bot_with_a_pricing_page_gets_the_pricing_answer(
    db, monkeypatch, classifier
):
    """The pricing gate answers "send me your pricing pdf" from the pricing page. The
    document route used to run after it, hear SEND, find no pricing file, and replace
    that grounded answer with "I don't have a downloadable document"."""
    bot, cap = _bot_with_a_pricing_page(db, monkeypatch, "docs-pricing-page")
    _catalog(monkeypatch, CATALOG)
    metrics = _record_metrics(monkeypatch)
    classifier.answer = "send"

    frames = await _drive_stream(bot, PRICING_PDF_REQUEST, "docs-pricing-page")

    answer = _answer_text(frames)
    assert len(cap["prompts"]) == 1, answer
    assert PRICING_ANSWER in answer
    assert "downloadable" not in answer
    assert "media_card" not in (_final_meta(frames) or {})
    assert "document_request" not in _names(metrics)


@pytest.mark.asyncio
async def test_a_pricing_pdf_request_with_an_exact_pricing_file_still_gets_the_card(db, monkeypatch, classifier):
    bot, cap = _bot_with_a_pricing_page(db, monkeypatch, "docs-pricing-file")
    _catalog(monkeypatch, [{"files": [{"url": PRICING_BROCHURE, "name": "Pricing-Brochure.pdf"}]}])
    classifier.answer = "send"

    frames = await _drive_stream(bot, PRICING_PDF_REQUEST, "docs-pricing-file")

    assert _final_meta(frames)["media_card"]["url"] == PRICING_BROCHURE
    assert cap["prompts"] == []


@pytest.mark.asyncio
async def test_a_pricing_pdf_request_on_a_bot_answering_pricing_from_its_knowledge_base_gets_the_model_answer(
    db, monkeypatch, classifier
):
    """The gate stands down for a bot that answers pricing from its knowledge base,
    but the question is still about pricing, so the model answers it from that
    knowledge base rather than the no-file offer."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, pricing_from_knowledge_base=True)
    _make_session(db, bot, client, "docs-pricing-kb")
    knowledge = "Acme lists its Starter and Growth plans on the pricing page."
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc(knowledge),), chunks=(knowledge,), support=True)
    _catalog(monkeypatch, CATALOG)
    classifier.answer = "send"

    frames = await _drive_stream(bot, PRICING_PDF_REQUEST, "docs-pricing-kb")

    answer = _answer_text(frames)
    assert len(cap["prompts"]) == 1, answer
    assert knowledge in answer
    assert "downloadable" not in answer
