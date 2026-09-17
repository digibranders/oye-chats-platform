"""The chat stream corrects a service commitment the reference does not state as the company's own.

Production, 2026-09-17: "whats ur SLA for patching critical CVEs? like in how
many hours" got "We remediate critical-severity findings within 48 hours." from
a general best-practices page. The saved message, the QA cache, the widget
(``answer_override``) and ``POST /chat`` must all get the corrected text.
"""

import pytest

from app.services import rag_service as rs
from app.services.commitment_guard import COMMITMENT_GAP_SENTENCE
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
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

QUESTION = "whats ur SLA for patching critical CVEs? like in how many hours"
CHUNKS = (
    "We remediate critical-severity findings ",
    "within 48 hours. ",
    "Want me to take a message for our team?",
)
#: The pipeline sets a closing question apart as its own paragraph.
CORRECTED = f"{COMMITMENT_GAP_SENTENCE}\n\nWant me to take a message for our team?"
ARTICLE_KB = (
    _doc(
        "#### _Alert Triage SLAs_\n*   Remediate critical-severity findings within 48 hours\n",
        name="https://acme.com/cybersecurity/vulnerability-management/computer-security/",
    ),
)
OWN_KB = (_doc("We remediate critical-severity findings within 48 hours.", name="https://acme.com/services/soc/"),)


@pytest.fixture()
def metrics(monkeypatch):
    seen: list[tuple[str, dict]] = []
    real = rs._safety_net_metric

    def spy(name, **tags):
        seen.append((name, tags))
        real(name, **tags)

    monkeypatch.setattr(rs, "_safety_net_metric", spy)
    return seen


def _setup(db, monkeypatch, session_id, retrieved):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, session_id)
    captured = _stub_pipeline(monkeypatch, retrieved=retrieved, chunks=CHUNKS)
    _anonymous_visitor(monkeypatch)
    return bot, captured


@pytest.mark.asyncio
async def test_an_unsupported_commitment_is_corrected_everywhere(db, monkeypatch, metrics):
    bot, captured = _setup(db, monkeypatch, "commit-1", ARTICLE_KB)

    frames = await _drive_stream(bot, QUESTION, "commit-1")

    meta = _final_meta(frames)
    assert meta["answer_override"] == CORRECTED
    assert [m.content for m in _messages(db, "commit-1", role="bot")] == [CORRECTED]
    assert [tags["figures"] for name, tags in metrics if name == "commitment_figure_redacted"] == ["48 hours"]
    # The streamed frames could not be recalled; the override replaces them.
    assert "48 hours" in _answer_text(frames)
    for cached in captured["cache"].store.values():
        assert "48" not in cached["answer"]


@pytest.mark.asyncio
async def test_a_supported_commitment_streams_unchanged(db, monkeypatch, metrics):
    bot, _ = _setup(db, monkeypatch, "commit-2", OWN_KB)

    frames = await _drive_stream(bot, QUESTION, "commit-2")

    assert "answer_override" not in _final_meta(frames)
    assert _answer_text(frames) == "".join(CHUNKS)
    assert [m.content for m in _messages(db, "commit-2", role="bot")] == [
        "We remediate critical-severity findings within 48 hours.\n\nWant me to take a message for our team?"
    ]
    assert [name for name, _ in metrics if name == "commitment_figure_redacted"] == []


@pytest.mark.asyncio
async def test_the_non_streaming_reply_is_the_corrected_text(db, monkeypatch):
    bot, _ = _setup(db, monkeypatch, "commit-3", ARTICLE_KB)

    payload = await rs.collect_rag_pipeline(bot, QUESTION, session_id="commit-3", bot_id=bot.id)

    assert payload["answer"] == CORRECTED
    assert [m.content for m in _messages(db, "commit-3", role="bot")] == [CORRECTED]


FRANCE_QUESTION = "d'accord, et c'est disponible en France ?"
FRANCE_CHUNKS = ("Yes, France is listed among the countries we serve. ", "Our SOC runs 24x7.")
FRANCE_CORRECTED = "I don't have a statement about serving France here. Our SOC runs 24x7."
DROPDOWN_KB = (
    _doc(
        "Select Country\nDjibouti\nDominica\nEcuador\nEgypt\nFinland\nFrance\nFrench Guiana\nGabon",
        name="https://acme.com/cybersecurity/security-operations-market/",
    ),
)


@pytest.mark.asyncio
async def test_an_unsupported_country_claim_is_corrected_everywhere(db, monkeypatch, metrics):
    """Production, 2026-09-17 14:25 UTC: the Eventus Security bot said it serves France."""
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "country-1")
    captured = _stub_pipeline(monkeypatch, retrieved=DROPDOWN_KB, chunks=FRANCE_CHUNKS)
    _anonymous_visitor(monkeypatch)

    frames = await _drive_stream(bot, FRANCE_QUESTION, "country-1")

    assert _final_meta(frames)["answer_override"] == FRANCE_CORRECTED
    assert [m.content for m in _messages(db, "country-1", role="bot")] == [FRANCE_CORRECTED]
    assert [tags["countries"] for name, tags in metrics if name == "country_claim_redacted"] == ["France"]
    for cached in captured["cache"].store.values():
        assert "France is listed" not in cached["answer"]


@pytest.mark.asyncio
async def test_a_supported_country_claim_streams_unchanged(db, monkeypatch, metrics):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _make_session(db, bot, client, "country-2")
    own = (_doc("Acme has offices in Paris, France and Pune, India.", name="https://acme.com/contact-us/"),)
    _stub_pipeline(monkeypatch, retrieved=own, chunks=("Yes, we have an office in France.",))
    _anonymous_visitor(monkeypatch)

    frames = await _drive_stream(bot, FRANCE_QUESTION, "country-2")

    assert "answer_override" not in _final_meta(frames)
    assert [name for name, _ in metrics if name == "country_claim_redacted"] == []
