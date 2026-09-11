"""A request for a brochure or datasheet is answered from the bot's file catalog.

Production, 2026-09-10: "can you send me your brochure?" got "That specific
detail sits with the team" and "email me a datasheet" got a message form, on all
four bots, including one with a catalog of datasheets. 0 of 8 passed.
"""

import timeit

import pytest

from app.services.document_request import (
    DocumentPick,
    asks_for_delivery,
    document_reply,
    is_document_request,
    pick_documents,
)
from app.services.intent_service import bot_offers_handoff

SOC = "https://acme.com/files/Datasheet-for-SOC-as-a-Service.pdf"
RED = "https://acme.com/files/Red-Teaming.pdf"
PROFILE = "https://acme.com/files/Acme-Company-Profile.pdf"

CATALOG = [
    {
        "files": [
            {"url": SOC, "name": "Datasheet-for-SOC-as-a-Service.pdf"},
            {"url": RED, "name": "Red-Teaming.pdf"},
            {"url": PROFILE, "name": "Acme-Company-Profile.pdf"},
            {"url": "javascript:alert(1)", "name": "bad.pdf"},
        ]
    }
]

BROCHURE = "https://acme.com/files/Acme-Company-Brochure-2025.pdf"
BROCHURE_CATALOG = [
    {
        "files": [
            {"url": "https://acme.com/files/Globex-Case-Study.pdf", "name": "Globex-Case-Study.pdf"},
            {"url": BROCHURE, "name": "Acme-Company-Brochure-2025.pdf"},
        ]
    }
]


def _catalog(*urls):
    return [{"files": [{"url": url, "name": url.rsplit("/", 1)[-1]} for url in urls]}]


@pytest.mark.parametrize(
    "msg",
    [
        "can you send me your brochure?",
        "email me a datasheet",
        "do you have a SOAR datasheet",
        "share the case study please",
        "any whitepapers?",
        "could you share your company profile",
        "is there a product catalogue I can download",
        "mail me the case studies",
        "can I get the SOC datasheet as pdf",
        "send me your catalog pdf",
        "download the product catalogue",
        "please forward the pitch deck",
        "can I download your sales deck?",
        "do you have a one-pager on managed detection?",
        "send over a spec sheet for the M2 sensor",
        "Brochure?",
        "where can I download the whitepaper",
        "can you email me the ebook",
        "give me the investor deck",
        "is the brochure available?",
        "share a pdf of the red teaming service",
        "send me your design brochure",
        "can you send me the brochure for your printing services",
        # Contact details after the request are not the visitor's own document.
        "send me your brochure, my number is 9876543210",
        "can you send the brochure to my email",
        # "your" names the business's document, whoever else the sentence mentions.
        "can you share your brochure with our team",
        "how can I get your brochure?",
        # A product named "X as a Service".
        "can you send me the SOC as a Service datasheet",
        # Two shapes that were missed.
        "can I have a look at the Skyline Towers brochure?",
        "u got a wedding brochure?",
    ],
)
def test_document_requests_are_recognised(msg):
    assert is_document_request(msg) is True


@pytest.mark.parametrize(
    "msg",
    [
        "tell me about SOC as a Service",
        "what do you document during onboarding",
        "how much does it cost",
        "",
        "   ",
        # Making or editing the item is a service the business may sell.
        "do you design brochures?",
        "I need a company profile designed for my business",
        "can you print 500 brochures",
        "do you build decks and patios?",
        "I want to convert a pdf to word",
        "which pdf editor do you recommend",
        "do you make pitch decks for startups?",
        "can you write a case study for us?",
        "I need someone to design a brochure",
        "we need brochures printed",
        "we need brochure design for our launch",
        "can I get a pdf editor from you",
        "do you offer case study writing services?",
        # A shop's catalog of products, not a file.
        "show me your catalog of shoes",
        # "deck" alone and "pdf" without a sending verb are not requests.
        "what decks do you install?",
        "I want a pdf",
        # The visitor holding the document is not asking for it.
        "I have a question about your brochure",
        # A pdf mentioned without a sending verb is not a request, even next
        # to a file word: "download"/"file" only turn a CATALOG into one.
        "how do I open the pdf file",
        "do you have pdf files",
        "the pdf download link is broken",
        "is the catalog file big",
        # A question about a product feature, not a request for a file.
        "can I download reports as pdf?",
        "can users download invoices as pdf",
        "can I share a pdf with my team in the app",
        "how do I send a pdf to a customer using your tool",
        "does the bot share brochures with visitors?",
        "can the chatbot send my brochure to leads",
        "can I email a brochure to my leads from the dashboard",
        # The visitor's own files.
        "please share the pdf of my contract",
        "can you email me the pdf of my lab report",
        "send me the invoice pdf for my order",
        "how do I download my payslip pdf",
        "where can I download my offer letter pdf",
        "how do I download the ebook I bought",
        # Files sent to the business.
        "can I send you my pdf for printing",
        "can I email you my brochure file for review",
        # Services around a document.
        "can you help me get my ebook published",
        "I need 1000 brochures, can you give me a quote",
    ],
)
def test_other_questions_are_not(msg):
    assert is_document_request(msg) is False


