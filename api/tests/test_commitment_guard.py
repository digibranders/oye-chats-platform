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


def test_the_listicle_figure_goes_and_the_clause_after_it_stays():
    answer = "We have a documented P1 acknowledge target of ≤ 10 min, but I can't share the contract. Anything else?"

    result = _redact(answer, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS)

    assert result.text == f"I can't share the contract. {COMMITMENT_GAP_SENTENCE} Anything else?"
    assert result.figures == ("10 min",)


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

    assert keys == [frozenset({(2880.0, "minute")})] * 4


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
    _redact(text, chunks, question=text)
    supported_figures(chunks, company_name="Acme")
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, elapsed


# ── A company page states its own figures without a subject ──────────────────
#
# Review of 2026-09-17: the company's own pages state most service figures with
# no "we" ("Critical vulnerabilities are patched within 24 hours"), so requiring
# a first-person subject redacted true answers. On a crawled page that is not a
# general article a figure now counts unless its sentence or bullet reads as
# advice or an example.

CLEANSTART = "CleanStart"
ROADMAP_PAGE = "https://www.cleanstart.com/knowledge-hub/technology-roadmap"
ROADMAP_CHUNK = (
    f"[Document: {ROADMAP_PAGE}] [Page: 3] SBOMs are generated in both SPDX 3.0 and CycloneDX 1.4 formats. "
    "CVE tracking and remediation follows strict SLAs where Critical vulnerabilities are patched within 24 hours "
    "and High-severity issues within 7 days. The APK package manager enables flexible composition."
)
WHY_PAGE = "https://www.cleanstart.com/knowledge-hub/why-cleanstart"
WHY_CHUNK = (
    "The rebuilt image is subjected to the full test matrix (78 automated tests) to ensure the patch doesn't "
    "introduce regressions. Only after all tests pass is the image released for deployment. This entire cycle "
    'completes within 12-24 hours, enabling what might be called "continuous compliance".'
)
RELEASE_PAGE = "https://www.cleanstart.com/knowledge-hub/release-notes"
RELEASE_CHUNK = (
    "### Release Schedule\n"
    "**Major releases** - Quarterly (Jan, Apr, Jul, Oct) **Minor releases** - Monthly (mid-month) "
    "**Patch releases** - As needed (within 48h of discovery).\n"
    "### Support Timeline\n"
)
RANSOMWARE_PAGE = "https://eventussecurity.com/ransomware-combat/"
RANSOMWARE_CHUNK = (
    f"[Document: {RANSOMWARE_PAGE}] [Page: 1] ## Why Eventus\n"
    "10 min to respond to case;\n"
    "Response from IR expert within 10 min around the clock\n"
)


@pytest.mark.parametrize(
    ("answer", "chunk", "company"),
    [
        ("CleanStart patches critical CVEs within 24 hours.", _chunk(ROADMAP_CHUNK, ROADMAP_PAGE), CLEANSTART),
        (
            "Our full rebuild and test cycle completes within 12 to 24 hours.",
            _chunk(WHY_CHUNK, WHY_PAGE),
            CLEANSTART,
        ),
        ("We ship patch releases within 48 hours of discovery.", _chunk(RELEASE_CHUNK, RELEASE_PAGE), CLEANSTART),
        ("Our IR experts respond within 10 minutes.", _chunk(RANSOMWARE_CHUNK, RANSOMWARE_PAGE), EVENTUS),
        (
            "We typically onboard new clients in 2 weeks.",
            _chunk("How it works\n* Onboarding in 2 weeks\n* Dedicated manager", "https://acme.com/how-it-works"),
            "Acme",
        ),
        (
            "Our P1 response time is 4 hours.",
            _chunk("Support\nResponse time: 4 hours for P1 tickets.", "https://acme.com/support"),
            "Acme",
        ),
        (
            "Our refund policy allows cancellation within 30 days.",
            _chunk(
                "Refund Policy\nCancellation is allowed within 30 days of purchase.", "https://acme.com/refund-policy"
            ),
            "Acme",
        ),
        (
            "Refunds are processed within 30 days by our team.",
            _chunk("Refund requests must be made within 30 days.", "https://acme.com/refund-policy"),
            "Acme",
        ),
        # A label before the colon is not an imperative.
        (
            "We ship patch releases within 48 hours.",
            _chunk("**Patch releases**: As needed (within 48h of discovery).", RELEASE_PAGE),
            CLEANSTART,
        ),
    ],
)
def test_a_figure_the_companys_own_page_states_without_a_subject_is_supported(answer, chunk, company):
    result = _redact(answer, [chunk], company=company)

    assert result.redacted is False, result.figures
    assert result.text == answer


