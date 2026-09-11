"""Placeholder text that must never be read to a visitor as fact.

Production, 2026-09-11: CleanStart's knowledge base holds crawled draft pages
(/knowledge-hub/sla-documentation, defect-reporting-lifecycle,
secure-vendor-risk-assessment) that still carry "+1 (555) 123-4567",
"+1-XXX-XXX-XXXX" and "[Big 4 Firm Name]". The bot told a visitor "The
enterprise phone number is +1 (555) 123-4567 for Enterprise tier customers
only."

``placeholder_findings`` answers the report's question, "should the owner
delete this?", and deliberately calls a placeholder next to a markdown table
row or a bracketed field "documentation". ``first_visitor_placeholder``
answers retrieval's question, "may the model read this chunk?", where those
two shapes are what a draft template looks like. Both directions are pinned
here: fake phone numbers and filler are caught, and template fields,
citations, links, real numbers and code samples are left alone.
"""

import time

import pytest

from app.services.kb_quality import first_visitor_placeholder, placeholder_findings

# ── Caught: what a draft page states ─────────────────────────────────────────


@pytest.mark.parametrize(
    ("content", "kind", "value"),
    [
        (
            "Enterprise Support\nThe enterprise phone number is +1 (555) 123-4567 for Enterprise tier customers only.",
            "phone",
            "(555) 123-4567",
        ),
        (
            "| Severity | Response time | Escalation line |\n| --- | --- | --- |\n| P1 | 1 hour | +1-XXX-XXX-XXXX |",
            "phone",
            "XXX-XXX-XXXX",
        ),
        ("For after-hours incidents call 212-555-0143.", "phone", "212-555-0143"),
        ("Hotline: 555.123.4567", "phone", "555.123.4567"),
        ("Lorem ipsum dolor sit amet, consectetur adipiscing elit.", "filler", "Lorem ipsum"),
    ],
    ids=[
        "555-area-code",
        "masked-number-in-a-table-row",
        "555-01xx-fiction-range",
        "dotted-555",
        "lorem-ipsum",
    ],
)
def test_a_draft_placeholder_is_caught(content, kind, value):
    found = first_visitor_placeholder(content)

    assert found is not None
    assert found.kind == kind
    assert found.value == value


def test_a_placeholder_number_next_to_a_link_is_still_caught():
    """The report reads any bracketed text near a match as a template example.

    A markdown link is not documentation of anything: the number beside it is
    what a visitor would be given.
    """
    content = "Questions? [Contact us](https://clnstrt.dev/contact) or call (555) 123-4567."

    assert [f.in_example for f in placeholder_findings(content)] == [True]
    found = first_visitor_placeholder(content)
    assert found is not None and found.kind == "phone"


def test_a_placeholder_number_in_a_table_row_is_caught_though_the_report_calls_it_an_example():
    content = "| Tier | Contact |\n| Enterprise | (555) 123-4567 |"

    assert all(f.in_example for f in placeholder_findings(content))
    assert first_visitor_placeholder(content) is not None


# ── Left alone: real content that merely looks bracketed or numeric ──────────


@pytest.mark.parametrize(
    "content",
    [
        # Citations, file-type tags and link arrows.
        "Response times are contractual [1] and audited yearly [2]. Download the report [PDF] [↗].",
        "See the full SLA terms [12] and the appendix [A].",
        # Ordinary markdown links, reference links, images and definitions.
        "Read the [Security Overview](https://clnstrt.dev/security) before onboarding.",
        "Our [Company Name](https://acme.com/about) page explains the history.",
        "See [the pricing page][pricing] for plan limits.",
        "![Company Logo](https://acme.com/logo.png)",
        "[Company Name]: https://acme.com/about",
        # Real numbers in other formats, including a real 555 exchange.
        "Call +1 (415) 555-2671, +44 20 7946 0958 or +91 98765 43210.",
        "Directory assistance is 1-800-555-1212 and our office is 022 5551 2345.",
        # Code samples in developer docs.
        '```python\nclient.contacts.create(phone="555-123-4567", company="[Company Name]")\n```',
        "Set `SUPPORT_PHONE=555-123-4567` and `COMPANY=[Company Name]` in your environment.",
        '{"phone": "(555) 123-4567", "owner": "Jane"}',
        "acme notify --phone 555-123-4567 --channel ops",
        # Indexing and field references, not unfilled fields.
        "Read values with row[first_name] and data[company_name] in the template engine.",
        "Use the [First Name] merge tag to personalise each email.",
        "Map the [Account Name] field to your CRM before syncing.",
        # Documentation that introduces an example.
        "Pick a subject line, e.g. [Company Name] Weekly Update, and keep it short.",
        # Button labels and short bracketed words.
        "Press [Click Here] to continue, or [Download Now].",
        "Tick the box [x] and press [Enter].",
        # Plain prose and a real table.
        "| Plan | Price |\n| --- | --- |\n| Pro | $49 per month |",
        "We answer within one business day. Email support@cleanstart.com.",
    ],
    ids=[
        "numbered-citations",
        "citation-and-appendix",
        "markdown-link",
        "link-whose-text-looks-like-a-field",
        "reference-link",
        "image",
        "reference-definition",
        "real-numbers",
        "real-555-exchange-and-indian-landline",
        "fenced-code",
        "inline-code",
        "unfenced-json",
        "cli-flags",
        "indexing",
        "merge-tag-reference",
        "field-reference",
        "example-cue",
        "button-labels",
        "single-word-brackets",
        "real-table",
        "real-contact",
    ],
)
def test_real_content_is_left_alone(content):
    assert first_visitor_placeholder(content) is None