@pytest.mark.parametrize(
    "msg",
    [
        # An ask verb that governs something other than the document: a quote, an
        # invoice, a refund, feedback, a minute, a person.
        "what's the turnaround time to get 200 flyers and a brochure?",
        "please share your feedback on the whitepaper draft I emailed you",
        "give me a minute, I'm reading the datasheet now",
        "send me an invoice for the case study workshop I attended",
        "can I get a refund if the ebook I bought is the wrong edition?",
        "can you email me when the new catalog is out?",
        "get me someone who can explain the SOAR datasheet",
        # A document noun that only describes another noun.
        "can you share whitepaper topic ideas for next quarter?",
        "do students get case study sessions with industry mentors?",
        "will you give a discount if we buy the ebook bundle for a class of 40?",
    ],
)
def test_an_ask_for_something_else_is_not_a_document_request(msg):
    assert is_document_request(msg) is False
    assert asks_for_delivery(msg) is False


def test_a_non_string_is_not_a_request():
    assert is_document_request(None) is False


def test_a_named_topic_picks_the_matching_file():
    pick = pick_documents("send me the SOC as a Service datasheet", "Acme", CATALOG)
    assert pick.exact is True
    assert pick.docs[0]["url"] == SOC


def test_a_picked_file_is_shaped_like_a_download_card():
    pick = pick_documents("send me the SOC as a Service datasheet", "Acme", CATALOG)
    assert pick.docs[0] == {"type": "download", "url": SOC, "name": "Datasheet-for-SOC-as-a-Service.pdf"}


def test_a_file_with_no_name_is_named_from_its_url():
    catalog = [{"files": [{"url": "https://acme.com/files/Red-Teaming.pdf?v=2", "name": "  "}]}]
    pick = pick_documents("send me the red teaming datasheet", "Acme", catalog)
    assert pick.docs[0]["name"] == "Red-Teaming.pdf"


def test_a_topic_with_no_matching_file_falls_back_to_the_kind_asked_for():
    pick = pick_documents("send me the Kubernetes hardening datasheet", "Acme", CATALOG)
    assert [d["url"] for d in pick.docs] == [SOC]
    assert pick.exact is False


def test_a_topic_with_no_file_of_its_kind_returns_nothing():
    assert pick_documents("send me the Kubernetes hardening whitepaper", "Acme", CATALOG).docs == []


@pytest.mark.parametrize(
    "msg",
    [
        "can you email the brochure to rahul.sharma@gmail.com",
        "hi, I'm Rahul. send me your brochure",
        "send me your brochure, my number is 9876543210",
        "can you send me your services brochure?",
        "send me your latest 2026 brochure",
        "pls send brochure on whatsapp",
        "send me your brochure, I'm interested in your offerings",
        "send me your brochure. also do you work with banks?",
    ],
)
def test_extra_words_in_a_brochure_request_still_find_the_brochure(msg):
    assert is_document_request(msg) is True
    assert asks_for_delivery(msg) is True
    assert [d["url"] for d in pick_documents(msg, "Acme", BROCHURE_CATALOG).docs] == [BROCHURE]


@pytest.mark.parametrize(
    "msg",
    [
        "can you email the brochure to rahul.sharma@gmail.com",
        "send the brochure to +91 98765-43210",
        "send the brochure from https://acme.com/about",
    ],
)
def test_contact_details_are_not_a_topic(msg):
    pick = pick_documents(msg, "Acme", BROCHURE_CATALOG)
    assert [d["url"] for d in pick.docs] == [BROCHURE]
    assert pick.exact is True


