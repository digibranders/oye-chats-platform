"""Detectors for crawled content that must never be served as fact.

Production, 2026-09-10: Eventus claimed to operate in about 250 countries (a
crawled form's country dropdown) and CleanStart gave out "(555) 123-4567" (a
placeholder on its own site).

2026-09-11 review: two follow-on bugs found by re-running these detectors
over real production knowledge-base exports. First, "we ship to all 28
Indian states" (a real coverage claim, written as prose) tripped the same
boolean as an actual scraped <select> dropdown, so the report told a bot
owner their own correct content was junk. Second, 53 of CleanStart's 54
placeholder hits were addresses inside their own CLI/JSON/YAML/shell
documentation examples ("--email security@company.com"), correct
documentation that the original report told the owner to go delete.
"""

import itertools
import os
import sys

import pytest

from app.db.models import Bot, Client, Document
from app.services.kb_quality import (
    is_option_list,
    option_list_kind,
    option_list_match,
    placeholder_contacts,
    placeholder_findings,
)
from scripts.kb_junk_report import find_junk_chunks, main

COUNTRIES = "Australia Austria Azerbaijan Bahamas Bahrain Bangladesh Barbados Belarus Belgium Belize Benin Bermuda Bhutan Bolivia Botswana Brazil Bulgaria Cambodia Cameroon Canada Chile China Colombia Croatia Cuba Cyprus Denmark Egypt Estonia Finland France"

US_STATES = "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma"

INDIAN_STATES = "Andhra Pradesh Arunachal Pradesh Assam Bihar Chhattisgarh Goa Gujarat Haryana Himachal Pradesh Jharkhand Karnataka Kerala Madhya Pradesh Maharashtra Manipur Meghalaya Mizoram Nagaland Odisha Punjab Rajasthan Sikkim Tamil Nadu Telangana Tripura Uttar Pradesh Uttarakhand West Bengal"

# The exact shape of Eventus's real phone-input picker (production, 2026-09-10):
# bullet, name, dial code, newline, nothing else between entries.
EVENTUS_DIAL_CODE_PICKER = "\n".join(
    f"*    {name}+{code}"
    for name, code in [
        ("Afghanistan", "93"),
        ("Åland Islands", "358"),
        ("Albania", "355"),
        ("Algeria", "213"),
        ("American Samoa", "1"),
        ("Andorra", "376"),
        ("Angola", "244"),
        ("Anguilla", "1"),
        ("Antigua & Barbuda", "1"),
        ("Argentina", "54"),
        ("Armenia", "374"),
        ("Aruba", "297"),
        ("Ascension Island", "247"),
        ("Australia", "61"),
        ("Austria", "43"),
        ("Azerbaijan", "994"),
        ("Bahamas", "1"),
        ("Bahrain", "973"),
        ("Bangladesh", "880"),
        ("Barbados", "1"),
        ("Belarus", "375"),
        ("Belgium", "32"),
        ("Belize", "501"),
        ("Benin", "229"),
        ("Bermuda", "1"),
        ("Bhutan", "975"),
    ]
)

# The reviewer's P-to-S slice: real ISO country names, no connecting words.
P_TO_S_COUNTRIES = (
    "Pakistan Palau Palestine Panama Papua New Guinea Paraguay Peru Philippines Poland Portugal "
    "Qatar Romania Russia Rwanda Saint Kitts and Nevis Saint Lucia Samoa San Marino Saudi Arabia "
    "Senegal Serbia Seychelles Sierra Leone Singapore Slovakia Slovenia Solomon Islands Somalia "
    "South Africa South Korea South Sudan Spain Sri Lanka Sudan Suriname Sweden Switzerland Syria"
)

