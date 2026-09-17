"""Crawled page furniture that the answer model read as company facts.

Two production answers on 2026-09-17:

* Eventus Security, "d'accord, et c'est disponible en France ?" was answered
  "We serve France." The only France on its own pages is the phone country-code
  picker of the contact form, crawled as about 250 lines like ``*    France+33``.
* CleanStart, "want to apply for a devops role, whats the hr mail id" got the
  leave-message form. The careers address is on every page, but only as a link
  whose visible text is cut short: ``[careers@](mailto:careers@cleanstart.com)``.

Both are fixed where the reference context is built, so no re-crawl is needed:
a run of country-code lines is dropped and a mailto or tel link shows the full
address.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from app.ingestion.cleaner import expand_contact_links, strip_phone_code_runs, tidy_reference_text
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import _doc, _drive_stream, _make_bot, _make_client, _make_session, _stub_pipeline

_EVENTUS_PICKER = (
    "[Document: https://eventussecurity.com/contact-us/] [Page: 1] No cookies to display.\n"
    "Email:[hello@eventussecurity.com](mailto:hello@eventussecurity.com)\n"
    "Phone/Mobile\n"
    "United States +1\n"
    "244 results found\n"
    "*    Finland+358\n"
    "*    France+33\n"
    "*    French Guiana+594\n"
    "*    Côte d’Ivoire+225\n"
    "*    Turks & Caicos Islands+1\n"
    "*    U.S. Virgin Islands+1\n"
    "Company\n"
    "Country"
)


class TestPhoneCodeRuns:
    def test_the_production_picker_is_dropped_and_the_page_kept(self):
        cleaned = strip_phone_code_runs(_EVENTUS_PICKER)

        assert "France" not in cleaned
        assert "+33" not in cleaned
        assert cleaned.split("\n") == [
            "[Document: https://eventussecurity.com/contact-us/] [Page: 1] No cookies to display.",
            "Email:[hello@eventussecurity.com](mailto:hello@eventussecurity.com)",
            "Phone/Mobile",
            # The picker's selected value is a single line, as a real address line
            # would be, so it stays.
            "United States +1",
            "244 results found",
            "Company",
            "Country",
        ]

    def test_a_chunk_that_opens_inside_the_picker_keeps_its_document_header(self):
        text = (
            "[Document: https://eventussecurity.com/talk-to-sales/] [Page: 1] *    Sweden+46\n"
            "*    Switzerland+41\n"
            "*    Syria+963\n"
            "Title\n"
            "Company"
        )

        assert strip_phone_code_runs(text) == (
            "[Document: https://eventussecurity.com/talk-to-sales/] [Page: 1]\nTitle\nCompany"
        )

    def test_a_dash_bullet_and_a_spaced_code_are_one_run(self):
        text = "Intro\n- Germany +49\n- India +91\n- Japan +81\nOutro"

        assert strip_phone_code_runs(text) == "Intro\nOutro"

    @pytest.mark.parametrize(
        "text",
        [
            # A real office block: one country code line is an address, not a picker.
            "Head office\n221 Baker Street\nLondon NW1 6XE\nUnited Kingdom +44\nhello@acme.com",
            # A full phone number is a number to call, even in a list of three.
            "Offices\n* India +91 22 1234 5678\n* France +33 1 23 45 67 89\n* Germany +49 30 1234567",
            # Two lines are not a picker.
            "Call us\nIndia +91\nUnited States +1\nWe answer within a day.",
            "Phone: +91 22 1234 5678\nFax: +91 22 1234 5679\nToll free: +1 800 555 0100",
            "We serve France, Germany and Spain.",
        ],
    )
    def test_real_address_and_phone_lines_are_kept(self, text):
        assert strip_phone_code_runs(text) == text

    def test_a_run_broken_by_a_real_line_is_judged_per_side(self):
        text = "France+33\nGermany+49\nOur Paris office\nSpain+34\nItaly+39\nMalta+356"

        assert strip_phone_code_runs(text) == "France+33\nGermany+49\nOur Paris office"

    def test_long_adversarial_lines_stay_linear(self):
        hostile = "\n".join(
            [
                "[Document: x] [Page: 1]" + " " * 50_000 + "a" * 50_000,
                "*" + " " * 50_000 + "France" + " " * 50_000,
                "a " * 50_000 + "+",
                "[Document: " + "]" * 50_000,
                "France+33",
            ]
        )
        started = time.perf_counter()
        strip_phone_code_runs(hostile)

        assert time.perf_counter() - started < 1.0

    def test_text_without_a_plus_is_returned_as_is(self):
        text = "No codes here\nat all"

        assert strip_phone_code_runs(text) is text


class TestContactLinks:
    def test_the_truncated_production_label_shows_the_whole_address(self):
        text = "The team rebuilding the base layer.  [careers@](mailto:careers@cleanstart.com) [About Us](https://x)"

        assert expand_contact_links(text) == (
            "The team rebuilding the base layer.  careers@cleanstart.com [About Us](https://x)"
        )

    @pytest.mark.parametrize(
        "link,expected",
        [
            ("[support@cleanstart.com](mailto:support@cleanstart.com)", "support@cleanstart.com"),
            ("[SUPPORT@CleanStart.com](mailto:support@cleanstart.com)", "support@cleanstart.com"),
            ("[Email us](mailto:hello@acme.com)", "Email us (hello@acme.com)"),
            ("[**Write to HR**](mailto:hr@acme.com?subject=Job)", "Write to HR (hr@acme.com)"),
            ("[](mailto:hello@acme.com)", "hello@acme.com"),
            ("[careers](MAILTO:careers%40acme.com)", "careers@acme.com"),
            ("[Call us](tel:+919876543210)", "Call us (+919876543210)"),
            ("[+91 98765 43210](tel:+919876543210)", "+91 98765 43210"),
            ("[98765](tel:+919876543210)", "+919876543210"),
        ],
    )
    def test_the_address_is_always_visible(self, link, expected):
        assert expand_contact_links(f"Contact: {link}.") == f"Contact: {expected}."

    @pytest.mark.parametrize(
        "text",
        [
            # Seen on Eventus: a web URL wrongly put in a mailto link.
            "[**2026 Community Choice Winner**](mailto:https://eventussecurity.com/press-releases/x/)",
            # Seen on Eventus: not an address at all.
            "[sales@Eventus Security.com](mailto:sales@Eventus Security.com)",
            "[Home](https://acme.com/)",
            "[Call](tel:ext)",
            "plain careers@acme.com text",
        ],
    )
    def test_anything_else_is_left_alone(self, text):
        assert expand_contact_links(text) == text

    def test_long_adversarial_input_stays_linear(self):
        hostile = (
            "[" * 50_000
            + "](mailto:"
            + "a" * 50_000
            + "["
            + "x" * 50_000
            + "](mailto:"
            + "(" * 50_000
            + "[a](tel:"
            + "1" * 50_000
        )
        started = time.perf_counter()
        expand_contact_links(hostile)

        assert time.perf_counter() - started < 1.0


class TestTheReferenceContextIsTidied:
    def test_both_cleaners_run_on_every_chunk(self):
        docs = [
            SimpleNamespace(content=_EVENTUS_PICKER, document_name="https://eventussecurity.com/contact-us/"),
            SimpleNamespace(
                content="Join us. [careers@](mailto:careers@cleanstart.com)",
                document_name="https://www.cleanstart.com/contact-us",
            ),
        ]

        context = rs._build_reference_context(docs, "Eventus Security")

        assert "France" not in context
        assert "hello@eventussecurity.com" in context
        assert "Join us. careers@cleanstart.com" in context
        assert "mailto:" not in context

    def test_the_picker_does_not_use_up_the_truncation_budget(self):
        picker = "\n".join(f"*    Country{chr(65 + i % 26)}+{i}" for i in range(400))
        doc = SimpleNamespace(content=f"{picker}\nEmail: hello@acme.com", document_name="contact")

        context = rs._build_reference_context([doc], None)

        assert "hello@acme.com" in context
        assert "[truncated]" not in context

    def test_tidy_is_both_cleaners(self):
        text = "Mail [hr@](mailto:hr@acme.com)\nA+1\nB+2\nC+3"

        assert tidy_reference_text(text) == "Mail hr@acme.com"


class TestTheModelSeesTheAddressAndNoPicker:
    """The real pipeline, stubbed only at the outside world: what the answer model
    is given for the two production turns."""

    @pytest.mark.asyncio
    async def test_the_hr_question_gets_the_careers_address_and_no_country_list(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-hygiene-1")
        contact = _doc(
            "[Document: https://www.cleanstart.com/contact-us] [Page: 1] *   Company Company The team "
            "rebuilding the base layer of open source.  [careers@](mailto:careers@cleanstart.com) "
            "[About Us](https://www.cleanstart.com/about-us)",
            name="https://www.cleanstart.com/contact-us",
        )
        picker = _doc(_EVENTUS_PICKER, name="https://eventussecurity.com/contact-us/")
        cap = _stub_pipeline(monkeypatch, retrieved=(contact, picker), chunks=("careers@cleanstart.com",))

        await _drive_stream(bot, "want to apply for a devops role, whats the hr mail id", "sess-hygiene-1")

        assert len(cap["prompts"]) == 1
        system, user = cap["prompts"][0]
        prompt = f"{system}\n{user}"
        assert "open source.  careers@cleanstart.com [About Us]" in prompt
        assert "mailto:" not in prompt
        assert "France" not in prompt
        assert "Finland+358" not in prompt
        assert "hello@eventussecurity.com" in prompt