def test_a_profile_request_from_a_named_visitor_falls_back_to_the_brochure():
    pick = pick_documents("I'm Rahul from Infosys, please send me your company profile", "Acme", BROCHURE_CATALOG)
    assert [d["url"] for d in pick.docs] == [BROCHURE]
    assert pick.exact is False


def test_one_shared_word_is_not_an_exact_match():
    catalog = _catalog(
        "https://shop.example.com/f/Model-X100-Spec-Sheet.pdf",
        "https://shop.example.com/f/Model-X300-Spec-Sheet.pdf",
    )
    pick = pick_documents("get me a spec sheet for model X200", "ShopCo", catalog)
    assert pick.exact is False
    # Both are spec sheets, so the second rides along with the first.
    assert [d["name"] for d in pick.docs] == ["Model-X100-Spec-Sheet.pdf", "Model-X300-Spec-Sheet.pdf"]


def test_a_soc_2_report_is_not_the_soc_as_a_service_datasheet():
    catalog = _catalog(
        "https://eventussecurity.com/files/Datasheet-for-SOC-as-a-Service.pdf",
        "https://eventussecurity.com/files/Sample_Web_Application_Penetration_Testing_Report_v1.0.pdf",
    )
    pick = pick_documents("send me your SOC 2 report pdf", "Eventus Security", catalog)
    assert pick.exact is False
    # "SOC 2" is one identifier, so the SOC as a Service datasheet shares no word
    # with the question and is not offered.
    assert "Datasheet-for-SOC-as-a-Service.pdf" not in [d["name"] for d in pick.docs]


@pytest.mark.parametrize(
    ("msg", "url"),
    [
        ("send me the winter collection catalog", "https://shop.example.com/f/Summer-Collection-Catalog.pdf"),
        ("send me the dinner menu pdf", "https://resto.example.com/m/Lunch-Menu.pdf"),
    ],
)
def test_a_different_item_of_the_same_line_is_not_exact(msg, url):
    pick = pick_documents(msg, "Acme", _catalog(url))
    assert [d["url"] for d in pick.docs] == [url]
    assert pick.exact is False


def test_a_single_topic_word_that_matches_is_exact():
    url = "https://eventussecurity.com/files/Eventus-SOAR-Platform-Datasheet.pdf"
    pick = pick_documents("send me the SOAR datasheet", "Eventus Security", _catalog(url, SOC))
    assert [d["url"] for d in pick.docs] == [url]
    assert pick.exact is True


def test_every_word_of_the_file_name_named_in_the_question_is_exact():
    url = "https://acme.com/files/MBA-Brochure.pdf"
    pick = pick_documents("send me the brochure for MBA program", "Acme", _catalog(url))
    assert [d["url"] for d in pick.docs] == [url]
    assert pick.exact is True


def test_every_word_of_a_multi_word_file_name_named_in_the_question_is_exact():
    url = "https://acme.com/files/Skyline-Brochure.pdf"
    pick = pick_documents("send me the Skyline brochure and floor plan", "Acme", _catalog(url))
    assert [d["url"] for d in pick.docs] == [url]
    assert pick.exact is True


@pytest.mark.parametrize(
    ("names", "msg"),
    [
        (["SOC.pdf"], "send me your SOC 2 report pdf"),
        (["Services.pdf"], "can you share the managed services case study"),
        (["2025.pdf"], "send me your 2025 case study on banking"),
        (["Platform.pdf"], "share the SOAR platform datasheet"),
        (["Cloud.pdf"], "do you have a case study on cloud migration?"),
        (["Tower-A.pdf", "Tower-B.pdf"], "send me the Tower B floor plan pdf"),
        # The file is a brochure, but a year is all its name says.
        (["Brochure-2025.pdf"], "send me your 2025 brochure on banking"),
    ],
)
def test_naming_every_word_of_a_file_is_not_exact_unless_the_file_is_the_kind_asked_for(names, msg):
    pick = pick_documents(msg, "Acme", _catalog(*(f"https://acme.com/files/{name}" for name in names)))
    assert pick.exact is False


