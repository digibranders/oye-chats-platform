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

from app.services import credential_facts, document_request
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _answer_text,
    _Cache,
    _doc,
    _drive_stream,
    _final_meta,
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

#: CleanStart's own vendor-risk page on production, 2026-09-18: the SOC 2
#: status it holds, the ISO 27001 status it does not yet hold, and an appendix
#: listing the certificate among documents available under NDA.
PENDING_PAGE = _doc(
    "### ISO 27001 Certification\n"
    "**Current Status**: ISO 27001 certification in progress; expected completion Q2 2026\n"
    "**Interim Measures**: Current controls documented in internal ISMS",
    name="https://acme.example/knowledge-hub/secure-vendor-risk-assessment",
)
APPENDIX_PAGE = _doc(
    "## Appendix A: Certification and Compliance Artifacts\n"
    "The following documents are available upon request (typically via signed NDA):\n"
    "1.   **SOC 2 Type II Report** (12-month audit, completed [Date])\n"
    "2.   **ISO 27001 Certificate** (once audit completed, Q2 2026)",
    name="https://acme.example/knowledge-hub/secure-vendor-risk-assessment",
)
#: Eventus's own "Top 10 SOC Service Providers in India" page: a ranked list
#: where every entry names certifications, only one entry of which is Acme.
LISTICLE_PAGE = _doc(
    "Acme\n* **Certifications**: CERT-In empaneled, ISO 27001 certified.\n"
    "Globex\n* **Certifications**: ISO 27001, SOC 2, PCI-DSS.",
    name="https://acme.example/cybersecurity/india/soc-service-providers/",
)


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


def _streaming(captured, answer: str):
    """The answering model, writing ``answer`` instead of the fixture's chunks."""

    async def fake_stream(prompt, **kwargs):
        captured["prompts"].append((kwargs.get("system_prompt"), prompt))
        yield answer

    return fake_stream


class _DocumentClassifier:
    """Stands in for the gate model behind ``document_request.decide_document_intent``."""

    def __init__(self) -> None:
        self.answer = "send"
        self.calls: list[str] = []

    def __call__(self, question: str) -> str:
        self.calls.append(question)
        return self.answer


@pytest.fixture(autouse=True)
def document_classifier(monkeypatch):
    """ "report" is a document noun, so "share your SOC 2 type 2 report" reaches
    the document route. Its classifier says SEND here, the label that sends a
    turn to the file reply, so every test in this file shows the credential
    question winning over it (no test reaches a real model)."""
    fake = _DocumentClassifier()
    monkeypatch.setattr(document_request, "_classify_document_request_raw", fake)
    return fake


SOC_DATASHEET = "https://acme.example/files/SOC-as-a-Service-Datasheet.pdf"
BREACH_REPORT = "https://acme.example/files/cost-of-a-data-breach-2025-full-report.pdf"
VENDOR_RISK_WHITEPAPER = "https://acme.example/files/Vendor-Risk-Whitepaper.pdf"
SOC_2_REPORT = "https://acme.example/files/SOC-2-Type-2-Report.pdf"
NO_FILE_REPLY = "don't have a downloadable document"


def _catalog(monkeypatch, *urls):
    catalog = [{"files": [{"url": url, "name": url.rsplit("/", 1)[-1]} for url in urls]}]
    monkeypatch.setattr(rs, "get_bot_media_urls", lambda *_a, **_k: catalog)


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


@pytest.mark.asyncio
async def test_a_pending_certification_reaches_the_visitor_as_in_progress(db, monkeypatch, model, metrics):
    """Production, 2026-09-18: CleanStart offered an "ISO 27001 Certificate"
    under NDA, dropping its own page's "(once audit completed, Q2 2026)"."""
    model.reply = 'ISO 27001 | HELD | DOC 2 | "ISO 27001 Certificate"'
    reply = "Our ISO 27001 certification is in progress, with completion expected in Q2 2026."
    bot, captured = _bot(db, monkeypatch, "cred-pending", retrieved=(PENDING_PAGE, APPENDIX_PAGE))
    monkeypatch.setattr(rs, "generate_response_stream", _streaming(captured, reply))

    frames = await _drive_stream(bot, "can you share your ISO 27001 certificate", "cred-pending")

    prompt = _user_prompt(captured)
    assert "- ISO 27001: not held by Acme yet, still in progress." in prompt
    assert "expected completion Q2 2026" in prompt
    assert "never say Acme has its certificate or report" in prompt
    assert "held by Acme (stated on" not in prompt

    answer = _answer_text(frames)
    assert "in progress" in answer
    assert "certificate is available" not in answer.casefold()
    assert _named(metrics, "credential_facts_checked")[0]["pending"] == 1


@pytest.mark.asyncio
async def test_a_ranked_list_of_providers_never_confirms_our_own_certification(db, monkeypatch, model, metrics):
    """Production, 2026-09-18: Eventus answered "ISO 27001 certified" for
    itself out of its own "Top 10 SOC Service Providers in India" listicle."""
    model.reply = 'ISO 27001 | HELD | DOC 1 | "CERT-In empaneled, ISO 27001 certified"'
    bot, captured = _bot(db, monkeypatch, "cred-listicle", retrieved=(LISTICLE_PAGE,))

    await _drive_stream(bot, "are you iso 27001 certified? need it for our vendor onboarding form", "cred-listicle")

    prompt = _user_prompt(captured)
    assert "- ISO 27001: could not be confirmed from the reference information." in prompt
    assert "held by Acme" not in prompt
    assert _named(metrics, "credential_facts_checked")[0]["held"] == 0