# The reviewer's two "real coverage list" examples: dense in place names, but
# written as prose/commas, not picker debris.
INDIAN_COVERAGE_PROSE = (
    "We deliver pan-India across Andhra Pradesh, Arunachal Pradesh, Assam, Bihar, Chhattisgarh, Goa, "
    "Gujarat, Haryana, Himachal Pradesh, Jharkhand, Karnataka, Kerala, Madhya Pradesh, Maharashtra, "
    "Manipur, Meghalaya, Mizoram, Nagaland, Odisha, Punjab, Rajasthan, Sikkim, Tamil Nadu, Telangana, "
    "Tripura, Uttar Pradesh, Uttarakhand and West Bengal."
)
COUNTRY_COVERAGE_PROSE = (
    "Our customers reach us from offices across Australia, Austria, Azerbaijan, Bahamas, Bahrain, "
    "Bangladesh, Barbados, Belarus, Belgium, Belize, Benin, Bermuda, Bhutan, Bolivia, Botswana, Brazil, "
    "Bulgaria, Cambodia, Cameroon, Canada, Chile, China, Colombia, Croatia, Cuba, Cyprus, Denmark and "
    "Vietnam."
)

# ── B1 approval-review fixtures: six real picker shapes the first pass missed ─
#
# Six real-world picker layouts, all built from the same 31-country list
# above so every one comfortably clears the 25-distinct-country threshold.

# "AF Afghanistan\nAL Albania\n...": a two-letter code before every name, a
# real newline between entries.
ISO_CODE_PICKER = "\n".join(f"{name[:2].upper()} {name}" for name in COUNTRIES.split())

# "🇺🇸 Afghanistan\n🇺🇸 Albania\n...": a flag emoji before every name. The
# flag doesn't need to match the country for this test -- only that flag
# *shaped* debris between two place names reads as a picker, not prose.
FLAG_PICKER = "\n".join(f"\U0001f1fa\U0001f1f8 {name}" for name in COUNTRIES.split())

# "Australia, Austria, ..., France, Other": a plain comma list ending in the
# picker's own "Other" option, no "and" anywhere.
COMMA_LIST_WITH_OTHER = ", ".join(COUNTRIES.split()) + ", Other"

# "○ Australia ○ Austria ○ ...": a radio-button bullet before every name.
RADIO_BUTTON_PICKER = " ".join(f"○ {name}" for name in COUNTRIES.split())

# "1. Australia\n2. Austria\n...": a numbered list.
NUMBERED_LIST_PICKER = "\n".join(f"{i}. {name}" for i, name in enumerate(COUNTRIES.split(), start=1))

# "Select State: Andhra Pradesh, Arunachal Pradesh, ...": a comma list under
# a "Select" header, no "and" anywhere. Spelled out by hand (rather than
# reformatted from the space-separated INDIAN_STATES fixture above) since
# several state names are themselves multi-word ("Andhra Pradesh") and
# would be split apart by a naive word-by-word join.
SELECT_STATE_COMMA_LIST = (
    "Select State: Andhra Pradesh, Arunachal Pradesh, Assam, Bihar, Chhattisgarh, Goa, Gujarat, "
    "Haryana, Himachal Pradesh, Jharkhand, Karnataka, Kerala, Madhya Pradesh, Maharashtra, Manipur, "
    "Meghalaya, Mizoram, Nagaland, Odisha, Punjab, Rajasthan, Sikkim, Tamil Nadu, Telangana, Tripura, "
    "Uttar Pradesh, Uttarakhand, West Bengal"
)

# ── B1: three more genuine coverage sentences (all comma-separated, all
# ending in "and <last place>."), to make sure the new comma-picker check
# doesn't start flagging real prose just because it's comma-separated.
US_COVERAGE_PROSE = (
    "Our support team covers customers across Alabama, Alaska, Arizona, Arkansas, California, "
    "Colorado, Connecticut, Delaware, Florida, Georgia, Hawaii, Idaho, Illinois, Indiana, Iowa, "
    "Kansas, Kentucky, Louisiana, Maine, Maryland, Massachusetts, Michigan, Minnesota, Mississippi, "
    "Missouri, Montana, Nebraska, Nevada and Ohio."
)
COUNTRY_COVERAGE_PROSE_2 = (
    "We proudly ship orders to Egypt, Estonia, Finland, France, Gabon, Gambia, Georgia, Germany, "
    "Ghana, Greece, Greenland, Grenada, Guatemala, Guyana, Haiti, Honduras, Hungary, Iceland, India, "
    "Indonesia, Iran, Iraq, Ireland, Israel, Italy, Jamaica, Japan, Jordan, Kazakhstan and Kenya."
)
INDIAN_COVERAGE_PROSE_2 = (
    "Field engineers are based across Andhra Pradesh, Arunachal Pradesh, Assam, Bihar, Chhattisgarh, "
    "Goa, Gujarat, Haryana, Himachal Pradesh, Jharkhand, Karnataka, Kerala, Madhya Pradesh, "
    "Maharashtra, Manipur, Meghalaya, Mizoram, Nagaland, Odisha, Punjab, Rajasthan, Sikkim and "
    "Tamil Nadu."
)