@pytest.mark.parametrize(
    "content",
    [
        # What email-marketing, legal-document and invoicing tenants sell.
        "Enter your [First Name] and [Last Name] to sign up.",
        "Welcome, [Your Name]!",
        "Sample invoice: [Invoice Number] dated [Invoice Date]",
        "[Company Name] has been trusted by teams since 2019.",
        "Vendor contact: [CISO Name], reachable at the address above.",
        "The review starts on [start_date] and closes two weeks later.",
        "Place [Your Logo Here] above the signature block.",
        "Replace Your Company Name Here with your brand before sending.",
        # Accepted trade-off: a draft's unfilled field looks the same as a template's.
        "Our SOC 2 Type II audit is performed every year by [Big 4 Firm Name], an independent assessor.",
    ],
    ids=[
        "sign-up-form-fields",
        "greeting-field",
        "sample-invoice-fields",
        "company-name",
        "ciso-name",
        "snake-case-field",
        "field-ending-in-here",
        "company-name-here-label",
        "big-4-firm-only",
    ],
)
def test_a_template_field_never_drops_the_chunk(content):
    """A template field is the product for some tenants; only fake numbers and filler drop a chunk."""
    assert first_visitor_placeholder(content) is None


def test_a_template_label_stays_in_the_owner_report():
    content = "Replace Your Company Name Here with your brand before sending."

    assert [(f.value, f.kind, f.in_example) for f in placeholder_findings(content)] == [
        ("your company name here", "filler", False),
        ("company name here", "filler", False),
    ]
    assert first_visitor_placeholder(content) is None


def test_empty_content_is_left_alone():
    assert first_visitor_placeholder("") is None
    assert first_visitor_placeholder(None) is None  # type: ignore[arg-type]


def test_the_report_classification_is_unchanged():
    """The retrieval rules must not leak into what the owner's report shows."""
    content = "Questions? [Contact us](https://clnstrt.dev/contact) or call (555) 123-4567."

    assert [(f.value, f.kind, f.in_example) for f in placeholder_findings(content)] == [
        ("(555) 123-4567", "phone", True)
    ]


# ── Linear on large chunks ───────────────────────────────────────────────────

_TIMING_CONTENT_CHARS = 100_000
_TIMING_BUDGET_SECONDS = 2.0


def _repeat(piece: str, n_chars: int) -> str:
    return (piece * (n_chars // len(piece) + 1))[:n_chars]


@pytest.mark.parametrize(
    "content",
    [
        # Every match sits in an example, so none ends the scan early.
        "```\n" + _repeat('phone = "(555) 123-4567"\n', _TIMING_CONTENT_CHARS - 8) + "\n```",
        _repeat("`(555) 123-4567` ", _TIMING_CONTENT_CHARS),
        _repeat("acme notify --phone 555-123-4567 ", _TIMING_CONTENT_CHARS),
        _repeat("`[Company Name]` ", _TIMING_CONTENT_CHARS),
        # Brackets that are never fields.
        _repeat("claim [1] and [PDF] [Read more](https://a.b/c) ", _TIMING_CONTENT_CHARS),
        _repeat("[" * 50 + "a" * 50, _TIMING_CONTENT_CHARS),
        # Nothing to find at all.
        _repeat("Ask us about our services in Springfield. ", _TIMING_CONTENT_CHARS),
    ],
    ids=[
        "fenced-assignments",
        "backticked-numbers",
        "cli-flags",
        "backticked-fields",
        "citations-and-links",
        "unclosed-brackets",
        "plain-prose",
    ],
)
def test_detection_stays_linear_on_a_large_chunk(content):
    assert len(content) >= _TIMING_CONTENT_CHARS - 8

    start = time.perf_counter()
    first_visitor_placeholder(content)
    elapsed = time.perf_counter() - start

    assert elapsed < _TIMING_BUDGET_SECONDS
