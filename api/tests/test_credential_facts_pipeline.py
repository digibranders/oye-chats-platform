"""The credential check, driven through the real chat stream.

Production evaluation, 2026-09-17: Eventus answered "can u share your SOC 2 type
2 report" with "Our SOC 2 Type 2 report is typically shared under NDA", and had
said it was ISO 27001 certified when ISO 27001 is only a service it offers. A
question about the company's own credentials now gets a CREDENTIAL FACTS block
in the per-turn prompt, checked against the turn's retrieval. The gate model is
a fake here; the prefilter, the fallback, the block and the wiring run unmocked.
"""

import asyncio
import time

import pytest

from app.services import credential_facts
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _Cache,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

SERVICES_PAGE = _doc(
    "Acme offers ISO 27001 implementation and audit support for clients. We run a 24x7 SOC.",
    name="https://acme.example/services/iso-27001/",
)
ABOUT_PAGE = _doc("Acme is CERT-In empanelled. We are proud of our team.", name="https://acme.example/about/")
PLAIN_PAGE = _doc("We run a 24x7 SOC for banks and fintechs.", name="https://acme.example/services/soc/")


class _Model:
    """Stands in for the gate model behind ``credential_facts``."""

    def __init__(self, reply: str = "", delay_s: float = 0.0) -> None:
        self.reply = reply
        self.delay_s = delay_s
        self.prompts: list[str] = []

    def __call__(self, prompt, **_kwargs):
        self.prompts.append(prompt)
        if self.delay_s:
            time.sleep(self.delay_s)
        return self.reply, False


class _RecordingCache(_Cache):
    """A QA cache that answers every read with a stale, pre-check answer."""

    STALE = "Yes, Acme is ISO 27001 certified and our SOC 2 report is shared under NDA."

    def __init__(self):
        super().__init__()
        self.reads: list[str] = []

    def get(self, key):
        self.reads.append(key)
        return {"answer": self.STALE, "sources": []}


@pytest.fixture()
def model(monkeypatch):
    fake = _Model()
    monkeypatch.setattr(credential_facts, "generate_response_checked", fake)
    return fake


@pytest.fixture()
def metrics(monkeypatch):
    seen: list[tuple[str, dict]] = []
    real = rs._safety_net_metric

    def spy(name, **tags):
        seen.append((name, tags))
        real(name, **tags)

    monkeypatch.setattr(rs, "_safety_net_metric", spy)
    return seen


def _named(metrics, name):
    return [tags for seen, tags in metrics if seen == name]


def _bot(db, monkeypatch, session_id, *, retrieved, support=True, cache=None):
    client = _make_client(db)
    bot = _make_bot(db, client, live_chat_enabled=support)
    _make_session(db, bot, client, session_id)
    captured = _stub_pipeline(
        monkeypatch, retrieved=retrieved, support=support, chunks=("Here is what I can say.",), cache=cache
    )
    return bot, captured


def _user_prompt(captured):
    (_system, prompt), *_ = captured["prompts"]
    return prompt


@pytest.mark.asyncio
async def test_a_credential_question_gets_the_checked_facts_in_the_prompt(db, monkeypatch, model, metrics):
    model.reply = 'ISO 27001 | OFFERED\nCERT-In | HELD | DOC 2 | "Acme is CERT-In empanelled"'
    bot, captured = _bot(db, monkeypatch, "cred-offered", retrieved=(SERVICES_PAGE, ABOUT_PAGE))

    await _drive_stream(bot, "are you ISO 27001 certified?", "cred-offered")

    prompt = _user_prompt(captured)
    assert len(model.prompts) == 1
    assert "[DOC 1 | https://acme.example/services/iso-27001/]" in model.prompts[0]
    assert "CREDENTIAL FACTS (checked against the reference information for this question)" in prompt
    assert "- ISO 27001: a service Acme offers its customers, not a credential Acme holds." in prompt
    assert "- CERT-In: held by Acme (stated on https://acme.example/about/)." in prompt
    assert "offer to connect the visitor with the team" in prompt
    # After the reference information, before the conversation history.
    assert (
        prompt.index("REFERENCE INFORMATION") < prompt.index("CREDENTIAL FACTS") < prompt.index("CONVERSATION HISTORY")
    )
    (tags,) = _named(metrics, "credential_facts_checked")
    assert tags["held"] == 1
    assert tags["offered"] == 1
    assert tags["not_found"] == 0
    assert tags["unverified"] == 0
    assert tags["by_fallback"] is False
    assert tags["bot_id"] == bot.id