# ── option_list_kind: form pickers vs real coverage prose (finding 1) ───────


def test_a_country_dropdown_is_an_option_list():
    assert is_option_list(COUNTRIES) is True
    assert option_list_kind(COUNTRIES) == "form_options"


def test_prose_mentioning_a_few_countries_is_not():
    assert (
        is_option_list("We have offices in India, the United States and Germany, serving clients in Canada.") is False
    )
    assert (
        option_list_kind("We have offices in India, the United States and Germany, serving clients in Canada.") is None
    )


def test_a_us_state_dropdown_is_an_option_list():
    assert is_option_list(US_STATES) is True
    assert option_list_kind(US_STATES) == "form_options"


def test_an_indian_state_dropdown_is_an_option_list():
    assert is_option_list(INDIAN_STATES) is True
    assert option_list_kind(INDIAN_STATES) == "form_options"


def test_prose_naming_a_handful_of_states_is_not():
    assert is_option_list("We ship to California, Texas and New York, with a support desk in Maharashtra.") is False
    assert option_list_kind("We ship to California, Texas and New York, with a support desk in Maharashtra.") is None


def test_a_real_indian_coverage_claim_is_a_place_list_not_an_option_list():
    # "We deliver pan-India ... Andhra Pradesh, Arunachal Pradesh, Assam, ...
    # Uttarakhand and West Bengal." is real content a bot owner wrote, not a
    # scraped <select>. It must not be reported as a dropdown to delete.
    assert is_option_list(INDIAN_COVERAGE_PROSE) is False
    assert option_list_kind(INDIAN_COVERAGE_PROSE) == "place_list"


def test_a_real_country_coverage_claim_is_a_place_list_not_an_option_list():
    assert is_option_list(COUNTRY_COVERAGE_PROSE) is False
    assert option_list_kind(COUNTRY_COVERAGE_PROSE) == "place_list"


def test_the_real_eventus_dial_code_picker_is_still_an_option_list():
    # The exact production shape that started this whole review: a bullet,
    # a name, a dial code and a newline between entries, nothing else.
    assert is_option_list(EVENTUS_DIAL_CODE_PICKER) is True
    match = option_list_match(EVENTUS_DIAL_CODE_PICKER)
    assert match is not None
    assert match.kind == "form_options"
    assert match.category == "countries"


# ── B1: six more picker shapes the approval review found reading as prose ──


@pytest.mark.parametrize(
    "content",
    [
        ISO_CODE_PICKER,
        FLAG_PICKER,
        COMMA_LIST_WITH_OTHER,
        RADIO_BUTTON_PICKER,
        NUMBERED_LIST_PICKER,
        SELECT_STATE_COMMA_LIST,
    ],
    ids=["iso_codes", "flags", "comma_with_other", "radio_bullets", "numbered", "select_state_commas"],
)
def test_more_picker_shapes_are_form_options(content):
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "form_options"


@pytest.mark.parametrize(
    "content",
    [
        INDIAN_COVERAGE_PROSE,
        COUNTRY_COVERAGE_PROSE,
        US_COVERAGE_PROSE,
        COUNTRY_COVERAGE_PROSE_2,
        INDIAN_COVERAGE_PROSE_2,
    ],
    ids=["indian_reviewer", "country_reviewer", "us_new", "country_new", "indian_new"],
)
def test_comma_separated_coverage_prose_ending_in_and_stays_a_place_list(content):
    # All five: a real coverage sentence, comma-separated, whose last item
    # is joined with "and" -- never a picker, no matter how many places it
    # names or whether it also happens to carry a stray "Select"/"Other".
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "place_list"


