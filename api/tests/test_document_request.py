"""A request for a brochure or datasheet is answered from the bot's file catalog.

Production, 2026-09-10: "can you send me your brochure?" got "That specific
detail sits with the team" and "email me a datasheet" got a message form, on all
four bots, including one with a catalog of datasheets. 0 of 8 passed.
"""

import pytest

from app.services.document_request import DocumentPick, document_reply, is_document_request, pick_documents
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
    ],
)
def test_other_questions_are_not(msg):
    assert is_document_request(msg) is False


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


def test_a_topic_with_no_matching_file_returns_nothing():
    assert pick_documents("send me the Kubernetes hardening datasheet", "Acme", CATALOG).docs == []


def test_a_generic_brochure_request_prefers_the_company_profile():
    pick = pick_documents("can you send me your brochure?", "Acme", CATALOG)
    assert pick.docs[0]["url"] == PROFILE
    assert pick.exact is False


def test_polite_words_do_not_count_as_a_topic():
    pick = pick_documents("could you share your company profile please", "Acme", CATALOG)
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
    pick = pick_documents("any whitepapers?", "Acme", CATALOG)
    assert len(pick.docs) == 2


def test_unusable_urls_never_come_back():
    catalog = CATALOG + [
        {"files": [{"url": "https://hub.doc", "name": "hub.doc"}, {"url": "ftp://acme.com/x.pdf", "name": "x.pdf"}]}
    ]
    pick = pick_documents("any whitepapers?", "Acme", catalog, limit=10)
    assert {d["url"] for d in pick.docs} == {SOC, RED, PROFILE}


def test_a_malformed_catalog_returns_nothing():
    assert pick_documents("any brochures?", "Acme", None).docs == []
    assert pick_documents("any brochures?", "Acme", ["x", {"files": ["y", {"url": 3}]}]).docs == []


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


def test_an_inexact_pick_says_so():
    pick = pick_documents("can you send me your brochure?", "Acme", CATALOG)
    assert "don't have that exact document" in document_reply(pick, company_name="Acme", support_enabled=True)


def test_an_exact_reply_names_every_file_once_without_links():
    pick = DocumentPick(docs=pick_documents("any whitepapers?", "Acme", CATALOG).docs, exact=True)
    reply = document_reply(pick, company_name="Acme", support_enabled=True)
    assert "**Acme Company Profile**" in reply
    assert "**Datasheet for SOC as a Service**" in reply
    # The cards carry the links; the text does not repeat them.
    assert "https://" not in reply