@pytest.mark.parametrize(
    "sentence",
    [
        "Remediate critical-severity findings within 48 hours",
        "*   Address critical findings within 48 hours",
        "**Ensure** critical findings are closed within 48 hours.",
        "1. Patch critical findings within 48 hours.",
        "Alert Triage SLAs: Remediate critical-severity findings within 48 hours",
        "Critical findings should be closed within 48 hours.",
        "Critical findings must be closed within 48 hours.",
        "Look for a provider that closes critical findings within 48 hours.",
        "Ask your provider to close critical findings within 48 hours.",
        "Best practice is to close critical findings within 48 hours.",
        "The recommended window for critical findings is 48 hours.",
        "Critical findings are typically closed within 48 hours.",
        "Aim for closing critical findings within 48 hours.",
        "Demand a 48-hour window for critical findings.",
        "Set targets, for example critical findings within 48 hours.",
        "Set targets, e.g. critical findings within 48 hours.",
        "Recovery time fell from 48 hours to 4 hours in 2025.",
    ],
)
def test_advice_or_an_example_on_a_company_page_does_not_support_a_figure(sentence):
    chunk = _chunk(f"Intro line.\n{sentence}\nOutro line.", "https://acme.com/services/vulnerability-management/")

    assert _redact("We remediate critical findings within 48 hours.", [chunk]).redacted is True


def test_the_production_best_practice_list_stays_redacted_with_the_rest_of_its_page():
    page = [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE), _chunk(RANSOMWARE_CHUNK, RANSOMWARE_PAGE)]

    result = _redact(PRODUCTION_ANSWER, page, company=EVENTUS)

    assert result.text == f"{COMMITMENT_GAP_SENTENCE} Want me to take a message for our team?"
    assert _redact("We address medium-severity findings within 7 days.", page, company=EVENTUS).redacted is True


def test_the_buyer_guide_example_on_a_tagged_listicle_stays_redacted():
    guide = _chunk(
        "What to look for\n* A documented P1 acknowledge target (e.g. P1 acknowledge ≤ 10 min)\n",
        "https://eventussecurity.com/top-10-mdr-providers-2026/",
    )
    untagged = _chunk("SLA examples: e.g. P1 acknowledge ≤ 10 min.", "https://eventussecurity.com/soc/")

    for chunk in (guide, untagged):
        result = _redact("We acknowledge P1 alerts within 10 minutes.", [chunk], company=EVENTUS)
        assert result.redacted is True, chunk.document_name


# ── Commitments, not every duration or percentage ─────────────────────────────


@pytest.mark.parametrize(
    "answer",
    [
        "If you need it in 2 weeks, our team can discuss that with you.",
        "We can plan around your timeline of 3 weeks.",
        "If you want it done by your deadline in 10 days, our team can help.",
        "Our webinar is in 3 days.",
        "Our detection gives 85% fewer false positives and is available in 12 regions.",
        "We cut alert volume by 40%, and our SLA covers every region.",
        "If you need it within 2 weeks, we can deliver.",
    ],
)
def test_a_visitor_timeline_an_event_or_a_plain_percentage_is_not_a_commitment(answer):
    result = _redact(answer, [])

    assert result.redacted is False, result.figures
    assert result.text == answer


@pytest.mark.parametrize(
    "answer",
    [
        "We respond to your tickets within 4 hours.",
        "Your onboarding is done by our team in 2 weeks.",
        "We deliver the report within 5 days.",
        "Setup takes under 5 minutes with our installer.",
        "We have a 99.9% uptime guarantee.",
    ],
)
def test_a_commitment_near_a_visitor_word_is_still_one(answer):
    assert _redact(answer, []).redacted is True


def test_only_the_unsupported_clause_of_a_joined_sentence_is_replaced():
    answer = "Our Starter plan is $49 per month, and setup takes under 5 minutes. Want a demo?"

    result = _redact(answer, [])

    assert result.text == f"Our Starter plan is $49 per month. {COMMITMENT_GAP_SENTENCE} Want a demo?"
    assert result.figures == ("5 minutes",)


def test_an_unsupported_first_clause_leaves_the_rest_capitalised():
    answer = "Setup takes under 5 minutes; our Starter plan is $49 per month."

    result = _redact(answer, [])

    assert result.text == f"Our Starter plan is $49 per month. {COMMITMENT_GAP_SENTENCE}"