# ── Country list coverage (finding 3) ────────────────────────────────────────


def test_previously_missing_common_countries_are_recognized():
    text = (
        "United States United Kingdom South Africa South Korea Saudi Arabia New Zealand "
        "United Arab Emirates Czech Republic Ivory Coast Russia Vietnam Germany France Italy "
        "Spain Portugal Poland Sweden Norway Finland Denmark Netherlands Belgium Austria "
        "Switzerland Greece Ireland Iceland Japan"
    )
    assert is_option_list(text) is True


def test_the_reviewers_p_to_s_slice_reaches_the_threshold():
    # 38 real ISO country names, P through S, with no connecting language:
    # exactly the kind of picker slice the old, sparser whitelist missed.
    match = option_list_match(P_TO_S_COUNTRIES)
    assert match is not None
    assert match.kind == "form_options"
    assert match.category == "countries"
    assert match.distinct_count >= 25


def test_accented_country_names_match_their_ascii_form():
    accented = "Åland Islands Côte d'Ivoire Curaçao Réunion São Tomé and Príncipe"
    ascii_form = "Aland Islands Cote d'Ivoire Curacao Reunion Sao Tome and Principe"
    # Each accented name is recognized as its own distinct country, both in
    # its accented form and its plain-ASCII form, when combined with 30
    # more ordinary countries (COUNTRIES) to clear the density threshold.
    assert is_option_list(f"{accented} {COUNTRIES}") is True
    assert is_option_list(f"{ascii_form} {COUNTRIES}") is True


def test_niger_inside_nigeria_is_not_double_counted():
    from app.services.kb_quality import _COUNTRY_PATTERN, _fold

    text = _fold("Nigeria and Niger are both in West Africa")
    matches = _COUNTRY_PATTERN.findall(text)
    # "Nigeria" is one country name; "niger" is not a separate match hiding
    # inside it. "Niger" the country IS a separate, correct match here since
    # it is genuinely also named in the sentence.
    assert sorted(matches) == sorted(["nigeria", "niger"])


def test_guinea_inside_papua_new_guinea_is_not_double_counted():
    from app.services.kb_quality import _COUNTRY_PATTERN, _fold

    text = _fold("Papua New Guinea and Equatorial Guinea and Guinea-Bissau and Guinea")
    matches = _COUNTRY_PATTERN.findall(text)
    # Four distinct countries, each matched to its full, correct name -- not
    # "papua new" plus a stray "guinea", and not "guinea-bissau" truncated
    # to "guinea".
    assert sorted(matches) == sorted(["papua new guinea", "equatorial guinea", "guinea-bissau", "guinea"])


def test_option_list_kind_stays_linear_on_a_large_chunk():
    import time

    content = ("Ask us about our services in Springfield. " * 2500)[:100_000]
    assert len(content) == 100_000

    start = time.perf_counter()
    option_list_kind(content)
    placeholder_findings(content)
    elapsed = time.perf_counter() - start
    assert elapsed < 0.2


# ── B3: placeholder-example detection stays linear, not quadratic ──────────
#
# Production, 2026-09-11: ``_in_fenced_or_backtick_region`` rescanned the
# entire chunk on every single match. 100,000 characters with about 4,800
# example addresses took 240-325ms; each scenario below is a different
# shape of "many matches in one chunk" and must independently finish well
# under that, combining ``placeholder_findings`` and ``option_list_kind``
# the same way the pre-existing linear test above does.

_TIMING_CONTENT_CHARS = 100_000
_TIMING_BUDGET_SECONDS = 0.2


def _dense_unique_addresses(n_chars: int) -> str:
    pieces: list[str] = []
    length = 0
    i = 0
    while length < n_chars:
        piece = f"contact{i}@example.com "
        pieces.append(piece)
        length += len(piece)
        i += 1
    return "".join(pieces)[:n_chars]


def _dense_repeated_addresses(n_chars: int) -> str:
    piece = "contact@example.com "
    reps = n_chars // len(piece) + 1
    return (piece * reps)[:n_chars]


