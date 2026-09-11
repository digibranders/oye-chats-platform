"""The support reply is fixed wording, opens the channel the plan has and alerts the team once per conversation."""

import time

import pytest

from app.db.models import ChatSession, LeadInfo
from app.db.repository import get_lead_info_by_session
from app.services import rag_service as rs
from app.services import support_route, urgent_route
from app.services.handoff_reply import handoff_reply
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

#: The production messages of 2026-09-11.
PORTAL_DOWN = "im already a customer, our portal is not loading since morning"
UNRESPONSIVE = "our account manager isnt responding for 3 days"
ESCALATION = "i need the escalation matrix now"
MONEY_BACK = "paid for the service, not happy at all, want my money back"
URGENT = "we are under a ransomware attack right now, please help!"
PUSH_TASK = "task_dispatch_handoff_push"
PUSH_REASON = "Existing customer needs help in chat"
TEAM_EMAILS = {"default": ["cs@acme.test"]}
KNOWLEDGE = "Acme runs a customer portal. Check your login, clear the browser cache and try again."

ACKNOWLEDGEMENT = "Thanks for flagging this. It needs our team to handle it directly, so I've let them know."


class _Classifier:
    """Stands in for the gate model behind a route's classifier."""

    def __init__(self, answer: bool) -> None:
        self.answer = answer
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
    passes the support vocabulary check unless a test says otherwise."""
    fake = _Classifier(answer=True)
    monkeypatch.setattr(support_route, "_classify_support_request_raw", fake)
    return fake


@pytest.fixture(autouse=True)
def urgent_classifier(monkeypatch):
    fake = _Classifier(answer=True)
    monkeypatch.setattr(urgent_route, "_classify_urgent_incident_raw", fake)
    return fake


@pytest.fixture()
def alerts(monkeypatch):
    """The urgent route alerts from ``rag_service`` and the support route from its
    own module; both write into the same outbox."""
    sent: dict[str, list] = {"notify": [], "emails": [], "enqueue": []}
    for module in (rs, support_route):
        monkeypatch.setattr(module, "notify_handoff_request", lambda *_a, **kwargs: sent["notify"].append(kwargs))
        monkeypatch.setattr(
            module,
            "send_handoff_request_email",
            lambda recipient, _bot_name, reason, contact=None, **kwargs: sent["emails"].append(
                {"to": recipient, "reason": reason, "contact": contact, **kwargs}
            ),
        )
        monkeypatch.setattr(module, "enqueue_sync", lambda task, *args, **_kwargs: sent["enqueue"].append((task, args)))
    return sent


def _push_jobs(alerts):
    return [args for task, args in alerts["enqueue"] if task == PUSH_TASK]


def _cards_shown(db, session_id):
    db.expire_all()
    return db.get(ChatSession, session_id).inline_cards_shown or {}


@pytest.mark.asyncio
async def test_a_support_turn_is_fixed_wording_with_the_form_and_one_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "support-1")
    db.add(LeadInfo(session_id="support-1", bot_id=bot.id, name="Eva", email="eva@x.test"))
    db.commit()
    cap = _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)

    frames = await _drive_stream(bot, PORTAL_DOWN, "support-1")
    answer = _answer_text(frames)
    meta = _final_meta(frames)

    assert answer == f"{ACKNOWLEDGEMENT} Share your details in the form below and I'll pass them to our team."
    assert "clear the browser cache" not in answer, "no troubleshooting"
    assert meta["suggest_handoff"] is True
    assert meta["qualification_pending"] is False
    assert "show_leave_message" not in meta
    persisted = _messages(db, "support-1", role="bot")
    assert [m.id for m in persisted] == [meta["message_id"]]
    assert persisted[0].content == answer

    again = await _drive_stream(bot, ESCALATION, "support-1")

    assert _answer_text(again) == (
        "Our team already knows about this. The form is just below: share your details there and "
        "I'll pass them to our team."
    )
    assert _final_meta(again)["suggest_handoff"] is True
    assert cap["prompts"] == [], "the support reply is not a model call"
    assert alerts["notify"] == [
        {"client_id": client.id, "session_id": "support-1", "visitor_name": "Eva", "bot_name": bot.name}
    ]
    assert alerts["emails"] == [
        {
            "to": "cs@acme.test",
            "reason": PORTAL_DOWN,
            "contact": {"name": "Eva", "email": "eva@x.test", "phone": None},
            "reply_to": None,
            "support": True,
            "session_id": "support-1",
        }
    ]
    assert _push_jobs(alerts) == [("support-1", bot.id, None, "Eva", PUSH_REASON, 60)]
    shown = _cards_shown(db, "support-1")
    assert shown.get("support_notified") is True
    assert shown.get("handoff_offered") is True


@pytest.mark.asyncio
@pytest.mark.parametrize("question", [PORTAL_DOWN, UNRESPONSIVE, ESCALATION, MONEY_BACK])
async def test_every_production_message_gets_the_team_not_an_answer(db, monkeypatch, alerts, classifier, question):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-defects")
    cap = _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)

    frames = await _drive_stream(bot, question, "support-defects")

    assert classifier.calls == [question]
    assert _answer_text(frames) == (
        f"{ACKNOWLEDGEMENT} Share your details in the form below and I'll connect you with our team."
    )
    assert cap["prompts"] == []
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_bot_without_live_chat_opens_the_message_card(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=False)
    _make_session(db, bot, client, "support-card")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)

    frames = await _drive_stream(bot, MONEY_BACK, "support-card")
    meta = _final_meta(frames)

    assert _answer_text(frames) == f"{ACKNOWLEDGEMENT} I'll open a quick message form so our team can contact you."
    assert meta["suggest_handoff"] is False
    assert meta["show_leave_message"] is True
    shown = _cards_shown(db, "support-card")
    assert shown.get("leave_message") is True
    assert not shown.get("handoff_offered")

    again = await _drive_stream(bot, UNRESPONSIVE, "support-card")

    assert _answer_text(again) == (
        "Our team already knows about this. Leave your details in the message form so our team can contact you."
    )
    assert _final_meta(again)["show_leave_message"] is True
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_plan_without_a_human_points_to_the_business_and_sends_no_alert(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "support-free")
    cap = _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=False)

    frames = await _drive_stream(bot, PORTAL_DOWN, "support-free")
    answer = _answer_text(frames)

    assert answer.startswith(
        "Thanks for flagging this. It needs **Acme** to handle it directly, so please contact them"
    )
    assert "let them know" not in answer
    assert not (_final_meta(frames) or {}).get("suggest_handoff")
    assert not (_final_meta(frames) or {}).get("show_leave_message")
    assert cap["prompts"] == []
    again = await _drive_stream(bot, PORTAL_DOWN, "support-free")
    assert _answer_text(again) == answer
    assert alerts["notify"] == [] and alerts["emails"] == [] and alerts["enqueue"] == []
    assert not _cards_shown(db, "support-free").get("support_notified")


@pytest.mark.asyncio
async def test_an_owner_preview_shows_the_support_reply_and_alerts_no_one(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "support-preview")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    bot._is_preview = True

    frames = await _drive_stream(bot, PORTAL_DOWN, "support-preview")

    assert _answer_text(frames).startswith(ACKNOWLEDGEMENT)
    assert _final_meta(frames)["suggest_handoff"] is True
    assert alerts["notify"] == [] and alerts["emails"] == [] and alerts["enqueue"] == []


@pytest.mark.asyncio
async def test_the_reply_and_the_alert_are_saved_before_the_first_frame(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "support-early")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)

    stream = rs.rag_pipeline_stream(bot, PORTAL_DOWN, "support-early", bot_id=bot.id)
    first = await stream.__anext__()
    await stream.aclose()

    assert first.startswith("METADATA:")
    db.expire_all()
    persisted = _messages(db, "support-early", role="bot")
    assert len(persisted) == 1 and persisted[0].content.startswith(ACKNOWLEDGEMENT)
    assert len(alerts["notify"]) == 1
    assert _cards_shown(db, "support-early").get("support_notified") is True


@pytest.mark.asyncio
async def test_the_non_streaming_path_returns_the_same_reply_and_flags(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-collect")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)

    payload = await rs.collect_rag_pipeline(bot, UNRESPONSIVE, session_id="support-collect", bot_id=bot.id)

    assert payload["answer"] == (
        f"{ACKNOWLEDGEMENT} Share your details in the form below and I'll connect you with our team."
    )
    assert payload["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
async def test_a_support_turn_resets_the_unhelped_streak(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-streak")
    session_row = db.get(ChatSession, "support-streak")
    session_row.inline_cards_shown = {"unhelped_streak": 1}
    db.commit()
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)

    await _drive_stream(bot, PORTAL_DOWN, "support-streak")

    assert "unhelped_streak" not in _cards_shown(db, "support-streak")


@pytest.mark.asyncio
async def test_a_message_the_classifier_rejects_gets_the_normal_answer(db, monkeypatch, alerts, classifier):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True, notification_emails=TEAM_EMAILS)
    _make_session(db, bot, client, "support-rejected")
    cap = _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    classifier.answer = False
    question = "my dockerfile build keeps showing an error"

    frames = await _drive_stream(bot, question, "support-rejected")

    assert classifier.calls == [question]
    assert KNOWLEDGE in _answer_text(frames)
    assert cap["prompts"], "the normal pipeline wrote the answer"
    assert alerts["notify"] == [] and alerts["emails"] == [] and _push_jobs(alerts) == []
    assert not _cards_shown(db, "support-rejected").get("support_notified")


@pytest.mark.asyncio
async def test_a_classifier_that_misses_the_deadline_hands_the_turn_to_the_fallback_rules(
    db, monkeypatch, alerts, classifier
):
    """The late classifier would have said NO; the rules read the visitor's own
    portal failing, so the visitor still gets the team."""
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-timeout")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(support_route, "_SUPPORT_INTENT_TIMEOUT_S", 0.05)
    classifier.answer, classifier.delay_s = False, 0.5

    frames = await _drive_stream(bot, PORTAL_DOWN, "support-timeout")

    assert _answer_text(frames).startswith(ACKNOWLEDGEMENT)
    assert classifier.calls == [PORTAL_DOWN]
    assert len(alerts["notify"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(("question", "expected"), [(PORTAL_DOWN, True), ("my dockerfile build keeps failing", False)])
async def test_the_bounded_check_uses_the_fallback_rules_on_a_timeout(monkeypatch, classifier, question, expected):
    monkeypatch.setattr(support_route, "_SUPPORT_INTENT_TIMEOUT_S", 0.05)
    classifier.answer, classifier.delay_s = not expected, 0.5

    assert await support_route.detect_support_request_bounded(question) is expected


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", [True, False])
async def test_the_bounded_check_takes_the_classifier_answer_in_time(monkeypatch, classifier, answer):
    monkeypatch.setattr(support_route, "_SUPPORT_INTENT_TIMEOUT_S", 1.0)
    classifier.answer = answer

    assert await support_route.detect_support_request_bounded(PORTAL_DOWN) is answer


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "question", ["what services do you offer?", "do you offer 24/7 support?", "what is your refund policy"]
)
async def test_a_turn_without_support_words_never_asks_the_classifier(db, monkeypatch, alerts, classifier, question):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-plain")
    cap = _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)

    frames = await _drive_stream(bot, question, "support-plain")

    assert classifier.calls == []
    assert KNOWLEDGE in _answer_text(frames)
    assert len(cap["prompts"]) == 1
    assert alerts["notify"] == []


@pytest.mark.asyncio
async def test_a_policy_question_never_asks_the_classifier(db, monkeypatch, alerts, classifier):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-policy")
    knowledge = "Enterprise accounts escalate to a named duty manager within four hours."
    cap = _stub_pipeline(monkeypatch, chunks=(knowledge,), retrieved=(_doc(knowledge),), support=True)

    frames = await _drive_stream(bot, "what is your escalation process for enterprise accounts?", "support-policy")

    assert classifier.calls == []
    assert knowledge in _answer_text(frames)
    assert len(cap["prompts"]) == 1
    assert alerts["notify"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("question", "classified"), [("what services do you offer?", False), (PORTAL_DOWN, True)])
async def test_a_turn_runs_the_vocabulary_check_once_and_classifies_only_a_hit(
    db, monkeypatch, alerts, classifier, question, classified
):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-once")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    checked: list[object] = []
    real_check = support_route.might_be_support_request

    def _counting_check(message: object) -> bool:
        checked.append(message)
        return real_check(message)

    monkeypatch.setattr(support_route, "might_be_support_request", _counting_check)

    await _drive_stream(bot, question, "support-once")

    assert len(checked) == 1
    assert len(classifier.calls) == (1 if classified else 0)


@pytest.mark.asyncio
async def test_an_urgent_incident_takes_precedence_and_the_support_classifier_is_never_asked(
    db, monkeypatch, alerts, classifier, urgent_classifier
):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-urgent")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    question = "we are under a ransomware attack right now, our portal is not loading, please help!"

    frames = await _drive_stream(bot, question, "support-urgent")

    assert _answer_text(frames).startswith("This sounds urgent")
    assert urgent_classifier.calls == [question]
    assert classifier.calls == []
    assert len(alerts["notify"]) == 1 and alerts["notify"][0]["urgent"] is True
    assert not _cards_shown(db, "support-urgent").get("support_notified")


@pytest.mark.asyncio
async def test_a_support_turn_after_an_urgent_alert_is_a_repeat_and_alerts_no_one_again(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-after-urgent")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: True)

    await _drive_stream(bot, URGENT, "support-after-urgent")
    frames = await _drive_stream(bot, PORTAL_DOWN, "support-after-urgent")

    assert _answer_text(frames) == (
        "Our team already knows about this. The form is just below: share your details there and "
        "I'll connect you with our team."
    )
    assert len(alerts["notify"]) == 1 and alerts["notify"][0]["urgent"] is True


@pytest.mark.asyncio
async def test_a_support_request_in_the_first_message_is_not_held_behind_the_name_question(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-first")
    real = rs.resolve_name_flow, rs.resolve_visitor_name, rs._should_ask_visitor_name
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "resolve_name_flow", real[0])
    monkeypatch.setattr(rs, "resolve_visitor_name", real[1])
    monkeypatch.setattr(rs, "_should_ask_visitor_name", real[2])

    frames = await _drive_stream(bot, PORTAL_DOWN, "support-first")
    answer = _answer_text(frames)

    assert answer.startswith(ACKNOWLEDGEMENT), answer
    assert not rs._is_name_ask_message(answer)
    assert len(alerts["notify"]) == 1
    assert alerts["notify"][0]["visitor_name"] is None
    lead = get_lead_info_by_session(db, "support-first")
    assert lead is None or lead.name is None


@pytest.mark.asyncio
async def test_ok_after_the_support_reply_opens_the_form_not_the_ack(db, monkeypatch, alerts):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=True)
    _make_session(db, bot, client, "support-ok")
    _stub_pipeline(monkeypatch, chunks=(KNOWLEDGE,), retrieved=(_doc(KNOWLEDGE),), support=True)
    monkeypatch.setattr(rs, "route_intent", real_route_intent)
    monkeypatch.setattr(rs, "_live_team_reachable", lambda *_a, **_k: False)

    await _drive_stream(bot, PORTAL_DOWN, "support-ok")
    frames = await _drive_stream(bot, "ok", "support-ok")

    answer = _answer_text(frames)
    assert "Glad that helped" not in answer
    assert answer.endswith(handoff_reply(team_available=False, repeat=True)), answer
    assert _final_meta(frames)["suggest_handoff"] is True
    assert len(alerts["notify"]) == 1