@pytest.mark.asyncio
async def test_a_report_the_reference_never_mentions_is_marked_not_found_without_a_model_call(
    db, monkeypatch, model, metrics
):
    bot, captured = _bot(db, monkeypatch, "cred-soc2-report", retrieved=(PLAIN_PAGE,))

    await _drive_stream(bot, "can u share your SOC 2 type 2 report", "cred-soc2-report")

    assert model.prompts == []
    prompt = _user_prompt(captured)
    assert "- SOC 2: not stated anywhere in the reference information." in prompt
    assert "shared under NDA" in prompt
    assert _named(metrics, "credential_facts_checked")[0]["not_found"] == 1


@pytest.mark.asyncio
async def test_an_ordinary_question_gets_no_block_and_an_unchanged_prompt(db, monkeypatch, model, metrics):
    bot, captured = _bot(db, monkeypatch, "cred-ordinary", retrieved=(SERVICES_PAGE,))

    await _drive_stream(bot, "what services do you offer", "cred-ordinary")

    prompt = _user_prompt(captured)
    assert model.prompts == []
    assert "CREDENTIAL FACTS" not in prompt
    assert f"{SERVICES_PAGE.content}\n<<<END DOCUMENT 1>>>\n\n\n{'═' * 55}\nCONVERSATION HISTORY" in prompt
    assert _named(metrics, "credential_facts_checked") == []


@pytest.mark.asyncio
async def test_a_service_request_naming_a_standard_gets_no_block(db, monkeypatch, model):
    bot, captured = _bot(db, monkeypatch, "cred-service", retrieved=(SERVICES_PAGE,))

    await _drive_stream(bot, "can you help us get ISO 27001 certified", "cred-service")

    assert model.prompts == []
    assert "CREDENTIAL FACTS" not in _user_prompt(captured)


@pytest.mark.asyncio
async def test_a_non_english_turn_is_left_to_the_knowledge_base(db, monkeypatch, model, metrics):
    bot, captured = _bot(db, monkeypatch, "cred-hindi", retrieved=(SERVICES_PAGE,))

    await _drive_stream(bot, "क्या आपकी कंपनी ISO 27001 प्रमाणित है? कृपया हमें बताइए", "cred-hindi")

    assert model.prompts == []
    assert "CREDENTIAL FACTS" not in _user_prompt(captured)
    assert _named(metrics, "credential_facts_checked") == []


@pytest.mark.asyncio
async def test_a_stalled_check_uses_the_fallback_rules(db, monkeypatch, model, metrics):
    model.reply = "ISO 27001 | OFFERED"
    model.delay_s = 0.5
    monkeypatch.setattr(credential_facts, "_CREDENTIAL_CHECK_TIMEOUT_S", 0.05)
    bot, captured = _bot(db, monkeypatch, "cred-timeout", retrieved=(SERVICES_PAGE,))

    started = time.perf_counter()
    await _drive_stream(bot, "are you ISO 27001 certified?", "cred-timeout")

    assert time.perf_counter() - started < 0.45
    assert "- ISO 27001: could not be confirmed from the reference information." in _user_prompt(captured)
    (tags,) = _named(metrics, "credential_facts_checked")
    assert tags["by_fallback"] is True
    assert tags["unverified"] == 1