def _backtick_scattered_unique_addresses(n_chars: int) -> str:
    pieces: list[str] = []
    length = 0
    i = 0
    while length < n_chars:
        piece = f"`contact{i}@example.com` "
        pieces.append(piece)
        length += len(piece)
        i += 1
    return "".join(pieces)[:n_chars]


def _dense_matches_inside_one_fenced_block(n_chars: int) -> str:
    prefix, suffix = "```\n", "\n```"
    inner_len = n_chars - len(prefix) - len(suffix)
    return prefix + _dense_unique_addresses(inner_len)[:inner_len] + suffix


@pytest.mark.parametrize(
    "content_factory",
    [
        _dense_unique_addresses,
        _dense_repeated_addresses,
        _backtick_scattered_unique_addresses,
        _dense_matches_inside_one_fenced_block,
    ],
    ids=["dense_unique", "dense_repeated", "backtick_scattered_unique", "dense_inside_one_fenced_block"],
)
def test_placeholder_example_detection_stays_linear_on_dense_matches(content_factory):
    import time

    content = content_factory(_TIMING_CONTENT_CHARS)
    assert len(content) == _TIMING_CONTENT_CHARS

    start = time.perf_counter()
    placeholder_findings(content)
    option_list_kind(content)
    elapsed = time.perf_counter() - start
    assert elapsed < _TIMING_BUDGET_SECONDS


# ── Placeholder findings: kind, dedup (finding 2 basics + finding 5) ────────


def test_placeholder_phone_numbers_and_emails_are_found():
    found = placeholder_contacts("Call +1 (555) 123-4567 or write to hello@example.com. Lorem ipsum dolor sit amet.")
    assert "(555) 123-4567" in found
    assert "hello@example.com" in found
    assert "lorem ipsum" in found


def test_real_contacts_are_not_flagged():
    assert placeholder_contacts("Call +91 789 789 6607 or support@oyechats.com") == []


def test_more_placeholder_patterns_are_found():
    text = (
        "Reach us at your@email.com or yourname@gmail.com or name@company.com. "
        "Sample data: xxx-xxx-xxxx, 000-000-0000, 123-456-7890, (123) 456-7890, "
        "call 1234567890 or visit 123 Main Street / 123 Main St."
    )
    found = placeholder_contacts(text)
    assert "your@email.com" in found
    assert "yourname@gmail.com" in found
    assert "name@company.com" in found
    assert "xxx-xxx-xxxx" in found
    assert "000-000-0000" in found
    assert "123-456-7890" in found
    assert "(123) 456-7890" in found
    assert "1234567890" in found
    assert "123 Main Street" in found
    assert "123 Main St" in found


def test_more_real_looking_contacts_are_not_flagged():
    # 022 5551 2345 contains the digits "555" but not as a standalone token,
    # so it must not be mistaken for the 555 fictional-number placeholder.
    # 1800 123 4567 is a real Indian toll-free format. 123 MG Road is a real
    # Bengaluru address, not the "123 Main Street" placeholder.
    found = placeholder_contacts("Call 022 5551 2345 or our toll-free 1800 123 4567. Visit us at 123 MG Road.")
    assert found == []


def test_reserved_555_01xx_numbers_are_flagged_even_with_a_real_area_code():
    # 555-0100 through 555-0199 are reserved by NANPA for fictional use in any
    # North American area code, so this is flagged even though it reads like
    # a genuine business line.
    found = placeholder_contacts("+1 415 555 0199 is our Palo Alto line")
    assert "415 555 0199" in found


def test_low_risk_placeholder_names_and_filler_are_found():
    findings = placeholder_findings(
        "QA Sign-off: Jane Smith. Security Review: John Doe. Backup contact: Jane Doe. "
        "Use Your Name Here as the reviewer. Template footer: Company Name Here. "
        "Also try Your Company Name Here."
    )
    by_value = {f.value.lower(): f.kind for f in findings}
    assert by_value["jane smith"] == "name"
    assert by_value["john doe"] == "name"
    assert by_value["jane doe"] == "name"
    assert by_value["your name here"] == "name"
    assert by_value["company name here"] == "filler"
    assert by_value["your company name here"] == "filler"


