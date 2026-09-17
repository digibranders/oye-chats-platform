"""A reply names a country the company serves only when the reference says so.

Production, 2026-09-17 14:25 UTC, Eventus Security, after "tell me about managed
SOC and cybersecurity services": "d'accord, et c'est disponible en France ?" got
"Yes, France is listed among the countries we serve." The only France on the
company's own pages was a form's country dropdown; the other mentions were an
MSSP listicle ("Location: Paris metropolitan area, France") and incident write-ups
("incidents reported across South Korea, France, and the United States").
"""

import time
from types import SimpleNamespace

import pytest

from app.services.commitment_guard import (
    country_claim_gap_sentence,
    redact_unsupported_country_claims,
    supported_countries,
)

EVENTUS = "Eventus Security"
PRODUCTION_ANSWER = (
    "Yes, France is listed among the countries we serve. "
    "Our managed SOC runs 24x7. Would you like me to connect you with our team?"
)
PRODUCTION_GAP = "I don't have a statement about serving France here."
DROPDOWN = (
    "[Document: https://eventussecurity.com/cybersecurity/security-operations-market/] [Page: 2] "
    "Djibouti\nDominica\nDominican Republic\nEcuador\nEgypt\nFinland\nFrance\nFrench Guiana\nGabon"
)
WEBSHELL = (
    "Web shell attacks remain a serious cybersecurity threat in 2025, with major incidents reported across "
    "South Korea, France, and the United States. These attacks involve uploading malicious scripts.\n"
    "**Date Disclosed:** July 3, 2025\n**Location:** France\n**Targeted sectors**: government, telecom"
)
LISTICLE = (
    "### 7. Atos Eviden\n*   **Strength:** European leader for compliance-driven, enterprise environments.\n"
    "*   **Location:** Paris metropolitan area, France\n*   **Comprehensive Coverage:** Managed security, MDR/XDR"
)
CONTACT = (
    "[Document: https://eventussecurity.com/contact-us/] [Page: 1] 24x7 Security Operations.\n"
    "Global Headquarters\nEventus Security Pte Ltd 7030 Ang Mo Kio Avenue 5, #09-70 North Star @AMK Singapore 56988\n"
    "Saudi Arabia\n306 - Jameel Square, 2091 Prince Mohammed Bin Abdulaziz St, Al Andalus,Jeddah 23326,Saudi Arabia\n"
    "Dubai\nUnit 1101, Iris Bay, Business Bay, Dubai - UAE\n"
    "Qatar\n2003, Palm Tower-B, Majlis Al Taawon Street, West Bay, Al Dafna, Doha, Qatar. 60030014\n"
    "US\nEventus Security Inc\n30 Broad Street\n14th Floor #14108\nNew York City, NY 10004\n"
    "Mumbai\nIndia Head Office:\nKesar Solitaire | 604, 605, 606, 6th Floor Palm Beach Rd, Sanpada Navi Mumbai, India"
)


def _chunk(content, name="https://eventussecurity.com/cybersecurity/security-operations-market/"):
    return SimpleNamespace(content=content, document_name=name)


def _redact(answer, chunks=(), company=EVENTUS, **kwargs):
    return redact_unsupported_country_claims(answer, list(chunks), company_name=company, **kwargs)


PRODUCTION_KB = (
    _chunk(DROPDOWN),
    _chunk(WEBSHELL, "https://eventussecurity.com/cybersecurity/soc/webshell-attack/"),
    _chunk(LISTICLE, "https://eventussecurity.com/cybersecurity/india/mssp-companies/"),
    _chunk(CONTACT, "https://eventussecurity.com/contact-us/"),
)


def test_the_production_answer_loses_the_france_claim_and_keeps_the_rest():
    result = _redact(PRODUCTION_ANSWER, PRODUCTION_KB)

    assert result.redacted is True
    assert result.countries == ("France",)
    assert result.text == (
        f"{PRODUCTION_GAP} Our managed SOC runs 24x7. Would you like me to connect you with our team?"
    )


