"""Detectors for crawled content that must never be served as fact.

Production, 2026-09-10: Northlane claimed to operate in about 250 countries (a
crawled form's country dropdown) and Brightloop gave out "(555) 123-4567" (a
placeholder on its own site).

2026-09-11 review: two follow-on bugs found by re-running these detectors
over real production knowledge-base exports. First, "we ship to all 28
Indian states" (a real coverage claim, written as prose) tripped the same
boolean as an actual scraped <select> dropdown, so the report told a bot
owner their own correct content was junk. Second, 53 of Brightloop's 54
placeholder hits were addresses inside their own CLI/JSON/YAML/shell
documentation examples ("--email security@company.com"), correct
documentation that the original report told the owner to go delete.

2026-09-11 controller decision: four rounds of layout rules for the gaps
between names never converged, so "form_options" now requires an actual
picker marker (a dial code, a "Select" prompt, ``<option>`` markup, a flag
emoji or an ISO code) tied to the run, and every other dense place-name
run -- whatever its separators -- goes to "place_list" instead. A bare,
markerless list of names (previously "form_options" on density alone) now
reads as "place_list" too, since density says nothing about whether a
list is scraped or real.

2026-09-11 review, round two: the "Select" prompt and ``<option>``/
``value="`` markers were still checked anywhere in the whole chunk, so a
real office or coverage list on a page that also carried an unrelated
"Select a location below to see opening hours" widget, a "results found
for your search" message, a "Country*" field on a contact form, or a
stray ``value="..."`` attribute somewhere else on the page was reported as
a picker (11 of 15 realistic reviewer chunks). Both markers now have to
sit within a bounded window of the run's own span, the same as the
dial-code/flag/ISO-code markers, and a "Select"/"Choose" prompt also has
to be about a place ("country", "state", "region", "location",
"nationality" or "residence") to count -- "Select an issue type" and
"Choose a report year" name something else entirely and never count, even
sitting right next to a run.
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
    option_list_reason,
    placeholder_contacts,
    placeholder_findings,
)
from scripts.kb_junk_report import find_junk_chunks, main

COUNTRIES = "Australia Austria Azerbaijan Bahamas Bahrain Bangladesh Barbados Belarus Belgium Belize Benin Bermuda Bhutan Bolivia Botswana Brazil Bulgaria Cambodia Cameroon Canada Chile China Colombia Croatia Cuba Cyprus Denmark Egypt Estonia Finland France"

US_STATES = "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma"

INDIAN_STATES = "Andhra Pradesh Arunachal Pradesh Assam Bihar Chhattisgarh Goa Gujarat Haryana Himachal Pradesh Jharkhand Karnataka Kerala Madhya Pradesh Maharashtra Manipur Meghalaya Mizoram Nagaland Odisha Punjab Rajasthan Sikkim Tamil Nadu Telangana Tripura Uttar Pradesh Uttarakhand West Bengal"

# The exact shape of Northlane's real phone-input picker (production, 2026-09-10):
# bullet, name, dial code, newline, nothing else between entries.
NORTHLANE_DIAL_CODE_PICKER = "\n".join(
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

# ── Controller-decision fixtures: markers earn "form_options", not density
# or separator shape ──────────────────────────────────────────────────────

# "Australia (+1); Austria (+1); ...": a bracketed dial code after every
# name, semicolon-separated -- the separator variety the old gap rules kept
# chasing; the marker (the dial code) is what actually decides this one.
BRACKETED_DIAL_CODE_PICKER = "; ".join(f"{name} (+1)" for name in COUNTRIES.split())

# "Select country: Australia; Austria; ...": a "Select" prompt with a
# semicolon-separated list.
SELECT_COUNTRY_SEMICOLON_LIST = "Select country: " + "; ".join(COUNTRIES.split())

# "Select country: Australia/Austria/...": a "Select" prompt with a
# slash-separated list.
SELECT_COUNTRY_SLASH_LIST = "Select country: " + "/".join(COUNTRIES.split())

# "Select country:\n(1) Australia\n(2) Austria\n...": a "Select" prompt with
# "(1)"-style numbering.
SELECT_COUNTRY_NUMBERED_LIST = "Select country:\n" + "\n".join(
    f"({i}) {name}" for i, name in enumerate(COUNTRIES.split(), start=1)
)

# "<option value=\"Australia\">Australia</option>...": leftover <select>
# markup a crawl failed to strip out.
OPTION_MARKUP_PICKER = "\n".join(f'<option value="{name}">{name}</option>' for name in COUNTRIES.split())

# "Customer support is available in the following countries:" plus a plain
# numbered list, no "Select" prompt anywhere -- real content the old
# numbering-shaped gap rule misread as a picker.
CUSTOMER_SUPPORT_NUMBERED_LIST = "Customer support is available in the following countries:\n" + "\n".join(
    f"{i}. {name}" for i, name in enumerate(COUNTRIES.split(), start=1)
)

# "**Delivery coverage**: Andhra Pradesh, ... and all union territories.":
# real content, a bold markdown lead-in, comma-separated, no picker marker.
DELIVERY_COVERAGE_PROSE = (
    "**Delivery coverage**: Andhra Pradesh, Arunachal Pradesh, Assam, Bihar, Chhattisgarh, Goa, Gujarat, "
    "Haryana, Himachal Pradesh, Jharkhand, Karnataka, Kerala, Madhya Pradesh, Maharashtra, Manipur, "
    "Meghalaya, Mizoram, Nagaland, Odisha, Punjab, Rajasthan, Sikkim, Tamil Nadu, Telangana, Tripura, "
    "Uttar Pradesh, Uttarakhand, and all union territories."
)

# "The qualifying matches pitted Australia vs Austria vs ... in the group
# stage.": a sports sentence. "vs" must never be mistaken for a list code.
COUNTRY_VS_SPORTS_SENTENCE = "The qualifying matches pitted " + " vs ".join(COUNTRIES.split()) + " in the group stage."

# A bare newline-separated list of 30 country names, no marker at all.
BARE_NEWLINE_COUNTRY_LIST = "\n".join(COUNTRIES.split())

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

# ── Round-two reviewer fixtures: a marker elsewhere on the page must not
# taint a real, unrelated place-name run (finding 1, round two) ────────────
#
# Unrelated filler with no place words and none of the marker regexes'
# trigger words in it, long enough on its own to push whatever comes after
# it well past ``_INSTRUCTION_MARKER_WINDOW`` (150 characters) from the
# nearest edge of the place-name run that follows.
_FAR_PADDING = (
    "This paragraph exists only to add distance from the marker above, and "
    "deliberately names no places and asks the reader to pick nothing at "
    "all, so it cannot itself be mistaken for picker evidence. "
)
assert len(_FAR_PADDING) > 150

# 1. Office list plus a "Select a location" widget three paragraphs above
# it, not attached to the office list at all.
OFFICE_LIST_WITH_DISTANT_LOCATION_PROMPT = (
    "Select a location below to see opening hours. "
    + _FAR_PADDING
    + "Our offices are located across "
    + COUNTRIES
    + "."
)

# 2. Travel blog plus an unrelated "results found" search message.
TRAVEL_BLOG_WITH_DISTANT_RESULTS_MESSAGE = (
    "0 results found for your search. "
    + _FAR_PADDING
    + "Popular destinations our readers write about include "
    + COUNTRIES
    + "."
)

# 3. CMS page plus an unrelated value="subscribe" checkbox.
CMS_PAGE_WITH_DISTANT_SUBSCRIBE_FIELD = (
    '<input type="checkbox" value="subscribe"> Subscribe to updates. '
    + _FAR_PADDING
    + "This page lists our coverage across "
    + COUNTRIES
    + "."
)

# 4. Careers page plus a "Choose your nearest centre" prompt placed away
# from the office list.
CAREERS_PAGE_WITH_DISTANT_CENTRE_PROMPT = (
    "Choose your nearest centre to apply. "
    + _FAR_PADDING
    + "We hire engineers across our offices in "
    + COUNTRIES
    + "."
)

# 5. Legal disclaimer plus a "Please select your country of residence"
# prompt in another paragraph.
LEGAL_DISCLAIMER_WITH_DISTANT_RESIDENCE_PROMPT = (
    "Please select your country of residence before continuing. "
    + _FAR_PADDING
    + "This disclaimer applies to customers in "
    + COUNTRIES
    + "."
)

# 6. Investor-relations page plus a "Country*" field on a contact form
# elsewhere on the page.
IR_PAGE_WITH_DISTANT_COUNTRY_FIELD = (
    "Country* (required field on the investor contact form) "
    + _FAR_PADDING
    + "Our shareholders are based across "
    + COUNTRIES
    + "."
)

# 7. Press page plus a "-- Select --" nav leftover.
PRESS_PAGE_WITH_DISTANT_SELECT_LEFTOVER = (
    "-- Select -- " + _FAR_PADDING + "Press coverage of our launch spanned " + COUNTRIES + "."
)

# 8. Sustainability report plus a "Choose a report year" archive picker.
SUSTAINABILITY_REPORT_WITH_DISTANT_YEAR_PICKER = (
    "Choose a report year to view archived filings. "
    + _FAR_PADDING
    + "Our sustainability initiatives operate in "
    + COUNTRIES
    + "."
)

# 9. Wholesale terms plus an unrelated value="in-stock" option.
WHOLESALE_TERMS_WITH_DISTANT_STOCK_FIELD = (
    '<select><option value="in-stock">In stock</option></select> '
    + _FAR_PADDING
    + "These wholesale terms apply to distributors in "
    + COUNTRIES
    + "."
)

# 10. Support article plus a "Select an issue type" ticket-category picker.
SUPPORT_ARTICLE_WITH_DISTANT_ISSUE_TYPE_PICKER = (
    "Select an issue type to get started. " + _FAR_PADDING + "Our support centers are staffed across " + COUNTRIES + "."
)

# Two more: the *same* two non-place prompts as #8 and #10, but sitting
# right next to the run with no padding at all. These must still be
# "place_list" -- the object check, not just the window, has to reject
# them ("issue type" and "report year" are not places).
SELECT_ISSUE_TYPE_NEXT_TO_RUN = "Select an issue type: " + COUNTRIES
CHOOSE_REPORT_YEAR_NEXT_TO_RUN = "Choose a report year: " + COUNTRIES

# The mirror image of #5: the same "Please select your country of
# residence" prompt, but right next to the run (the shape of the three
# genuine Northlane picker_instruction hits, marker 15-42 characters from
# the run) -- this one must stay "form_options".
SELECT_COUNTRY_OF_RESIDENCE_NEXT_TO_RUN = "Please select your country of residence: " + COUNTRIES


# ── option_list_kind: form pickers vs real coverage prose (finding 1) ───────


def test_a_bare_country_list_with_no_marker_is_a_place_list_not_form_options():
    # Controller decision: density alone no longer earns "form_options". A
    # dense, markerless list of names (previously reported as a dropdown
    # on density alone) now goes to the lower-priority "place_list"
    # section, since a bare list of names by itself could just as well be
    # real content.
    assert is_option_list(COUNTRIES) is False
    assert option_list_kind(COUNTRIES) == "place_list"


def test_prose_mentioning_a_few_countries_is_not():
    assert (
        is_option_list("We have offices in India, the United States and Germany, serving clients in Canada.") is False
    )
    assert (
        option_list_kind("We have offices in India, the United States and Germany, serving clients in Canada.") is None
    )


def test_a_bare_us_state_list_with_no_marker_is_a_place_list_not_form_options():
    assert is_option_list(US_STATES) is False
    assert option_list_kind(US_STATES) == "place_list"


def test_a_bare_indian_state_list_with_no_marker_is_a_place_list_not_form_options():
    assert is_option_list(INDIAN_STATES) is False
    assert option_list_kind(INDIAN_STATES) == "place_list"


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


def test_the_real_northlane_dial_code_picker_is_still_an_option_list():
    # The exact production shape that started this whole review: a bullet,
    # a name, a dial code and a newline between entries, nothing else.
    assert is_option_list(NORTHLANE_DIAL_CODE_PICKER) is True
    match = option_list_match(NORTHLANE_DIAL_CODE_PICKER)
    assert match is not None
    assert match.kind == "form_options"
    assert match.category == "countries"


# ── B1: six more picker shapes the approval review found reading as prose ──


@pytest.mark.parametrize(
    "content",
    [
        ISO_CODE_PICKER,
        FLAG_PICKER,
        SELECT_STATE_COMMA_LIST,
        BRACKETED_DIAL_CODE_PICKER,
        SELECT_COUNTRY_SEMICOLON_LIST,
        SELECT_COUNTRY_SLASH_LIST,
        SELECT_COUNTRY_NUMBERED_LIST,
        OPTION_MARKUP_PICKER,
    ],
    ids=[
        "iso_codes",
        "flags",
        "select_state_commas",
        "bracketed_dial_codes",
        "select_country_semicolons",
        "select_country_slashes",
        "select_country_numbered",
        "option_markup",
    ],
)
def test_picker_shapes_with_a_marker_are_form_options(content):
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "form_options"


@pytest.mark.parametrize(
    "content",
    [
        COMMA_LIST_WITH_OTHER,
        RADIO_BUTTON_PICKER,
        NUMBERED_LIST_PICKER,
        CUSTOMER_SUPPORT_NUMBERED_LIST,
        DELIVERY_COVERAGE_PROSE,
        COUNTRY_VS_SPORTS_SENTENCE,
        BARE_NEWLINE_COUNTRY_LIST,
    ],
    ids=[
        "comma_with_other_no_select",
        "radio_bullets_no_marker",
        "numbered_no_marker",
        "customer_support_numbered_list",
        "delivery_coverage_prose",
        "vs_sports_sentence",
        "bare_newline_list",
    ],
)
def test_dense_lists_without_a_marker_are_place_list_not_form_options(content):
    # Controller decision: a separator (commas, bullets, numbering) is
    # never enough on its own, and neither is a bare "Other" list item --
    # only a dial code, a Select prompt, option markup, flags or ISO codes
    # tied to the run earn "form_options". Everything else this dense goes
    # to the lower-priority "place_list" section instead.
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "place_list"
    assert match.marker is None


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
    # names. None of these five carry a stray "Select" or "Other" marker;
    # see the tests below for coverage prose that does.
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "place_list"


@pytest.mark.parametrize(
    "content",
    [
        OFFICE_LIST_WITH_DISTANT_LOCATION_PROMPT,
        TRAVEL_BLOG_WITH_DISTANT_RESULTS_MESSAGE,
        CMS_PAGE_WITH_DISTANT_SUBSCRIBE_FIELD,
        CAREERS_PAGE_WITH_DISTANT_CENTRE_PROMPT,
        LEGAL_DISCLAIMER_WITH_DISTANT_RESIDENCE_PROMPT,
        IR_PAGE_WITH_DISTANT_COUNTRY_FIELD,
        PRESS_PAGE_WITH_DISTANT_SELECT_LEFTOVER,
        SUSTAINABILITY_REPORT_WITH_DISTANT_YEAR_PICKER,
        WHOLESALE_TERMS_WITH_DISTANT_STOCK_FIELD,
        SUPPORT_ARTICLE_WITH_DISTANT_ISSUE_TYPE_PICKER,
    ],
    ids=[
        "office_list_distant_location_prompt",
        "travel_blog_distant_results_message",
        "cms_page_distant_subscribe_field",
        "careers_page_distant_centre_prompt",
        "legal_disclaimer_distant_residence_prompt",
        "ir_page_distant_country_field",
        "press_page_distant_select_leftover",
        "sustainability_report_distant_year_picker",
        "wholesale_terms_distant_stock_field",
        "support_article_distant_issue_type_picker",
    ],
)
def test_coverage_with_a_distant_form_marker_stays_a_place_list(content):
    # Round-two reviewer finding: a real, unrelated place-name run must not
    # be reclassified as a picker just because the same page also carries a
    # "Select"/"Choose" prompt, a search-results message, a "Country*"
    # field, or leftover option markup -- as long as that marker sits more
    # than _INSTRUCTION_MARKER_WINDOW characters from the run itself. Ten
    # realistic shapes, each a different page type and a different marker.
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "place_list"
    assert match.marker is None


@pytest.mark.parametrize(
    "content",
    [SELECT_ISSUE_TYPE_NEXT_TO_RUN, CHOOSE_REPORT_YEAR_NEXT_TO_RUN],
    ids=["select_issue_type", "choose_report_year"],
)
def test_a_select_prompt_about_something_other_than_a_place_stays_a_place_list_even_next_to_the_run(content):
    # "Select an issue type" and "Choose a report year" sit immediately
    # next to the run -- well inside the window -- but their object is not
    # a place, so they must not count as picker evidence either.
    match = option_list_match(content)
    assert match is not None
    assert match.kind == "place_list"
    assert match.marker is None


def test_a_select_prompt_about_a_place_next_to_the_run_is_still_form_options():
    # The mirror image of the distant-residence-prompt case above: the same
    # "Please select your country of residence" prompt, but right next to
    # the run, the shape of the three genuine Northlane picker_instruction
    # hits (marker 15 to 42 characters from the run) -- this must still be
    # reported as a picker.
    match = option_list_match(SELECT_COUNTRY_OF_RESIDENCE_NEXT_TO_RUN)
    assert match is not None
    assert match.kind == "form_options"
    assert match.marker == "picker_instruction"


def test_form_options_reason_names_the_marker():
    # Controller decision: the report must say *why* something looks like
    # a picker, not just that it does.
    cases = [
        (NORTHLANE_DIAL_CODE_PICKER, "dial_codes", "dial codes"),
        (SELECT_STATE_COMMA_LIST, "picker_instruction", "a Select prompt"),
        (OPTION_MARKUP_PICKER, "option_markup", "option markup"),
        (FLAG_PICKER, "flags", "flag icons"),
        (ISO_CODE_PICKER, "iso_codes", "country codes"),
    ]
    for content, expected_marker, expected_text in cases:
        match = option_list_match(content)
        assert match is not None
        assert match.kind == "form_options"
        assert match.marker == expected_marker
        reason = option_list_reason(match)
        assert expected_text in reason
        assert reason.endswith("usually safe to remove")


def test_place_list_reason_is_generic_and_never_names_a_marker():
    match = option_list_match(INDIAN_COVERAGE_PROSE)
    assert match is not None
    assert match.marker is None
    assert option_list_reason(match) == (
        "many place names listed: check whether this is a real coverage or office list before removing anything"
    )


# ── Country list coverage (finding 3) ────────────────────────────────────────


def test_previously_missing_common_countries_are_recognized():
    # A bare list, so it now reads as "place_list" (see the controller
    # decision above) rather than "form_options" -- what this test actually
    # pins is that every one of these country names is recognized at all,
    # which is what widened the whitelist that this test is named for.
    text = (
        "United States United Kingdom South Africa South Korea Saudi Arabia New Zealand "
        "United Arab Emirates Czech Republic Ivory Coast Russia Vietnam Germany France Italy "
        "Spain Portugal Poland Sweden Norway Finland Denmark Netherlands Belgium Austria "
        "Switzerland Greece Ireland Iceland Japan"
    )
    match = option_list_match(text)
    assert match is not None
    assert match.category == "countries"
    assert match.kind == "place_list"


def test_the_reviewers_p_to_s_slice_reaches_the_threshold():
    # 38 real ISO country names, P through S, with no connecting language:
    # exactly the kind of slice the old, sparser whitelist missed. Bare
    # (no marker), so it is a "place_list" under the controller decision,
    # not "form_options" -- this test is about country-name recognition
    # breadth, not classification.
    match = option_list_match(P_TO_S_COUNTRIES)
    assert match is not None
    assert match.kind == "place_list"
    assert match.category == "countries"
    assert match.distinct_count >= 25


def test_accented_country_names_match_their_ascii_form():
    accented = "Åland Islands Côte d'Ivoire Curaçao Réunion São Tomé and Príncipe"
    ascii_form = "Aland Islands Cote d'Ivoire Curacao Reunion Sao Tome and Principe"
    # Each accented name is recognized as its own distinct country, both in
    # its accented form and its plain-ASCII form, when combined with 30
    # more ordinary countries (COUNTRIES) to clear the density threshold.
    # No marker here, so this stays a "place_list", not "form_options";
    # what this test pins is recognition, not classification.
    accented_match = option_list_match(f"{accented} {COUNTRIES}")
    ascii_match = option_list_match(f"{ascii_form} {COUNTRIES}")
    assert accented_match is not None
    assert ascii_match is not None
    assert accented_match.category == ascii_match.category == "countries"


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
    # Production counter-example (Northlane, 2026-09-10): "Monitoring for your
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
    # Brightloop's own crawl collapses a <pre> block's newlines into plain
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
    text = 'kubectl create secret docker-registry brightloop-secret \\\n  --docker-email="$username@example.com"'
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
    # Brightloop's incident-response runbook: a fill-in-the-blank template
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
        "**Email**: General support: support@brightloop.com. "
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


def test_an_nginx_directive_block_is_in_example():
    # Controller decision item 4: an nginx/Apache-style directive block
    # ("key value;" lines between "{" and "}") is documentation, not a
    # leaked real address.
    text = "server {\n    listen 80;\n    server_name example.com;\n    email_contact admin@example.com;\n}"
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_a_multi_line_http_header_block_is_in_example():
    # Controller decision item 4: two or more consecutive header-style
    # lines ("From:", "To:", "Reply-To:", ...) is a raw header dump, not a
    # real contact footer.
    text = "From: alerts@example.com\nTo: security@example.com\nReply-To: noreply@example.com\nSubject: Alert triggered"
    findings = placeholder_findings(text)
    assert findings and all(f.in_example for f in findings)
    assert placeholder_contacts(text) == []


def test_a_single_email_footer_line_is_not_in_example():
    # Controller decision item 4: a lone flush-left "Email: ..." line
    # stays prose -- it must not be swept up by the new HTTP-header-block
    # detection, which requires two or more consecutive header lines, and
    # "Email" is not one of the protocol header names it looks for anyway.
    text = "Reach out any time.\nEmail: yourname@company.com"
    findings = placeholder_findings(text)
    assert findings and all(not f.in_example for f in findings)
    assert "yourname@company.com" in placeholder_contacts(text)


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
        _add_document(
            db, client=client, bot=bot, name="https://northlane.example/signup", content=NORTHLANE_DIAL_CODE_PICKER
        )

        result = find_junk_chunks(db, bot.id)

        assert len(result.findings) == 1
        assert result.findings[0].document_name == "https://northlane.example/signup"
        assert any("dial codes" in reason for reason in result.findings[0].reasons)
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