@pytest.mark.parametrize(
    ("names", "msg", "picked", "exact"),
    [
        (
            ["Tower-A-Brochure.pdf", "Tower-B-Brochure.pdf"],
            "send me the Tower B brochure",
            ["Tower-B-Brochure.pdf"],
            True,
        ),
        (
            ["Tower-A-Brochure.pdf", "Tower-B-Brochure.pdf"],
            "send me the tower a brochure",
            ["Tower-A-Brochure.pdf"],
            True,
        ),
        (["Tower-A.pdf", "Tower-B.pdf"], "send me the Tower B floor plan pdf", ["Tower-B.pdf"], False),
        (
            ["Phase-1-Brochure.pdf", "Phase-2-Brochure.pdf"],
            "can you share the phase 2 brochure",
            ["Phase-2-Brochure.pdf"],
            True,
        ),
        (
            ["Phase-1-Brochure.pdf", "Phase-2-Brochure.pdf"],
            "send me the Phase 1 brochure",
            ["Phase-1-Brochure.pdf"],
            True,
        ),
    ],
)
def test_a_short_identifier_picks_its_own_file(names, msg, picked, exact):
    pick = pick_documents(msg, "Skyline Homes", _catalog(*(f"https://skyline.example.com/f/{name}" for name in names)))
    assert [d["name"] for d in pick.docs] == picked
    assert pick.exact is exact


@pytest.mark.parametrize(
    ("msg", "catalog", "url"),
    [
        ("hi, I'm Rahul. send me your brochure", BROCHURE_CATALOG, BROCHURE),
        ("pls send brochure on whatsapp", BROCHURE_CATALOG, BROCHURE),
        ("send me your latest 2026 brochure", BROCHURE_CATALOG, BROCHURE),
        ("I'm Rahul from Infosys, please send me your company profile", CATALOG, PROFILE),
    ],
)
def test_a_name_a_channel_or_an_unlisted_year_is_not_a_topic(msg, catalog, url):
    pick = pick_documents(msg, "Acme", catalog)
    assert [d["url"] for d in pick.docs] == [url]
    assert pick.exact is True
    assert "exact document" not in document_reply(pick, company_name="Acme", support_enabled=True)


def test_a_file_name_with_no_topic_words_is_not_made_exact_by_the_covering_rule():
    url = "https://acme.com/files/Brochure.pdf"
    pick = pick_documents("send me the brochure for MBA program", "Acme", _catalog(url))
    assert pick.exact is False


def test_a_risk_profile_is_not_a_company_profile():
    catalog = _catalog("https://agency.example.com/wp/Risk-Profile-Assessment-Sample.pdf")
    assert pick_documents("do you have a company profile?", "Acme", catalog).docs == []


def test_a_file_of_another_kind_is_not_exact():
    catalog = _catalog("https://eventussecurity.com/files/Sample_Web_Application_Penetration_Testing_Report_v1.0.pdf")
    pick = pick_documents("send me the penetration testing datasheet", "Eventus Security", catalog)
    assert len(pick.docs) == 1
    assert pick.exact is False


def test_a_case_study_does_not_ride_along_with_a_datasheet():
    red_case = "https://acme.com/files/Red-Teaming-Case-Study.pdf"
    pick = pick_documents("share the red teaming datasheets please", "Acme", _catalog(red_case, RED))
    assert [d["url"] for d in pick.docs] == [RED]
    assert pick.exact is True


MIXED_CATALOG = _catalog(
    "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf",
    "https://www-api.ibm.com/assets/cost-of-a-data-breach-2025-full-report.pdf",
    PROFILE,
)


def test_a_generic_request_never_offers_third_party_reports():
    pick = pick_documents("send me your brochure", "Acme", MIXED_CATALOG, limit=10)
    assert [d["url"] for d in pick.docs] == [PROFILE]
    assert pick.exact is False


def test_a_generic_request_with_no_profile_gets_the_no_file_reply():
    catalog = [{"files": [f for f in MIXED_CATALOG[0]["files"] if f["url"] != PROFILE]}]
    pick = pick_documents("send me your brochure", "Acme", catalog)
    assert pick.docs == []
    assert "don't have a downloadable document" in document_reply(pick, company_name="Acme", support_enabled=True)