def test_bare_your_company_name_without_here_is_not_flagged():
    # Production counter-example (Eventus, 2026-09-10): "Monitoring for your
    # company name, domain, executive names, and key vendors can reveal
    # threat activity" is real security-advice prose, not an unfilled
    # template field. Only the unambiguous "...Here" forms are flagged.
    text = "Monitoring for your company name, domain, executive names, and key vendors can reveal threat activity."
    assert placeholder_contacts(text) == []


def test_placeholder_contacts_dedupes_case_insensitively_keeping_first_case():
    found = placeholder_contacts(
        "Email Security@Company.com, then security@company.com again, then SECURITY@COMPANY.COM."
    )
    assert found == ["Security@Company.com"]


# ── in_example: code and documentation examples are not leaks (finding 2) ──


def test_a_cli_flag_example_is_in_example():
    text = "Configure alerts:\n`intelligence monitor --packages sbom.spdx --email security@company.com`\nDone."
    findings = placeholder_findings(text)
    assert findings
    assert all(f.in_example for f in findings if f.value.lower() == "security@company.com")
    assert placeholder_contacts(text) == []


def test_a_json_example_is_in_example():
    text = '{\n  "pubkeys": [\n    "release-lead@company.com"\n  ]\n}'
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_a_yaml_example_is_in_example():
    text = 'labels:\n  maintainer: "platform-team@example.com"\n  version: "1.2.3"'
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_a_yaml_example_without_real_line_breaks_is_still_in_example():
    # CleanStart's own crawl collapses a <pre> block's newlines into plain
    # whitespace, so this shape (a bareword key, colon, quoted value) has to
    # be recognized without a line anchor to rely on.
    text = 'env_vars: APP_ENV: "production" labels: maintainer: "platform-team@example.com" version: "1.2.3"'
    findings = placeholder_findings(text)
    matches = [f for f in findings if f.value.lower() == "platform-team@example.com"]
    assert matches and all(f.in_example for f in matches)


def test_a_docker_compose_example_is_in_example():
    text = "environment:\n  - PGADMIN_DEFAULT_EMAIL=admin@example.com\n  - PGADMIN_DEFAULT_PASSWORD=secret"
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)


def test_a_shell_snippet_is_in_example():
    text = 'kubectl create secret docker-registry cleanstart-secret \\\n  --docker-email="$username@example.com"'
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)


def test_text_after_such_as_is_in_example():
    text = "A security alert is sent to designated recipients (such as security@company.com) automatically."
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)


def test_a_markdown_link_url_inherits_its_visible_texts_verdict():
    # "[value](mailto:value)" repeats the address as the href; the href
    # match is judged the same way as the paired visible-text match.
    text = "such as [security@company.com](mailto:security@company.com) for alerts."
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)


def test_a_documented_template_with_bracket_placeholders_is_in_example():
    # CleanStart's incident-response runbook: a fill-in-the-blank template
    # with square-bracket placeholders elsewhere in the same message.
    text = (
        "Review your audit logs for suspicious activity between [start_date] and [end_date]. "
        "Contact us if you need assistance: [incident-support@company.com](mailto:incident-support@company.com)."
    )
    findings = placeholder_findings(text)
    matches = [f for f in findings if "incident-support@company.com" in f.value]
    assert matches and all(f.in_example for f in matches)


def test_the_real_sla_phone_number_is_not_in_example():
    # The exact production leak that started this review: a real phone
    # number, written in plain prose, not inside any code or config sample.
    text = (
        "**Email**: General support: support@cleanstart.com. "
        "**Phone**: +1 (555) 123-4567 (Enterprise tier customers only). "
        "**Effective Date**: 2026-03-22."
    )
    findings = placeholder_findings(text)
    phone = [f for f in findings if "555" in f.value]
    assert phone
    assert all(not f.in_example for f in phone)
    assert "(555) 123-4567" in placeholder_contacts(text)


def test_a_real_prose_mention_of_a_placeholder_domain_is_not_in_example():
    # "File an issue or contact the platform team at platform-team@example.com."
    # is a genuine (if placeholder-domain) contact channel written in prose,
    # not a code sample -- still worth a human's attention.
    text = "File an issue or contact the platform team at platform-team@example.com for support."
    assert "platform-team@example.com" in placeholder_contacts(text)


