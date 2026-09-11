"""The urgent reply is fixed wording, opens the form and alerts the team once per conversation."""

import time

import pytest
from sqlalchemy import text

from app.db.models import ChatSession, LeadInfo
from app.db.repository import get_lead_info_by_session
from app.services import document_request, urgent_route
from app.services import rag_service as rs
from app.services.handoff_reply import handoff_reply, unhelped_offer
from app.services.intent_router import route_intent as real_route_intent
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

URGENT = "we are under a ransomware attack right now, please help!"
PUSH_TASK = "task_dispatch_handoff_push"
TEAM_EMAILS = {"default": ["soc@acme.test"]}


class _Classifier:
    """Stands in for the gate model behind ``urgent_route.classify_urgent_incident``."""

    def __init__(self) -> None:
        self.answer = True
        self.delay_s = 0.0
        self.calls: list[str] = []

    def __call__(self, question: str) -> bool:
        self.calls.append(question)
        if self.delay_s:
            time.sleep(self.delay_s)
        return self.answer


@pytest.fixture(autouse=True)
def classifier(monkeypatch):
    """No test here reaches a real model. The fake says YES to every message that
    passes the vocabulary check unless a test says otherwise. The support route's
    classifier says NO: "my order hasn't arrived" passes its vocabulary check, and
    these tests are about the urgent route."""
    fake = _Classifier()
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", fake)
    monkeypatch.setattr("app.services.support_route._classify_support_request_raw", lambda _question: False)
    return fake


@pytest.fixture()
def alerts(monkeypatch):
    sent: dict[str, list] = {"notify": [], "emails": [], "enqueue": []}
    monkeypatch.setattr(rs, "notify_handoff_request", lambda *_a, **kwargs: sent["notify"].append(kwargs))
    monkeypatch.setattr(
        rs,
        "send_handoff_request_email",
        lambda recipient, _bot_name, reason, contact=None, **kwargs: sent["emails"].append(
            {"to": recipient, "reason": reason, "contact": contact, **kwargs}
        ),
    )
    monkeypatch.setattr(rs, "enqueue_sync", lambda task, *args, **_kwargs: sent["enqueue"].append((task, args)))
    return sent


def _push_jobs(alerts):
    return [args for task, args in alerts["enqueue"] if task == PUSH_TASK]


def _cards_shown(db, session_id):
    db.expire_all()
    return db.get(ChatSession, session_id).inline_cards_shown or {}


def _use_the_real_name_flow(monkeypatch, real):
    """``_stub_pipeline`` answers every name question with a returning "Tester".
    These tests need the first-message name question itself, so the real
    functions saved before stubbing are put back."""
    resolve_name_flow, resolve_visitor_name, should_ask_visitor_name = real
    monkeypatch.setattr(rs, "resolve_name_flow", resolve_name_flow)
    monkeypatch.setattr(rs, "resolve_visitor_name", resolve_visitor_name)
    monkeypatch.setattr(rs, "_should_ask_visitor_name", should_ask_visitor_name)


def _real_name_functions():
    return rs.resolve_name_flow, rs.resolve_visitor_name, rs._should_ask_visitor_name


@pytest.mark.asyncio
async def test_urgent_turn_is_fixed_wording_with_the_form_and_one_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-1")
    db.add(LeadInfo(session_id="urgent-1", bot_id=bot.id, name="Eva", email="eva@x.test"))
    db.commit()
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    # ``_team_online`` asks presence only on a live-chat bot inside hours (no
    # hours configured means always open), so this makes the team offline.
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)

    frames = await _drive_stream(bot, URGENT, "urgent-1")
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    assert answer == (
        "This sounds urgent, so I've flagged it to **Acme** as a priority. Share your details in the form "
        "below so the team can contact you as soon as possible."
    ), answer
    assert "Eva" not in answer, "no cheerful by-name opener above an incident"
    assert meta["suggest_handoff"] is True
    assert meta["qualification_pending"] is False
    assert "show_leave_message" not in meta
    persisted = _messages(db, "urgent-1", role="bot")
    assert [m.id for m in persisted] == [meta["message_id"]]
    assert persisted[0].content == answer

    again = await _drive_stream(bot, "please hurry, we are still under attack right now", "urgent-1")
    again_answer = _answer_text(again)

    assert again_answer == (
        "I've already flagged this to **Acme** as a priority. The form is just below: "
        "share your details there so the team can contact you as soon as possible."
    )
    assert _final_meta(again)["suggest_handoff"] is True
    assert cap["prompts"] == [], "the urgent reply is not a model call"
    assert len(alerts["notify"]) == 1
    assert alerts["notify"][0]["urgent"] is True
    assert alerts["notify"][0]["session_id"] == "urgent-1"
    assert alerts["notify"][0]["visitor_name"] == "Eva"
    assert alerts["emails"] == [
        {
            "to": "soc@acme.test",
            "reason": URGENT,
            "contact": {"name": "Eva", "email": "eva@x.test", "phone": None},
            "reply_to": None,
            "urgent": True,
            "session_id": "urgent-1",
        }
    ]
    assert _push_jobs(alerts) == [("urgent-1", bot.id, None, "Eva", "URGENT: active incident reported in chat", 60)]
    shown = _cards_shown(db, "urgent-1")
    assert shown.get("urgent_notified") is True
    assert shown.get("handoff_offered") is True