def test_a_generic_brochure_request_prefers_the_company_profile():
    pick = pick_documents("can you send me your brochure?", "Acme", CATALOG)
    assert pick.docs[0]["url"] == PROFILE
    assert pick.exact is False


def test_polite_words_do_not_count_as_a_topic():
    pick = pick_documents("could you share your company profile please", "Acme", CATALOG)
    assert pick.docs[0]["url"] == PROFILE


@pytest.mark.parametrize(
    "msg",
    [
        "thanks! could you email me the brochure",
        "hey guys send me your brochure",
    ],
)
def test_greetings_and_filler_do_not_count_as_a_topic(msg):
    pick = pick_documents(msg, "Acme", CATALOG)
    assert pick.docs[0]["url"] == PROFILE


def test_a_plural_kind_matches_a_singular_file_name():
    catalog = [
        {"files": [{"url": RED, "name": "Red-Teaming.pdf"}]},
        {"files": [{"url": "https://acme.com/files/Case-Study-Bank.pdf", "name": "Case-Study-Bank.pdf"}]},
    ]
    pick = pick_documents("mail me the case studies", "Acme", catalog)
    assert pick.exact is True
    assert [d["url"] for d in pick.docs] == ["https://acme.com/files/Case-Study-Bank.pdf"]


def test_at_most_two_files_come_back_by_default():
    catalog = _catalog(*(f"https://acme.com/files/Datasheet-{n}.pdf" for n in ("A", "B", "C")))
    pick = pick_documents("any datasheets?", "Acme", catalog)
    assert len(pick.docs) == 2


def test_unusable_urls_never_come_back():
    catalog = CATALOG + [
        {
            "files": [
                {"url": "https://hub.doc", "name": "Datasheet-hub.doc"},
                {"url": "ftp://acme.com/x.pdf", "name": "Datasheet-x.pdf"},
                {"url": "javascript:alert(1)", "name": "Datasheet-bad.pdf"},
            ]
        }
    ]
    pick = pick_documents("any datasheets?", "Acme", catalog, limit=10)
    assert {d["url"] for d in pick.docs} == {SOC}


def test_a_malformed_catalog_returns_nothing():
    assert pick_documents("any brochures?", "Acme", None).docs == []
    assert pick_documents("any brochures?", "Acme", ["x", {"files": ["y", {"url": 3}]}]).docs == []


@pytest.mark.parametrize(
    "catalog",
    [
        "x",
        5,
        {"files": [{"url": BROCHURE, "name": "Acme-Company-Brochure-2025.pdf"}]},
        [{"files": 5}],
        [{"files": "abc"}],
        [{"files": {"url": BROCHURE, "name": "Acme-Company-Brochure-2025.pdf"}}],
        [{"files": None}],
        [{"files": [{"name": "Acme-Company-Brochure-2025.pdf"}]}],
        [{"files": [{"url": None, "name": "Acme-Company-Brochure-2025.pdf"}]}],
    ],
)
def test_an_odd_catalog_shape_offers_nothing(catalog):
    assert pick_documents("send me your brochure", "Acme", catalog).docs == []


@pytest.mark.parametrize("name", [None, 7, ["Brochure"], {"x": 1}])
def test_a_file_with_a_name_that_is_not_text_is_named_from_its_url(name):
    pick = pick_documents("send me your brochure", "Acme", [{"files": [{"url": BROCHURE, "name": name}]}])
    assert [d["name"] for d in pick.docs] == ["Acme-Company-Brochure-2025.pdf"]


def test_the_reply_never_promises_email():
    for pick in (pick_documents("email me a datasheet", "Acme", CATALOG), DocumentPick(docs=[], exact=False)):
        for support in (True, False):
            assert "email" not in document_reply(pick, company_name="Acme", support_enabled=support).lower()


def test_no_file_on_a_plan_with_a_human_offers_the_team():
    reply = document_reply(DocumentPick(docs=[], exact=False), company_name="Acme", support_enabled=True)
    assert "connect you with the team" in reply
    # A "yes" to this reply is a handoff.
    assert bot_offers_handoff(reply) is True


def test_no_file_on_a_plan_without_a_human_points_to_the_website():
    for company in ("Acme", None):
        reply = document_reply(DocumentPick(docs=[], exact=False), company_name=company, support_enabled=False)
        assert "website" in reply
        assert bot_offers_handoff(reply) is False