# ── B2: unfenced code examples (approval review) ────────────────────────────


def test_an_unfenced_terraform_block_is_in_example():
    text = 'variable "support_contact" {\n  default = "support@example.com"\n}'
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_an_unfenced_ruby_constant_is_in_example():
    text = 'ADMIN_EMAIL = "admin@example.com"'
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_an_unfenced_sql_insert_is_in_example():
    text = "INSERT INTO users (name, email, phone) VALUES ('Jane Doe', 'jane.doe@example.com', '555-123-4567');"
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_a_footer_email_label_is_not_in_example():
    # A real contact footer, one field per line, no indentation -- must not
    # be mistaken for a YAML "key: value" config line.
    text = "Contact us\nEmail: yourname@company.com\nPhone: (555) 123-4567\nAddress: 123 Main Street"
    findings = placeholder_findings(text)
    assert findings
    assert all(not f.in_example for f in findings)
    contacts = placeholder_contacts(text)
    assert "yourname@company.com" in contacts
    assert "(555) 123-4567" in contacts
    assert "123 Main Street" in contacts


def test_a_prose_phone_number_with_no_code_context_is_not_in_example():
    text = "Call us at (555) 123-4567 for support any time."
    findings = placeholder_findings(text)
    assert findings and all(not f.in_example for f in findings)
    assert "(555) 123-4567" in placeholder_contacts(text)


def test_a_bracketed_zero_placeholder_is_found():
    found = placeholder_contacts("Fax: (000) 000-0000")
    assert "(000) 000-0000" in found


