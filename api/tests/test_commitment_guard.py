"""A service commitment stays in a reply only when the reference states it as the company's own.

Production, 2026-09-17: the Eventus Security bot was asked "whats ur SLA for
patching critical CVEs? like in how many hours" and answered "We remediate
critical-severity findings within 48 hours. Want me to take a message for our
team?" Its only source was a general best-practices page listing "Alert Triage
SLAs: Remediate critical-severity findings within 48 hours".
"""

import time
from types import SimpleNamespace

import pytest

from app.services.commitment_guard import (
    COMMITMENT_GAP_SENTENCE,
    redact_unsupported_commitments,
    snapshot_chunks,
    supported_figures,
)

EVENTUS = "Eventus Security"
EVENTUS_PAGE = "https://eventussecurity.com/cybersecurity/vulnerability-management/computer-security/"
EVENTUS_CHUNK = (
    f"[Document: {EVENTUS_PAGE}] [Page: 1] ### Establishing Continuous Monitoring and Review\n"
    "#### _Scheduled Scans_\n"
    "*   Monthly full-scope scans plus ad-hoc scans after infrastructure changes\n"
    "#### _Alert Triage SLAs_\n"
    "*   Remediate critical-severity findings within 48 hours\n"
    "*   Address medium-severity findings within 7 days\n"
    "#### _Red-Team Exercises_\n"
    "*   Simulated adversary engagements to validate residual risk\n"
)
PRODUCTION_ANSWER = "We remediate critical-severity findings within 48 hours. Want me to take a message for our team?"


def _chunk(content, name="https://acme.com/services/managed-soc/"):
    return SimpleNamespace(content=content, document_name=name)


def _redact(answer, chunks=(), company="Acme", **kwargs):
    return redact_unsupported_commitments(answer, list(chunks), company_name=company, **kwargs)


def test_the_production_answer_loses_its_figure_and_keeps_the_team_offer():
    result = _redact(PRODUCTION_ANSWER, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS)

    assert result.redacted is True
    assert result.text == f"{COMMITMENT_GAP_SENTENCE} Want me to take a message for our team?"
    assert result.figures == ("48 hours",)
    assert "48" not in result.text