@pytest.mark.asyncio
async def test_a_reachable_team_is_offered_a_connection_right_away(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-team")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)

    frames = await _drive_stream(bot, URGENT, "urgent-team")
    meta = _final_meta(frames)

    assert _answer_text(frames) == (
        "This sounds urgent, so I've flagged it to **Acme** as a priority. Share your details in the form "
        "below and I'll connect you with them right away."
    )
    assert meta["suggest_handoff"] is True
    assert "show_leave_message" not in meta

    again = await _drive_stream(bot, "our servers have been hacked, please hurry", "urgent-team")

    assert _answer_text(again) == (
        "I've already flagged this to **Acme** as a priority. The form is just below: "
        "share your details there and I'll connect you with them right away."
    )
    assert _final_meta(again)["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1 and len(_push_jobs(alerts)) == 1


@pytest.mark.asyncio
async def test_a_bot_without_live_chat_opens_the_message_card(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=False)
    _make_session(db, bot, client, "urgent-3")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    frames = await _drive_stream(bot, URGENT, "urgent-3")
    meta = _final_meta(frames)

    assert "I'll open a quick message form" in _answer_text(frames)
    assert meta["suggest_handoff"] is False
    assert meta["show_leave_message"] is True
    assert len(alerts["notify"]) == 1
    shown = _cards_shown(db, "urgent-3")
    assert shown.get("leave_message") is True
    assert not shown.get("handoff_offered")

    again = await _drive_stream(bot, URGENT, "urgent-3")

    assert _answer_text(again) == (
        "I've already flagged this to **Acme** as a priority. Leave your details in the message form "
        "so the team can contact you as soon as possible."
    )
    assert _final_meta(again)["show_leave_message"] is True
    assert _final_meta(again)["suggest_handoff"] is False
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_plan_without_a_human_sends_no_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-2")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=False)

    frames = await _drive_stream(bot, URGENT, "urgent-2")
    answer = _answer_text(frames)

    assert "This sounds urgent" in answer
    assert "flagged" not in answer
    assert not (_final_meta(frames) or {}).get("suggest_handoff")
    again = await _drive_stream(bot, URGENT, "urgent-2")
    assert _answer_text(again) == answer
    assert alerts["notify"] == [] and alerts["emails"] == [] and alerts["enqueue"] == []
    assert not _cards_shown(db, "urgent-2").get("urgent_notified")


@pytest.mark.asyncio
async def test_an_enqueue_failure_still_delivers_the_reply_and_the_email(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-4")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    def _broken_enqueue(*_a, **_k):
        raise RuntimeError("REDIS_URL required for task queue")

    monkeypatch.setattr(rs, "enqueue_sync", _broken_enqueue)

    frames = await _drive_stream(bot, URGENT, "urgent-4")

    assert "This sounds urgent" in _answer_text(frames)
    assert _final_meta(frames)["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1
    assert [email["to"] for email in alerts["emails"]] == ["soc@acme.test"]


@pytest.mark.asyncio
async def test_a_notification_that_breaks_the_transaction_still_delivers_the_reply(db, monkeypatch, alerts):
    """``create_notification`` writes on the request session. A database error
    there aborts the transaction, which must not take the saved reply with it."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-5")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    def _failing_notification(session, **_kwargs):
        session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(rs, "notify_handoff_request", _failing_notification)

    frames = await _drive_stream(bot, URGENT, "urgent-5")
    meta = _final_meta(frames)

    assert meta is not None and meta["suggest_handoff"] is True
    assert [m.id for m in _messages(db, "urgent-5", role="bot")] == [meta["message_id"]]
    assert len(alerts["emails"]) == 1
    assert len(_push_jobs(alerts)) == 1
    shown = _cards_shown(db, "urgent-5")
    assert shown.get("urgent_notified") is True and shown.get("handoff_offered") is True


@pytest.mark.asyncio
async def test_the_reply_and_the_alert_are_saved_before_the_first_frame(db, monkeypatch, alerts):
    """The reply text is fixed, so nothing waits on the stream. A visitor who
    closes the tab after the first frame still leaves a saved reply and an
    alerted team."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-6")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    stream = rs.rag_pipeline_stream(bot, URGENT, "urgent-6", bot_id=bot.id)
    first = await stream.__anext__()
    await stream.aclose()

    assert first.startswith("METADATA:")
    db.expire_all()
    persisted = _messages(db, "urgent-6", role="bot")
    assert len(persisted) == 1 and persisted[0].content.startswith("This sounds urgent")
    assert len(alerts["notify"]) == 1
    assert len(alerts["emails"]) == 1
    assert _cards_shown(db, "urgent-6").get("urgent_notified") is True


@pytest.mark.asyncio
async def test_an_incident_in_the_first_message_is_not_held_behind_the_name_question(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-first")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    frames = await _drive_stream(bot, URGENT, "urgent-first")
    answer = _answer_text(frames)

    assert answer.startswith("This sounds urgent"), answer
    assert not rs._is_name_ask_message(answer)
    assert len(alerts["notify"]) == 1
    assert alerts["notify"][0]["visitor_name"] is None


@pytest.mark.asyncio
async def test_the_turn_after_an_urgent_first_reply_is_not_taken_as_a_name(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-first-2")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    await _drive_stream(bot, URGENT, "urgent-first-2")
    frames = await _drive_stream(bot, "please hurry", "urgent-first-2")
    answer = _answer_text(frames)

    lead = get_lead_info_by_session(db, "urgent-first-2")
    assert lead is None or lead.name is None
    assert answer.strip(), "the visitor still gets a reply"
    assert not rs._is_name_ask_message(answer), answer


@pytest.mark.asyncio
async def test_a_name_question_before_the_incident_does_not_take_the_next_message_as_a_name(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-after-ask")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    asked = await _drive_stream(bot, "what services do you offer?", "urgent-after-ask")
    assert rs._is_name_ask_message(_answer_text(asked))
    urgent = await _drive_stream(bot, URGENT, "urgent-after-ask")
    assert _answer_text(urgent).startswith("This sounds urgent")
    frames = await _drive_stream(bot, "please hurry", "urgent-after-ask")

    lead = get_lead_info_by_session(db, "urgent-after-ask")
    assert lead is None or lead.name is None
    assert not rs._is_name_ask_message(_answer_text(frames))
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_normal_first_question_still_gets_the_name_question(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-normal-first")
    real = _real_name_functions()
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    _use_the_real_name_flow(monkeypatch, real)

    frames = await _drive_stream(bot, "what services do you offer?", "urgent-normal-first")

    assert rs._is_name_ask_message(_answer_text(frames))
    assert alerts["notify"] == []


@pytest.mark.asyncio
async def test_an_owner_preview_shows_the_urgent_reply_and_pages_no_one(db, monkeypatch, alerts):
    """An owner typing an incident into the dashboard Preview sees the urgent reply,
    but the real team gets no inbox notification, email or push."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-preview")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    bot._is_preview = True

    frames = await _drive_stream(bot, URGENT, "urgent-preview")

    assert _answer_text(frames).startswith("This sounds urgent")
    assert _final_meta(frames)["suggest_handoff"] is True
    assert alerts["notify"] == [] and alerts["emails"] == [] and alerts["enqueue"] == []


@pytest.mark.asyncio
async def test_a_security_question_the_classifier_rejects_gets_the_normal_answer(db, monkeypatch, alerts, classifier):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-rejected")
    knowledge = "Acme recovers data after ransomware attacks."
    cap = _stub_pipeline(monkeypatch, chunks=(knowledge,), retrieved=(_doc(knowledge),), support=True)
    classifier.answer = False
    # "we" keeps it at the classifier: "can you recover data after a ransomware
    # attack" only asks about the service and now skips the classifier.
    question = "can we recover our data after a ransomware attack"

    frames = await _drive_stream(bot, question, "urgent-rejected")
    answer = _answer_text(frames)

    assert classifier.calls == [question]
    assert knowledge in answer
    assert "This sounds urgent" not in answer and "flagged" not in answer
    assert cap["prompts"], "the normal pipeline wrote the answer"
    assert alerts["notify"] == [] and alerts["emails"] == [] and _push_jobs(alerts) == []
    assert not _cards_shown(db, "urgent-rejected").get("urgent_notified")


@pytest.mark.asyncio
async def test_a_classifier_that_misses_the_deadline_hands_the_turn_to_the_fallback_rules(
    db, monkeypatch, alerts, classifier
):
    """The late classifier would have said NO; the rules read a first-person
    report in progress, so the visitor still gets the urgent route."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "urgent-timeout")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "_URGENT_INTENT_TIMEOUT_S", 0.05)
    classifier.answer, classifier.delay_s = False, 0.5

    frames = await _drive_stream(bot, URGENT, "urgent-timeout")

    assert _answer_text(frames).startswith("This sounds urgent")
    assert classifier.calls == [URGENT]
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_turn_without_security_words_never_asks_the_classifier(db, monkeypatch, alerts, classifier):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-plain")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)

    frames = await _drive_stream(bot, "I need urgent help, my order hasn't arrived", "urgent-plain")

    assert classifier.calls == []
    assert "This sounds urgent" not in _answer_text(frames)
    assert alerts["notify"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("question", "classified"), [("I need urgent help, my order hasn't arrived", False), (URGENT, True)]
)
async def test_a_turn_runs_the_vocabulary_check_once_and_classifies_only_a_hit(
    db, monkeypatch, alerts, classifier, question, classified
):
    """The pipeline runs the check before the language check, and the bounded
    helper trusts it instead of running it again."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-once")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    checked: list[object] = []
    real_check = urgent_route.might_be_urgent_incident

    def _counting_check(message: object) -> bool:
        checked.append(message)
        return real_check(message)

    monkeypatch.setattr(urgent_route, "might_be_urgent_incident", _counting_check)

    await _drive_stream(bot, question, "urgent-once")

    assert len(checked) == 1
    assert len(classifier.calls) == (1 if classified else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("question", "expected"), [(URGENT, True), ("is my card data safe if your store gets hacked", False)]
)
async def test_the_bounded_check_uses_the_fallback_rules_on_a_timeout(monkeypatch, classifier, question, expected):
    monkeypatch.setattr(rs, "_URGENT_INTENT_TIMEOUT_S", 0.05)
    classifier.answer, classifier.delay_s = not expected, 0.5

    assert await rs._detect_urgent_bounded(question) is expected


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", [True, False])
async def test_the_bounded_check_takes_the_classifier_answer_in_time(monkeypatch, classifier, answer):
    monkeypatch.setattr(rs, "_URGENT_INTENT_TIMEOUT_S", 1.0)
    classifier.answer = answer

    assert await rs._detect_urgent_bounded("hacked!! pls help") is answer


@pytest.mark.asyncio
async def test_ok_after_the_offline_urgent_reply_opens_the_form_not_the_ack(db, monkeypatch, alerts):
    """ "ok" answers the urgent reply's offer. The team-offline wording used to close
    without one the offer pattern knows, so the router answered "Glad that helped"."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-ok")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)

    await _drive_stream(bot, URGENT, "urgent-ok")
    frames = await _drive_stream(bot, "ok", "urgent-ok")

    answer = _answer_text(frames)
    assert "Glad that helped" not in answer
    assert answer.endswith(handoff_reply(team_available=False, repeat=True)), answer
    assert _final_meta(frames)["suggest_handoff"] is True


@pytest.mark.asyncio
async def test_ok_after_the_message_card_urgent_reply_is_not_the_ack(db, monkeypatch, alerts):
    """Without live chat the reply opened the message card, which the widget shows
    once per conversation. "ok" answers that offer, so the router's "Glad that
    helped" does not; the turn goes on to the answer pipeline instead."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=False)
    _make_session(db, bot, client, "urgent-ok-card")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)

    await _drive_stream(bot, URGENT, "urgent-ok-card")
    frames = await _drive_stream(bot, "ok", "urgent-ok-card")

    assert "Glad that helped" not in _answer_text(frames)
    assert len(cap["prompts"]) == 1
    assert _cards_shown(db, "urgent-ok-card").get("leave_message") is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "question",
    [
        "do you offer phishing simulation training?",
        "what is your ransomware protection service?",
        "do you provide DDoS protection",
        "tell me about your malware analysis",
    ],
)
async def test_a_question_about_the_business_security_services_never_asks_the_classifier(
    db, monkeypatch, alerts, classifier, question
):
    """On a security vendor's bot these name an attack and passed the vocabulary
    check, which added a model call before every such answer, cache hits included."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-service-question")
    knowledge = "Acme runs phishing simulations, ransomware protection, DDoS protection and malware analysis."
    cap = _stub_pipeline(monkeypatch, chunks=(knowledge,), retrieved=(_doc(knowledge),), support=True)

    frames = await _drive_stream(bot, question, "urgent-service-question")

    assert classifier.calls == []
    assert knowledge in _answer_text(frames)
    assert len(cap["prompts"]) == 1
    assert alerts["notify"] == []


@pytest.mark.asyncio
async def test_an_incident_reported_with_a_service_question_still_gets_the_urgent_reply(
    db, monkeypatch, alerts, classifier
):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-with-question")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    question = "we are under attack, do you offer incident response?"

    frames = await _drive_stream(bot, question, "urgent-with-question")

    assert classifier.calls == [question]
    assert _answer_text(frames).startswith("This sounds urgent")
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_an_incident_with_a_document_request_gets_the_urgent_reply_and_no_card(db, monkeypatch, alerts):
    """The urgent check runs before the document route. A visitor under attack who
    also asks for a brochure gets the priority reply and one alert, and no model
    call is spent deciding about the brochure."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-brochure")
    cap = _stub_pipeline(monkeypatch, retrieved=(_doc("Acme runs incident response."),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)
    brochure = {
        "url": "https://acme.com/files/Incident-Response-Brochure.pdf",
        "name": "Incident-Response-Brochure.pdf",
    }
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: [{"files": [brochure]}])
    document_calls: list[str] = []
    monkeypatch.setattr(
        document_request, "_classify_document_request_raw", lambda q: document_calls.append(q) or "send"
    )

    frames = await _drive_stream(
        bot, "we are under a ransomware attack right now, send me your incident response brochure", "urgent-brochure"
    )

    meta = _final_meta(frames)
    assert _answer_text(frames).startswith("This sounds urgent")
    assert "media_card" not in meta
    assert meta["suggest_handoff"] is True
    assert document_calls == []
    assert cap["prompts"] == []
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_follow_ups_after_the_urgent_reply_alert_no_one_again_and_get_no_unhelped_offer(db, monkeypatch, alerts):
    """Follow-ups the relevance gate rejects ("please hurry, what do we do now?") go
    down the normal refusal path. The team was already alerted and offered, so there
    is no second alert, no repeat of the urgent reply and no unhelped offer, while
    the unhelped count still records the misses."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "urgent-follow-ups")
    _stub_pipeline(monkeypatch, retrieved=(_doc("Acme sells office chairs."),), support=True, relevant=False)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)
    offer = unhelped_offer(live_chat_enabled=True, team_available=True).text

    await _drive_stream(bot, URGENT, "urgent-follow-ups")
    replies = [
        _answer_text(await _drive_stream(bot, message, "urgent-follow-ups"))
        for message in ("please hurry, what do we do now?", "hello?? is anyone there")
    ]

    assert len(alerts["notify"]) == 1
    for reply in replies:
        assert offer not in reply, reply
        assert "This sounds urgent" not in reply and "flagged" not in reply, reply
    shown = _cards_shown(db, "urgent-follow-ups")
    assert shown.get("handoff_offered") is True
    assert shown.get("unhelped_streak") == 2