# ── A credential question that names a report is not a file request ──────────
# Review 2026-09-30: "report" became a document noun on this branch, the
# document route returns before the credential check, and the classifier reads
# "share your SOC 2 type 2 report" as SEND. CleanStart stopped saying the report
# is available under NDA and said "I don't have a downloadable document for that
# here"; Eventus offered IBM's breach report as its own SOC 2 report.


@pytest.mark.asyncio
async def test_a_credential_question_the_classifier_reads_as_send_gets_the_credential_answer(
    db, monkeypatch, model, metrics
):
    """CleanStart: a catalog with no SOC 2 report in it."""
    model.reply = 'SOC 2 | HELD | DOC 1 | "SOC 2 Type II Report"'
    reply = "Our SOC 2 Type II report is available on request under a signed NDA."
    bot, captured = _bot(db, monkeypatch, "cred-doc-send", retrieved=(APPENDIX_PAGE,))
    monkeypatch.setattr(rs, "generate_response_stream", _streaming(captured, reply))
    _catalog(monkeypatch, SOC_DATASHEET)

    frames = await _drive_stream(bot, "can u share your SOC 2 type 2 report", "cred-doc-send")

    answer = _answer_text(frames)
    assert NO_FILE_REPLY not in answer
    assert "under a signed NDA" in answer
    assert "CREDENTIAL FACTS" in _user_prompt(captured)
    (tags,) = _named(metrics, "document_request_fell_through")
    assert tags["reason"] == "credentials"
    assert tags["found"] == "0"
    assert _named(metrics, "document_request") == []
    assert _named(metrics, "credential_facts_checked")


@pytest.mark.asyncio
async def test_a_credential_question_never_gets_a_third_party_report_as_the_download(db, monkeypatch, model, metrics):
    """Eventus: the only "report" in the catalog is IBM's."""
    bot, captured = _bot(db, monkeypatch, "cred-doc-ibm", retrieved=(PLAIN_PAGE,))
    _catalog(monkeypatch, BREACH_REPORT, SOC_DATASHEET)

    frames = await _drive_stream(bot, "our vendor risk team is asking for ur soc 2 type ii report", "cred-doc-ibm")

    assert "media_card" not in _final_meta(frames)
    assert "data breach" not in _answer_text(frames).casefold()
    assert "- SOC 2: not stated anywhere in the reference information." in _user_prompt(captured)
    assert _named(metrics, "document_request_fell_through")[0]["reason"] == "credentials"


@pytest.mark.asyncio
async def test_a_credential_question_with_only_an_inexact_file_is_answered_by_the_model(
    db, monkeypatch, model, metrics
):
    bot, captured = _bot(db, monkeypatch, "cred-doc-inexact", retrieved=(PLAIN_PAGE,))
    _catalog(monkeypatch, VENDOR_RISK_WHITEPAPER)
    question = "our vendor risk team is asking for ur soc 2 type ii report"
    pick = document_request.pick_documents(question, "Acme", rs.get_bot_media_urls())
    assert [d["url"] for d in pick.docs] == [VENDOR_RISK_WHITEPAPER], "precondition: the route has a file to guess"
    assert pick.exact is False

    frames = await _drive_stream(bot, question, "cred-doc-inexact")

    assert "I don't have that exact document" not in _answer_text(frames)
    assert "CREDENTIAL FACTS" in _user_prompt(captured)
    (tags,) = _named(metrics, "document_request_fell_through")
    assert tags["reason"] == "credentials"
    assert tags["found"] == "1"


@pytest.mark.asyncio
async def test_a_credential_follow_up_naming_a_report_is_read_on_its_rewrite(db, monkeypatch, model, metrics):
    bot, captured = _bot(db, monkeypatch, "cred-doc-follow-up", retrieved=(PLAIN_PAGE,))
    _catalog(monkeypatch, SOC_DATASHEET)

    async def fake_resolve(session_id, question, history, bid, cid, company_name, embedding_profile=None):
        return "can Acme share its SOC 2 type 2 report", None

    monkeypatch.setattr(rs, "_resolve_search_query_and_embedding", fake_resolve)

    frames = await _drive_stream(bot, "can u share the report pls", "cred-doc-follow-up")

    assert NO_FILE_REPLY not in _answer_text(frames)
    assert "- SOC 2: not stated anywhere in the reference information." in _user_prompt(captured)
    assert _named(metrics, "document_request_fell_through")[0]["reason"] == "credentials"


@pytest.mark.asyncio
async def test_a_credential_question_with_the_exact_report_in_the_catalog_still_gets_the_file(
    db, monkeypatch, model, metrics, document_classifier
):
    bot, captured = _bot(db, monkeypatch, "cred-doc-exact", retrieved=(PLAIN_PAGE,))
    _catalog(monkeypatch, SOC_2_REPORT, BREACH_REPORT)

    frames = await _drive_stream(bot, "can u share your SOC 2 type 2 report", "cred-doc-exact")

    assert document_classifier.calls == ["can u share your SOC 2 type 2 report"]
    assert _final_meta(frames)["media_card"]["url"] == SOC_2_REPORT
    assert captured["prompts"] == []
    assert _named(metrics, "document_request_fell_through") == []