@pytest.mark.skipif(os.getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL")
def test_include_examples_flag_lists_the_example_section(monkeypatch, db, capsys):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _add_document(
        db,
        client=client,
        bot=bot,
        name="config-example.md",
        content="`--email security@company.com`\nCall us at (555) 123-4567 for support.",
    )

    monkeypatch.setattr(sys, "argv", ["kb_junk_report.py", "--bot-id", str(bot.id), "--include-examples"])
    exit_code = main()

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "(555) 123-4567" in out
    assert "security@company.com" not in out.split("usually correct)")[0]
    assert "usually correct" in out
    assert "security@company.com" in out.split("usually correct)")[1]


@pytest.mark.skipif(os.getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL")
def test_without_the_flag_example_placeholders_are_omitted(monkeypatch, db, capsys):
    client = _make_client(db)
    bot = _make_bot(db, client)
    _add_document(
        db,
        client=client,
        bot=bot,
        name="config-example.md",
        content="`--email security@company.com`",
    )

    monkeypatch.setattr(sys, "argv", ["kb_junk_report.py", "--bot-id", str(bot.id)])
    exit_code = main()

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "security@company.com" not in out
    assert "usually correct" not in out


# ── find_junk_chunks (the read-only report) ──────────────────────────────────
#
# Real Postgres, via the shared ``db`` fixture: the function runs a real
# SELECT against the real ``documents`` table and must never write to it.

_seq = itertools.count(1)
_EMBEDDING = [0.0] * 768


def _make_client(db) -> Client:
    n = next(_seq)
    client = Client(
        name=f"KB Quality Client {n}",
        email=f"kbq{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"kbq-api-key-{n}",
    )
    db.add(client)
    db.commit()
    return client


def _make_bot(db, client: Client) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-kbq-{n}", name="KB Quality Bot")
    db.add(bot)
    db.commit()
    return bot


def _add_document(db, *, client: Client, bot: Bot, name: str, content: str, is_active: bool = True) -> Document:
    doc = Document(
        client_id=client.id,
        bot_id=bot.id,
        document_name=name,
        source="crawl",
        file_hash=f"hash-{name}-{next(_seq)}",
        content=content,
        embedding=_EMBEDDING,
        is_active=is_active,
    )
    db.add(doc)
    db.commit()
    return doc


class TestFindJunkChunks:
    pytestmark = pytest.mark.skipif(
        os.getenv("DB_URL") is None,
        reason="find_junk_chunks integration tests need a reachable Postgres at DB_URL",
    )

    def test_flags_an_option_list_chunk_by_id_and_reason(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(db, client=client, bot=bot, name="https://eventus.example/signup", content=COUNTRIES)

        result = find_junk_chunks(db, bot.id)

        assert len(result.findings) == 1
        assert result.findings[0].document_name == "https://eventus.example/signup"
        assert any("country dial-code picker" in reason for reason in result.findings[0].reasons)
        assert result.scanned_count == 1

    def test_flags_a_place_list_chunk_separately_and_lower_priority(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(db, client=client, bot=bot, name="coverage.html", content=INDIAN_COVERAGE_PROSE)

        result = find_junk_chunks(db, bot.id)

        assert len(result.findings) == 1
        finding = result.findings[0]
        assert finding.reasons == ()
        assert finding.place_list_reasons != ()

    def test_flags_a_placeholder_contact_chunk(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="contact.html",
            content="Call us at (555) 123-4567 any time.",
        )

        result = find_junk_chunks(db, bot.id)

        assert len(result.findings) == 1
        assert any("(555) 123-4567" in reason for reason in result.findings[0].reasons)

    def test_a_documentation_example_placeholder_is_not_a_main_finding(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="cli-docs.md",
            content="Run `intelligence monitor --email security@company.com` to subscribe.",
        )

        result = find_junk_chunks(db, bot.id)

        assert len(result.findings) == 1
        finding = result.findings[0]
        assert finding.reasons == ()
        assert any("security@company.com" in reason for reason in finding.example_reasons)

    def test_clean_content_is_not_flagged(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="about.html",
            content="We are a small team in Bangalore helping local shops with their books.",
        )

        result = find_junk_chunks(db, bot.id)
        assert result.findings == []
        assert result.scanned_count == 1

    def test_inactive_chunks_are_not_scanned(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(
            db,
            client=client,
            bot=bot,
            name="stale.html",
            content="Call us at (555) 123-4567 any time.",
            is_active=False,
        )

        result = find_junk_chunks(db, bot.id)
        assert result.findings == []
        assert result.scanned_count == 0

    def test_only_scans_the_given_bot(self, db):
        client = _make_client(db)
        bot = _make_bot(db, client)
        other_bot = _make_bot(db, client)
        _add_document(db, client=client, bot=other_bot, name="other.html", content=COUNTRIES)

        result = find_junk_chunks(db, bot.id)
        assert result.findings == []
        assert result.scanned_count == 0

    def test_never_prints_chunk_content(self, db, capsys):
        client = _make_client(db)
        bot = _make_bot(db, client)
        secret = "my personal phone is nine one one, do not repeat this"
        _add_document(
            db,
            client=client,
            bot=bot,
            name="private.html",
            content=f"Call us at (555) 123-4567. {secret}",
        )

        find_junk_chunks(db, bot.id)

        assert secret not in capsys.readouterr().out


# ── main(): missing bot, scanned-count summary (finding 4) ─────────────────


class TestMainMissingBot:
    pytestmark = pytest.mark.skipif(
        os.getenv("DB_URL") is None,
        reason="main() integration tests need a reachable Postgres at DB_URL",
    )

    def test_a_missing_bot_id_is_reported_and_exits_nonzero(self, monkeypatch, db, capsys):
        monkeypatch.setattr(sys, "argv", ["kb_junk_report.py", "--bot-id", "999999999"])

        exit_code = main()

        out = capsys.readouterr().out
        assert exit_code == 1
        assert "Bot 999999999 not found." in out
        # A typo'd bot id must not print the same line a real, clean bot does.
        assert "suspicious" not in out

    def test_a_real_bot_reports_the_scanned_chunk_count(self, monkeypatch, db, capsys):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _add_document(db, client=client, bot=bot, name="a.html", content="Ordinary page content, nothing odd here.")
        _add_document(db, client=client, bot=bot, name="b.html", content="More ordinary content about our product.")

        monkeypatch.setattr(sys, "argv", ["kb_junk_report.py", "--bot-id", str(bot.id)])
        exit_code = main()

        out = capsys.readouterr().out
        assert exit_code == 0
        assert f"0 suspicious of 2 active chunks for bot {bot.id}" in out