def test_the_gap_sentence_names_every_country():
    assert country_claim_gap_sentence(["France"]) == PRODUCTION_GAP
    assert country_claim_gap_sentence(["France", "Germany"]) == (
        "I don't have a statement about serving France or Germany here."
    )
    assert country_claim_gap_sentence(["France", "Germany", "Spain"]) == (
        "I don't have a statement about serving France, Germany or Spain here."
    )


@pytest.mark.parametrize(
    "answer",
    [
        "We have offices in India, the UAE, Saudi Arabia, Qatar and the US.",
        "Eventus Security has its India head office in Navi Mumbai.",
        "We have a presence in Saudi Arabia and Qatar.",
        "Our US entity, Eventus Security Inc, is in New York.",
        "We operate in the United Arab Emirates.",
        "Our global headquarters is in Singapore.",
    ],
)
def test_the_offices_on_the_contact_page_are_kept(answer):
    result = _redact(answer, PRODUCTION_KB)

    assert result.redacted is False, result.countries
    assert result.text == answer


def test_supported_countries_reads_the_contact_page_but_not_the_lists_or_articles():
    supported = supported_countries(PRODUCTION_KB, company_name=EVENTUS)

    assert {"india", "united arab emirates", "saudi arabia", "qatar", "united states", "singapore"} <= supported
    assert "france" not in supported
    assert "south korea" not in supported
    assert "finland" not in supported


@pytest.mark.parametrize(
    "answer",
    [
        "We serve clients in France.",
        "Our services are available in France and Germany.",
        "Eventus Security has customers in France.",
        "Yes, we cover France.",
        "We operate across France.",
        "Yes, we have an office in France.",
    ],
)
def test_an_unsupported_coverage_claim_is_replaced(answer):
    result = _redact(answer, PRODUCTION_KB)

    assert result.redacted is True
    assert "France" in result.countries
    assert result.text.startswith("I don't have a statement about serving France")


@pytest.mark.parametrize(
    "answer",
    [
        # No coverage claim.
        "Web shell attacks were reported in France last year.",
        "France has strict data protection rules, and our SOC helps with GDPR.",
        # Not the company speaking.
        "Atos is based in France.",
        # A denial is not a claim.
        "We don't have an office in France.",
        "We do not serve France at the moment.",
        # The visitor's own place.
        "Since you're based in France, our SOC can monitor your EU workloads remotely.",
        "If your team is in France, we can still help.",
        # No country at all.
        "We serve customers worldwide.",
    ],
)
def test_other_sentences_are_left_alone(answer):
    result = _redact(answer, PRODUCTION_KB)

    assert result.redacted is False
    assert result.text == answer


def test_a_company_sentence_on_its_own_page_supports_the_country():
    chunk = _chunk("Eventus Security serves enterprises in France through its Paris partner.", "https://acme.com/eu/")

    assert _redact("We serve clients in France.", [chunk]).redacted is False


def test_a_team_based_in_the_country_supports_it():
    chunk = _chunk(
        "The regional team, led by our director of solution engineering, is based in Dubai, United Arab Emirates.",
        "https://www.cleanstart.com/news/cleanstart-expands-middle-east-operations-as-demand-grows",
    )
    no_subject = _chunk(
        "Led by Director of Solution Engineering Tarun Gupta and based in Dubai, United Arab Emirates, the "
        "regional team will help organizations.",
        "https://www.cleanstart.com/news/cleanstart-expands-middle-east-operations-as-demand-grows",
    )

    assert _redact("We have a team in the UAE, so we serve it.", [chunk], company="CleanStart").redacted is False
    assert _redact("We have clients in the UAE.", [no_subject], company="CleanStart").redacted is False


def test_someone_elses_office_does_not_support_the_country():
    chunk = _chunk(
        "It prompted the brand to notify the France Information Commissioner's Office of the breach.",
        "https://eventussecurity.com/cybersecurity/cyber-risk/",
    )

    assert _redact("We serve clients in France.", [chunk]).redacted is True


def test_a_general_article_does_not_support_the_country():
    chunk = _chunk("We serve clients in France.", "https://eventussecurity.com/blog/top-10-mssp-in-europe/")

    assert _redact("We serve clients in France.", [chunk]).redacted is True