def test_a_supported_clause_stays_beside_an_unsupported_one():
    answer = "We respond within 4 hours, and we resolve within 2 days."

    result = _redact(answer, [_chunk("We respond to every ticket within 4 hours.")])

    assert result.text == f"We respond within 4 hours. {COMMITMENT_GAP_SENTENCE}"
    assert result.figures == ("2 days",)


@pytest.mark.parametrize(
    ("answer", "reference"),
    [
        ("We onboard within 14 days.", "We onboard clients within 2 weeks."),
        ("We respond within 2 hours.", "We respond within 120 minutes."),
        ("We patch within 2 days.", "We patch critical CVEs within 48 hours."),
        ("We patch within 48 hours.", "We patch critical CVEs within 2 days."),
    ],
)
def test_units_are_compared_after_conversion(answer, reference):
    assert _redact(answer, [_chunk(reference)]).redacted is False


# ── Sentences ─────────────────────────────────────────────────────────────────


def test_an_abbreviation_does_not_end_a_sentence():
    answer = "We handle incidents quickly, e.g. we respond in 15 min. Anything else?"

    result = _redact(answer, [])

    assert result.text == f"{COMMITMENT_GAP_SENTENCE} Anything else?"


@pytest.mark.parametrize(
    "answer",
    [
        "We cover SIEM, i.e. we respond in 15 min. Anything else?",
        "We cover SIEM, SOAR etc. and we respond in 15 min. Anything else?",
        "We respond in approx. 15 min. Anything else?",
        "Our Dr. Rao responds in 15 min. Anything else?",
        "Under clause No. 4 we respond in 15 min. Anything else?",
    ],
)
def test_other_abbreviations_keep_their_sentence_whole(answer):
    assert _redact(answer, []).text == f"{COMMITMENT_GAP_SENTENCE} Anything else?"


def test_a_sentence_ending_in_etc_or_no_still_ends():
    answer = "We cover SIEM, SOAR, etc. We respond in 15 min. No. We do not resell."

    assert _redact(answer, []).text == f"We cover SIEM, SOAR, etc. {COMMITMENT_GAP_SENTENCE} No. We do not resell."


def test_a_danda_ends_a_sentence():
    answer = "हम 24 घंटे में जवाब देते हैं। Our team responds within 24 hours."

    result = _redact(answer, [])

    assert result.text == f"हम 24 घंटे में जवाब देते हैं। {COMMITMENT_GAP_SENTENCE}"


_ADVERSARIAL_SENTENCES = [
    "e.g. " * 4000,
    "you need " * 2000 + "2 weeks respond",
    "our " + ", and " * 3000 + "respond in 4 hours",
    "Remediate: " * 1500 + "48 hours",
    "from 1 " * 2500 + "to 2 hours",
    "your timeline of " * 1000 + "3 weeks",
    "। " * 8000,
]


@pytest.mark.parametrize("text", _ADVERSARIAL_SENTENCES)
def test_long_adversarial_sentences_are_handled_quickly(text):
    chunks = [_chunk(text), _chunk(text, "https://acme.com/how-it-works/")]
    started = time.perf_counter()
    _redact(text, chunks)
    supported_figures(chunks, company_name="Acme")
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, elapsed


# ── A figure with no subject, when the visitor asked about our terms ─────────
#
# Production, 2026-09-18: "whats ur SLA for patching critical CVEs? like in how
# many hours" got "Critical findings are remediated within 48 hours. I don't
# have our exact figure for that." Only the sentence with a subject was
# checked, so the best-practices figure stayed beside the gap sentence denying
# it. The 48 hours are the "Alert Triage SLAs" bullets of a generic
# vulnerability-management page, not an Eventus Security term.

PATCH_QUESTION = "whats ur SLA for patching critical CVEs? like in how many hours"
PASSIVE_ANSWER = (
    "Critical-severity findings are remediated within 48 hours. For medium-severity findings, the SLA is 7 days."
)
OWN_PATCH_CHUNK = _chunk(
    "Critical-severity findings are remediated within 48 hours. Medium-severity findings carry a 7 day SLA.",
    "https://eventussecurity.com/soc-as-a-service/",
)
MTTD_GUIDE = _chunk(
    "What to ask a provider\n* SLA examples, e.g. P1 acknowledge \u2264 10 min, MTTD \u2264 10 min for exploitation, "
    "MTTR \u2264 60 min for P1 and \u2264 4 hrs for P2\n",
    "https://eventussecurity.com/best-soc-as-a-service-providers-2025/",
)


def test_the_production_passive_answer_loses_both_figures():
    result = _redact(PASSIVE_ANSWER, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS, question=PATCH_QUESTION)

    assert result.text == COMMITMENT_GAP_SENTENCE
    assert result.figures == ("48 hours", "7 days")
    assert "48" not in result.text