@pytest.mark.parametrize(
    ("name", "shown"),
    [
        ("68d65d47051e1b0ca7a66228_Solution%20Document%20-%20Cleanstart.pdf", "**Solution Document Cleanstart**"),
        ("iifl-case-study-29330f6b.pdf", "**iifl case study**"),
        ("53450e6e5dc0bfa85ebd78686cadad39.pdf", "**53450e6e5dc0bfa85ebd78686cadad39**"),
    ],
)
def test_a_reply_shows_a_readable_file_name(name, shown):
    pick = DocumentPick(docs=[{"type": "download", "url": f"https://acme.com/{name}", "name": name}], exact=True)
    assert shown in document_reply(pick, company_name="Acme", support_enabled=True)


def test_an_inexact_pick_says_so():
    pick = pick_documents("can you send me your brochure?", "Acme", CATALOG)
    assert "don't have that exact document" in document_reply(pick, company_name="Acme", support_enabled=True)


def test_an_exact_reply_names_every_file_once_without_links():
    docs = [{"type": "download", "url": f["url"], "name": f["name"]} for f in CATALOG[0]["files"] if f["url"] != RED]
    pick = DocumentPick(docs=docs[:2], exact=True)
    reply = document_reply(pick, company_name="Acme", support_enabled=True)
    assert "**Acme Company Profile**" in reply
    assert "**Datasheet for SOC as a Service**" in reply
    # The cards carry the links; the text does not repeat them.
    assert "https://" not in reply


@pytest.mark.parametrize(
    "msg",
    [
        "can you send me your brochure?",
        "email me a datasheet",
        "could you share the case study",
        "please forward the pitch deck",
        "can you mail the whitepaper",
        "give me the investor deck",
        "can I have the brochure",
        "could I have the datasheet",
        "can you send me the SOC as a Service datasheet",
        "can I get the SOC datasheet as pdf",
        "download the product catalogue",
    ],
)
def test_asks_for_delivery_true(msg):
    assert asks_for_delivery(msg) is True


@pytest.mark.parametrize(
    "msg",
    [
        "do you have case studies of fintech clients?",
        "do you have a company profile?",
        "any whitepapers?",
        "is there a brochure for this product",
        "can I see the brochure",
        "can I have a look at the brochure?",
        "show me the catalog",
        "is the datasheet available?",
        "what do you document during onboarding",
        "",
        "   ",
    ],
)
def test_asks_for_delivery_false(msg):
    assert asks_for_delivery(msg) is False


def test_asks_for_delivery_of_a_non_string_is_false():
    assert asks_for_delivery(None) is False


def _long(piece: str) -> str:
    return (piece * (5000 // len(piece) + 1))[:5000]


#: 5,000 characters, the most the chat schema accepts, shaped to make a careless
#: pattern backtrack: long runs of spaces, letters, "a@", digits and repeated asks.
ADVERSARIAL = {
    "spaces then a document": " " * 4990 + "brochure x",
    "a document then spaces": "brochure" + " " * 4991 + "x",
    "your then spaces": "your" + " " * 4988 + "brochure",
    "letters": "a" * 5000,
    "letters around an at sign": "a" * 2500 + "@" + "a" * 2499,
    "at signs": _long("a@"),
    "dots": _long("a."),
    "digits": "9" * 5000,
    "spaced digits": _long("9 "),
    "send me": _long("send me "),
    "document nouns": _long("brochure "),
    "my": _long("my "),
    "links": _long("www."),
    "data sheet": _long("data  "),
    "mixed": _long("hi I'm Rahul, send me your SOC 2 brochure via email a@b.co +91 98765 43210 tower b of the "),
}
FIFTY_FILES = _catalog(*(f"https://acme.com/files/Topic-{n}-Tower-{n % 7}-Brochure.pdf" for n in range(50)))


@pytest.mark.parametrize("text", list(ADVERSARIAL.values()), ids=list(ADVERSARIAL))
def test_a_long_message_is_read_quickly(text):
    assert len(text) == 5000
    for read in (
        lambda: is_document_request(text),
        lambda: asks_for_delivery(text),
        lambda: pick_documents(text, "Acme", FIFTY_FILES),
    ):
        assert min(timeit.repeat(read, number=1, repeat=3)) < 0.05