def test_a_country_list_on_the_company_page_does_not_support_the_country():
    chunk = _chunk("Our customers are in India, France, Germany and Japan.", "https://acme.com/about/")

    assert _redact("We have customers in France.", [chunk]).redacted is True


@pytest.mark.parametrize(
    "content,name",
    [
        # A window edge that cuts "use" is not the company speaking as "us".
        (
            "exploited zero-day flaws in the **Ivanti Cloud Services Appliance (CSA)** to infiltrate critical "
            "infrastructure in France. Affected sectors included government, telecommunications, media, and "
            "finance. Post-compromise analysis revealed the use of web shells.",
            "https://eventussecurity.com/cybersecurity/soc/webshell-attack/",
        ),
        # Someone else's customers, and a location line under someone else's heading.
        (
            "### 1. Louis Vuitton France Customer Data Breach\n**Date:** July 2, 2025\n**Location:** France\n"
            "**Details:** attackers accessed the names of French customers.",
            "https://eventussecurity.com/cybersecurity/cyber-risk/",
        ),
        # A list of other providers, on a page the URL does not tag as an article.
        (
            "### 8. Orange Cyberdefense\nOrange Cyberdefense is headquartered in Paris, France, serving 8,000 "
            "customers in France.",
            "https://eventussecurity.com/cybersecurity/usa/mssp-providers/",
        ),
    ],
)
def test_other_companies_and_incidents_do_not_support_the_country(content, name):
    assert _redact("We serve clients in France.", [_chunk(content, name)]).redacted is True


def test_text_the_owner_wrote_supports_the_country():
    result = _redact("We serve clients in France.", owner_texts=("We serve Europe from France and Spain.",))

    assert result.redacted is False


def test_an_uploaded_file_list_supports_the_countries_it_says_are_served():
    chunk = _chunk("Countries we serve: India, France, Germany, Japan.", "coverage.pdf")

    assert _redact("We serve clients in France.", [chunk]).redacted is False


def test_later_unsupported_sentences_are_dropped_and_named_in_the_first_gap():
    answer = "We serve France. We also have customers in Germany. Our SOC is in India."
    chunk = _chunk("Eventus Security runs its SOC in India.", "https://eventussecurity.com/about-us/")

    result = _redact(answer, [chunk])

    assert result.countries == ("France", "Germany")
    assert result.text == "I don't have a statement about serving France or Germany here. Our SOC is in India."


def test_an_alias_is_named_in_full():
    result = _redact("Yes, we have clients in the UK.", PRODUCTION_KB)

    assert result.countries == ("United Kingdom",)
    assert result.text == "I don't have a statement about serving United Kingdom here."


def test_a_list_item_that_is_only_the_claim_goes_with_its_marker():
    answer = "Here is what I have:\n- We serve France.\n- Our SOC runs 24x7."

    result = _redact(answer, PRODUCTION_KB)

    assert result.text == f"Here is what I have:\n- {PRODUCTION_GAP}\n- Our SOC runs 24x7."


def test_an_answer_without_a_country_is_returned_as_is():
    answer = "We run a 24x7 SOC."

    assert _redact(answer, PRODUCTION_KB).text is answer


def test_long_adversarial_input_stays_linear():
    hostile_answer = ("We serve France, " * 500) + "and " + "a" * 5_000
    hostile_chunk = _chunk(
        ("France " * 700) + ("[" * 20_000) + ("our office " * 500) + ("US " * 1_000),
        "https://acme.com/x/",
    )
    started = time.perf_counter()
    _redact(hostile_answer, [hostile_chunk] * 20)

    assert time.perf_counter() - started < 3.0


def test_an_event_page_does_not_support_the_country():
    chunk = _chunk(
        "We're leaving Paris, France with a long list of follow-up conversations.",
        "https://www.cleanstart.com/event/tech-fest-paris-2026",
    )

    assert _redact("We have customers in France.", [chunk], company="CleanStart").redacted is True


def test_a_long_paragraph_is_read_only_near_the_country():
    far = " filler" * 40
    chunk = _chunk(
        f"Policy updates from France and the EU shape the landscape.{far} Our offices help.", "https://a.com/p/"
    )

    assert _redact("We serve clients in France.", [chunk]).redacted is True