def test_the_production_passive_answer_stays_when_the_company_page_states_it():
    result = _redact(PASSIVE_ANSWER, [OWN_PATCH_CHUNK], company=EVENTUS, question=PATCH_QUESTION)

    assert result.redacted is False
    assert result.text == PASSIVE_ANSWER


@pytest.mark.parametrize(
    "answer",
    [
        "Critical findings are remediated within 48 hours.",
        "Response time: 48 hours.",
        "Patching happens within 48 hours.",
        "The SLA for critical findings is 48 hours.",
        "Critical CVEs get a 48-hour remediation target.",
    ],
)
@pytest.mark.parametrize(
    "question",
    [
        PATCH_QUESTION,
        "if we raise a P1 at 2am whats the guaranteed response time in the contract",
        "do you publish an SLA?",
        "whats ur turnaround time",
    ],
)
def test_a_subjectless_figure_is_checked_when_the_visitor_asked_about_our_terms(answer, question):
    result = _redact(
        f"{answer} Anything else?", [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS, question=question
    )

    assert result.text == f"{COMMITMENT_GAP_SENTENCE} Anything else?"


def test_a_subjectless_figure_stays_when_the_visitor_asked_about_nobody_in_particular():
    answer = "Critical findings are remediated within 48 hours."

    for question in (None, "", "how does vulnerability management work"):
        result = _redact(answer, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS, question=question)
        assert result.redacted is False, question


@pytest.mark.parametrize(
    "answer",
    [
        "Providers typically remediate critical findings within 48 hours.",
        "Most providers patch critical findings within 48 hours.",
        "Critical findings are usually remediated within 48 hours.",
        "The industry benchmark for critical remediation is 48 hours.",
        "For example, a critical remediation target of 48 hours is common.",
        "Best practice is to remediate critical findings within 48 hours.",
        "Buyer guides list e.g. a 48-hour remediation target.",
    ],
)
def test_general_wording_is_not_presented_as_ours(answer):
    result = _redact(answer, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS, question=PATCH_QUESTION)

    assert result.redacted is False, result.figures
    assert result.text == answer


# ── One coherent answer: never the figure and the gap sentence together ──────


def test_a_replaced_sentence_takes_the_same_figure_out_of_the_rest_of_the_reply():
    answer = (
        "Critical findings are remediated within 48 hours. "
        "We remediate critical findings within 48 hours. Anything else?"
    )

    result = _redact(answer, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS)

    assert result.text == f"{COMMITMENT_GAP_SENTENCE} Anything else?"
    assert result.figures == ("48 hours",)


def test_general_wording_keeps_its_figure_while_our_own_sentence_goes():
    answer = (
        "We remediate critical findings within 48 hours. Providers typically close them within 48 hours. Anything else?"
    )

    result = _redact(answer, [_chunk(EVENTUS_CHUNK, EVENTUS_PAGE)], company=EVENTUS)

    assert result.text == (f"{COMMITMENT_GAP_SENTENCE} Providers typically close them within 48 hours. Anything else?")


def test_a_reply_that_already_says_it_lacks_the_figure_gets_no_second_gap_sentence():
    """Evaluation, 2026-09-18, Eventus Security: "whats ur MTTD and MTTR sla"."""
    answer = (
        "I don't have our exact MTTD and MTTR SLA. The closest published figures we have are example bands for "
        "CISOs: MTTD of \u2264 10 min for exploitation, and MTTR of \u2264 60 min for P1.\n\n"
        "Want me to take a message for our team?"
    )

    result = _redact(answer, [MTTD_GUIDE], company=EVENTUS, question="whats ur MTTD and MTTR sla")

    assert result.text == ("I don't have our exact MTTD and MTTR SLA.\n\nWant me to take a message for our team?")
    assert result.text.count("I don't have") == 1
    assert result.figures == ("10 min", "60 min")


def test_the_p1_reply_keeps_its_one_honest_clause():
    """Evaluation, 2026-09-18: the borrowed "P1 acknowledge target" came from a buyer guide."""
    answer = (
        "I don't have our exact contractual P1 response time here. The closest stated terms are a P1 acknowledge "
        "target of \u2264 10 min, plus 24x7 coverage and SLA-based response expectations.\n\n"
        "Want me to take a message for our team?"
    )

    result = _redact(
        answer,
        [MTTD_GUIDE],
        company=EVENTUS,
        question="if we raise a P1 at 2am whats the guaranteed response time in the contract",
    )

    assert result.text == (
        "I don't have our exact contractual P1 response time here.\n\nWant me to take a message for our team?"
    )