@pytest.mark.parametrize(
    "answer",
    [
        "Our SLA is 99.9% uptime.",
        "We respond within 15 minutes.",
        "Our P1 response is 10 min.",
        "Eventus Security patches critical CVEs in 48 hrs.",
        "Eventus patches critical CVEs within forty-eight hours.",
        "You'll get a response within 4 hours.",
        "We have a documented P1 acknowledge target of ≤ 10 min, but I can't share the contract.",
        "Critical findings are fixed by our analysts within 2 business days.",
        "Within 7 days of signing we start onboarding.",
        "We offer a 4-hour response for P2 incidents.",
    ],
)
def test_an_unsupported_commitment_is_replaced(answer):
    result = _redact(f"{answer} Anything else?", [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS)

    assert result.redacted is True
    assert result.text == f"{COMMITMENT_GAP_SENTENCE} Anything else?"


@pytest.mark.parametrize(
    ("answer", "chunk"),
    [
        # The company speaks in the chunk, and "48 hrs" is the same figure as "48 hours".
        ("We remediate critical findings within 48 hrs.", _chunk("We remediate critical findings within 48 hours.")),
        ("We offer a 48-hour remediation window.", _chunk("Our team closes critical findings within 48 hours.")),
        ("Acme acknowledges P1 alerts within 10 minutes.", _chunk("Acme Corp acknowledges P1 alerts in 10 mins.")),
        # A terms page is the company's own whoever the sentence names.
        (
            "We patch critical CVEs within 24 hours.",
            _chunk(
                "[Document: x] [Page: 1] #### Critical Severity (CVSS 9.0+)\n"
                "Response window is 24 hours from vulnerability discovery.",
                "https://www.cleanstart.com/knowledge-hub/sla-support-tiers",
            ),
        ),
        (
            "Our Enterprise tier guarantees 99.9% uptime.",
            _chunk("The target uptime is 99.9% measured monthly.", "https://acme.com/service-level-agreement/"),
        ),
        (
            "Payment is due within 15 days of our invoice.",
            _chunk(
                "The User(s) shall, within fifteen (15) days from the date of the invoice, pay the invoiced amount.",
                "https://eventussecurity.com/terms-and-condition/",
            ),
        ),
        # An uploaded file speaks for the company.
        ("We respond within 4 hours.", _chunk("Provider responds to P1 tickets within 4 hours.", "msa.pdf")),
        # The top of a range carries the unit.
        ("Our P3 response is 1 to 2 business days.", _chunk("We answer P3 tickets in 1-2 business days.")),
        ("Within 7 days of signing we start onboarding.", _chunk("We begin onboarding within 7 days of signing.")),
    ],
)
def test_a_supported_commitment_is_kept(answer, chunk):
    result = _redact(answer, [chunk])

    assert result.redacted is False
    assert result.text == answer


def test_text_the_owner_wrote_supports_a_figure():
    answer = "We reply to every request within 2 business days."

    assert _redact(answer).redacted is True
    assert _redact(answer, owner_texts=(None, "Replies go out in 2 working days.")).redacted is False


@pytest.mark.parametrize(
    "answer",
    [
        "We provide 24x7 monitoring and a 24/7 SOC.",
        "We were founded in 2015 and serve over 500 customers.",
        "Our analysts watch your estate 24 hours a day, 7 days a week.",
        "Book a 30-minute call with us and we'll walk you through it.",
        "Most providers remediate critical findings within 48 hours.",
        "A US team usually patches within 48 hours.",
        "We cut false positives by 40% for one client.",
        "CleanStart says large organizations use a 32 week rollout.",
        "Our platform covers 8 languages and 11 frameworks.",
    ],
)
def test_ordinary_figures_are_not_commitments(answer):
    result = _redact(answer, [])

    assert result.redacted is False
    assert result.text == answer


@pytest.mark.parametrize(
    "chunk",
    [
        # A general article's first person is the author's, not the company's.
        _chunk("We remediate critical findings within 48 hours.", "https://acme.com/blog/soc-best-practices/"),
        # The company's name in the crawler tag or a link is not a subject.
        _chunk(
            "[Document: https://www.acme.com/topics/patching] [Page: 1] Remediate critical findings within 48 hours.",
            "https://www.acme.com/topics/patching",
        ),
        _chunk("See https://www.acme.com/x or acme.com: remediate critical findings within 48 hours."),
        # A first-person sentence elsewhere in the chunk does not reach the figure.
        _chunk("How can we measure ROI?\nRecovery time fell from 48 hours to 4 hours in 2025."),
        # The chunk has a figure, not this one.
        _chunk("We remediate critical findings within 24 hours."),
    ],
)
def test_a_chunk_that_does_not_state_the_figure_as_the_companys_does_not_support_it(chunk):
    assert _redact("We remediate critical findings within 48 hours.", [chunk]).redacted is True


def test_several_unsupported_sentences_leave_one_gap_sentence():
    answer = (
        "Here is how it works.\n\n"
        "- We acknowledge P1 alerts within 10 minutes.\n"
        "- We remediate critical findings within 48 hours.\n"
        "- We run 24x7 monitoring.\n\n"
        "Our SLA guarantees 99.95% availability. Want the team to follow up?"
    )

    result = _redact(answer)

    assert result.text == (
        "Here is how it works.\n\n"
        f"- {COMMITMENT_GAP_SENTENCE}\n"
        "- We run 24x7 monitoring.\n\n"
        "Want the team to follow up?"
    )
    assert result.figures == ("10 minutes", "48 hours", "99.95%")


def test_an_answer_without_a_commitment_is_returned_as_is():
    answer = "We run a 24x7 SOC.\n\n  Want details?  "

    result = _redact(answer, [])

    assert result.text is answer
    assert result.figures == ()


def test_figure_spellings_share_one_key():
    chunks = [
        _chunk("We patch in 48 hours."),
        _chunk("We patch in 48 hrs."),
        _chunk("We offer a 48-hour patch window."),
        _chunk("We patch in forty-eight hours."),
    ]

    keys = [supported_figures([chunk], company_name="Acme") for chunk in chunks]

    assert keys == [frozenset({(48.0, "hour")})] * 4


def test_a_snapshot_keeps_only_name_and_bounded_text():
    doc = SimpleNamespace(content="x" * 9000, document_name="https://acme.com/", id=7)

    (snap,) = snapshot_chunks([doc, *[]])

    assert snap.document_name == "https://acme.com/"
    assert len(snap.content) == 5000


_ADVERSARIAL = [
    "1-" * 5000,
    "we " + "1 to " * 2000 + "hours",
    "a-" * 5000 + ".com",
    "[" * 10000,
    "within " * 1400,
    "our " + "99.9 " * 2000 + "% uptime",
    ("x" * 60 + "@") * 150,
    "https://" + "a" * 9990,
    "#" * 10000,
]


@pytest.mark.parametrize("text", _ADVERSARIAL)
def test_long_adversarial_input_is_handled_quickly(text):
    chunks = [_chunk(text), _chunk(text, "https://acme.com/sla/"), _chunk(text, "notes.pdf")]
    started = time.perf_counter()
    _redact(text, chunks)
    supported_figures(chunks, company_name="Acme")
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, elapsed