@pytest.mark.asyncio
async def test_a_failed_check_uses_the_fallback_rules(db, monkeypatch, metrics):
    """The conftest default: the gate model is down."""
    bot, captured = _bot(db, monkeypatch, "cred-down", retrieved=(SERVICES_PAGE, ABOUT_PAGE))

    await _drive_stream(bot, "are you cert-in empanelled and iso 27001 certified", "cred-down")

    prompt = _user_prompt(captured)
    assert "- CERT-In: held by Acme (stated on https://acme.example/about/)." in prompt
    assert "- ISO 27001: could not be confirmed from the reference information." in prompt
    assert _named(metrics, "credential_facts_checked")[0]["by_fallback"] is True


@pytest.mark.asyncio
async def test_a_plan_without_a_human_path_gets_no_team_offer(db, monkeypatch, model):
    bot, captured = _bot(db, monkeypatch, "cred-free", retrieved=(PLAIN_PAGE,), support=False)

    await _drive_stream(bot, "what certifications do you have", "cred-free")

    prompt = _user_prompt(captured)
    assert "- No certification, accreditation, attestation, audit report or compliance status held by Acme" in prompt
    assert "offer to connect the visitor with the team" not in prompt


@pytest.mark.asyncio
async def test_a_credential_question_never_reads_or_writes_the_answer_cache(db, monkeypatch, model):
    cache = _RecordingCache()
    bot, captured = _bot(db, monkeypatch, "cred-cache", retrieved=(PLAIN_PAGE,), cache=cache)

    frames = await _drive_stream(bot, "are you ISO 27001 certified?", "cred-cache")

    assert cache.reads == []
    assert cache.store == {}
    assert _RecordingCache.STALE not in "".join(frames)
    assert len(captured["prompts"]) == 1


@pytest.mark.asyncio
async def test_an_ordinary_question_still_reads_the_answer_cache(db, monkeypatch, model):
    cache = _RecordingCache()
    bot, captured = _bot(db, monkeypatch, "cred-cache-control", retrieved=(PLAIN_PAGE,), cache=cache)

    frames = await _drive_stream(bot, "what services do you offer", "cred-cache-control")

    assert len(cache.reads) == 1
    assert _RecordingCache.STALE in "".join(frames)
    assert captured["prompts"] == []


@pytest.mark.asyncio
async def test_a_credential_follow_up_is_checked_on_its_rewrite_and_not_cached(db, monkeypatch, model):
    bot, captured = _bot(db, monkeypatch, "cred-follow-up", retrieved=(PLAIN_PAGE,))

    async def fake_resolve(session_id, question, history, bid, cid, company_name, embedding_profile=None):
        return "is Acme SOC 2 certified", None

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", fake_resolve)

    await _drive_stream(bot, "and that one?", "cred-follow-up")

    assert "- SOC 2: not stated anywhere in the reference information." in _user_prompt(captured)
    assert captured["cache"].store == {}


@pytest.mark.asyncio
async def test_a_visitor_who_leaves_before_generation_leaves_no_check_running(db, monkeypatch, model):
    model.reply = "ISO 27001 | OFFERED"
    model.delay_s = 0.3
    bot, captured = _bot(db, monkeypatch, "cred-left", retrieved=(SERVICES_PAGE,))
    tasks: list = []
    real_create_task = rs.asyncio.create_task

    def spy(coro, **kwargs):
        task = real_create_task(coro, **kwargs)
        if getattr(coro, "__name__", "") == "check_credentials_bounded":
            tasks.append(task)
        return task

    monkeypatch.setattr(rs.asyncio, "create_task", spy)

    stream = rs.rag_pipeline_stream(bot, "are you ISO 27001 certified?", "cred-left", bot_id=bot.id)
    async for frame in stream:
        if frame.startswith("METADATA:"):
            break
    await stream.aclose()

    assert captured["prompts"] == []
    assert len(tasks) == 1
    (task,) = tasks
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()
