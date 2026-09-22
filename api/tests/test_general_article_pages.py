"""A general article in the reference context is labelled as one.

Production evaluation, 2026-09-17: Eventus answered "if we raise a P1 at 2am
whats the guaranteed response time in the contract" with "We have a documented
P1 acknowledge target of 10 min". The figure is an "e.g." in a buyer guide,
/best-soc-as-a-service-providers-2025. It called a CISO checklist's MTTD and MTTR
numbers "the closest published targets", stated a generic article's "remediate
critical findings within 48 hours" as its patch SLA, said "Yes" to a fully
air-gapped SOC when the knowledge base only says on-premises, and said "we
support France" with nothing about France in it.

The model could not tell a listicle from a contract: every document reached it
with the same header. A crawled page whose path reads as a guide, listicle,
comparison, glossary, checklist, "what is" or "how to" page, or a blog post, now
carries a short tag in its header, and RULES 5a and 5c say what the tag and an
over-broad "yes" mean.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

from app.services import rag_service as rs
from app.services.page_kind import GENERAL_ARTICLE_TAG, is_general_article
from app.services.qualification_service import get_framework_config


def _chunk(content: str, name: str) -> SimpleNamespace:
    return SimpleNamespace(content=content, document_name=name)


# ── Which pages are general articles ─────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    [
        "https://eventussecurity.com/best-soc-as-a-service-providers-2025/",
        "https://eventussecurity.com/blog/backups-are-not-cyber-resilience-what-organizations-must-do/",
        "https://eventussecurity.com/cybersecurity/how-to-build-an-incident-response-team/",
        "https://eventussecurity.com/cybersecurity/top-agentic-soc-platforms/",
        "https://eventussecurity.com/cybersecurity/siem-vs-soar-comparison/",
        "https://eventussecurity.com/cybersecurity/dpdpa-compliance-checklist/",
        "https://www.cleanstart.com/guide/patch-management",
        "https://www.cleanstart.com/knowledge-hub/what-is-sbom",
        "https://www.cleanstart.com/knowledge-hub/glossary",
        "https://www.cleanstart.com/knowledge-hub/container-registries-compared",
        "https://example.com/top-10-siem-tools-2025/",
        "https://example.com/insights/zero-trust-roadmap/",
        "https://example.com/resources/soc-maturity/",
        "https://example.com/soc-onboarding-explained/",
        # A roll-call of other firms, with no "best" or "top" in the slug.
        # Production evaluation, 2026-09-18: Eventus answered "ISO 27001
        # certified" for itself out of this page.
        "https://eventussecurity.com/cybersecurity/india/soc-service-providers/",
        "https://eventussecurity.com/cybersecurity/top-red-teaming-companies-in-india/",
        "https://eventussecurity.com/india/incident-response-companies/",
        "https://eventussecurity.com/uae/mssp-providers/",
        # A buyer checklist: a topic, then the role it is written for.
        # Production evaluation, 2026-09-21: Eventus gave this page's
        # "Penalties & Exit" row as "our terms" (case x-contract-exit).
        "https://eventussecurity.com/soc-as-a-service-ciso/",
        "https://example.com/managed-detection-and-response-cto/",
        "https://example.com/container-security-buyers/",
    ],
)
def test_a_crawled_guide_listicle_comparison_or_blog_post_is_a_general_article(name):
    assert is_general_article(name, "Acme") is True


@pytest.mark.parametrize(
    "name",
    [
        "https://eventussecurity.com/",
        "https://eventussecurity.com/managed-soc-service/",
        "https://eventussecurity.com/security-operations-center-as-a-service-core-capabilities/",
        "https://eventussecurity.com/terms-and-condition/",
        "https://www.cleanstart.com/knowledge-hub/sla-documentation",
        "https://www.cleanstart.com/knowledge-hub/sla-support-tiers",
        "https://www.cleanstart.com/knowledge-hub/air-gapped-deployment",
        "https://www.cleanstart.com/legal/master-serviceand-license-agreement",
        # A list noun needs a word in front of it: a bare section is the
        # company's own.
        "https://eventussecurity.com/providers/",
        "https://www.cleanstart.com/knowledge-hub/secure-vendor-risk-assessment",
        # One word before the role is the company's own page for an audience,
        # not a checklist about the market.
        "https://www.cleanstart.com/for-ciso",
        "https://www.cleanstart.com/event/et-ciso",
        "https://eventussecurity.com/ciso/",
        # A page that takes the visitor to the role rather than describing the
        # market for it: "verb-possessive-role" is the company's own.
        "https://eventussecurity.com/meet-our-cto/",
        "https://eventussecurity.com/contact-a-ciso/",
        "https://eventussecurity.com/leadership-team-cto/",
        "https://eventussecurity.com/about-our-ciso/",
        "https://eventussecurity.com/team-page-cfo/",
    ],
)
def test_the_companys_own_service_terms_and_policy_pages_are_not(name):
    """CleanStart's SLA tiers live under /knowledge-hub/, so the hub itself is
    not a sign of a general article: only the page's own words are."""
    assert is_general_article(name, "Acme") is False


@pytest.mark.parametrize(
    "name",
    [
        "https://eventussecurity.com/how-does-24-7-managed-soc-support-work-in-practice/",
        "https://eventussecurity.com/what-we-do/",
        "https://eventussecurity.com/how-we-work/",
        "https://eventussecurity.com/about/how-it-works/",
        "https://eventussecurity.com/pricing/how-it-works",
        "https://eventussecurity.com/why-choose-us/best-in-class-support/",
        "https://eventussecurity.com/learn-more/",
        "https://eventussecurity.com/top-rated-support/",
        # A bare "how" slug reads like the company's own "how it works" page, so
        # it is left untagged even when the page is an article.
        "https://www.cleanstart.com/knowledge-hub/how-enterprises-patch-containers",
    ],
)
def test_a_question_word_or_best_or_learn_alone_does_not_tag_a_page(name):
    """Review, 2026-09-17: "how", "what", "best", "top" and "learn" as single
    path words tagged the company's own service pages, so their SLAs and terms
    were read as a general article's."""
    assert is_general_article(name, "Acme") is False


def test_the_check_is_linear_on_a_long_path():
    import time

    started = time.perf_counter()
    for path in (
        "best-" * 5000,
        "top-" * 5000 + "1",
        "-vs" * 5000,
        "/blog" * 3000,
        "a-" * 5000 + "providers",
        "a-" * 5000 + "ciso",
        "a-" * 99 + "ciso",
    ):
        is_general_article(f"https://example.com/{path}", "Acme")
    assert time.perf_counter() - started < 0.5


def test_the_credential_own_page_check_keeps_its_broader_word_set():
    """``credential_facts`` still treats any "how", "what", "best" or "learn"
    page as not the company's own, which is the safe side for a credential."""
    from app.services import credential_facts

    assert credential_facts._is_own_page("https://acme.com/about/certifications") is True
    assert credential_facts._is_own_page("https://acme.com/how-we-work/certifications") is False
    assert credential_facts._is_own_page("https://acme.com/learn/about-certifications") is False


@pytest.mark.parametrize(
    "name,company",
    [
        ("https://www.cleanstart.com/knowledge-hub/how-cleanstart-compares", "CleanStart"),
        ("https://www.cleanstart.com/blogs/official-go-docker-image-vs-cleanstart-hardened-go-image", "CleanStart"),
        ("https://eventussecurity.com/blog/how-eventus-runs-its-soc/", "Eventus Security"),
    ],
)
def test_a_page_that_names_the_company_in_its_path_is_about_the_company(name, company):
    assert is_general_article(name, company) is False


def test_the_host_does_not_count_as_naming_the_company():
    assert is_general_article("https://cleanstart.com/guide/patch-management", "CleanStart") is True


@pytest.mark.parametrize("name", ["Buyer Guide.pdf", "how-to-onboard.md", "best-practices.docx", ""])
def test_an_uploaded_file_is_never_tagged(name):
    """The owner chose to upload it, so it speaks for the company whatever it is called."""
    assert is_general_article(name, "Acme") is False


def test_a_generic_first_word_in_the_company_name_does_not_exempt_every_listicle():
    assert is_general_article("https://bestco.example/best-crm-tools/", "Best Co") is True


# ── The tag in the reference context ────────────────────────────────────────

_GUIDE = "https://eventussecurity.com/best-soc-as-a-service-providers-2025/"
_OWN = "https://eventussecurity.com/managed-soc-service/"


class TestTheReferenceContextCarriesTheTag:
    def test_a_general_article_header_says_so(self):
        context = rs._build_reference_context([_chunk("SLAs (e.g., P1 acknowledge 10 min).", _GUIDE)], "Eventus")

        assert f"<<<DOCUMENT 1 | {_GUIDE} | {GENERAL_ARTICLE_TAG}>>>" in context

    def test_the_tag_names_what_the_page_is_not(self):
        assert GENERAL_ARTICLE_TAG == "general article, not the company's own terms"

    def test_an_own_page_header_is_unchanged(self):
        context = rs._build_reference_context([_chunk("We run a 24x7 SOC.", _OWN)], "Eventus")

        assert f"<<<DOCUMENT 1 | {_OWN}>>>" in context
        assert GENERAL_ARTICLE_TAG not in context

    def test_headers_still_parse_by_index_and_name(self):
        """The groundedness test and anything else that finds a block by
        ``<<<DOCUMENT i |`` keeps working, and a tag never forges a fence."""
        context = rs._build_reference_context([_chunk("guide text", _GUIDE), _chunk("own text", _OWN)], "Eventus")
        headers = re.findall(r"<<<DOCUMENT (\d+) \| ([^|>]+?)(?: \| ([^>]+))?>>>", context)

        assert headers == [("1", _GUIDE, GENERAL_ARTICLE_TAG), ("2", _OWN, "")]
        assert context.count("<<<END DOCUMENT 1>>>") == 1
        assert context.count("<<<END DOCUMENT 2>>>") == 1

    def test_the_company_name_reaches_the_check(self):
        name = "https://www.cleanstart.com/knowledge-hub/how-cleanstart-compares"
        context = rs._build_reference_context([_chunk("We compare.", name)], "CleanStart")

        assert GENERAL_ARTICLE_TAG not in context


# ── What the prompt says about the tag and about "yes" ───────────────────────


def _system() -> str:
    system, _user = rs.build_hybrid_prompt(
        SimpleNamespace(name="Acme"),
        "what is your P1 response time",
        "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n",
        "USER: hi\nBOT: hello",
        bant_enabled=True,
        bant_config=get_framework_config(None),
        live_chat_enabled=True,
        support_enabled=True,
        company_name="Acme",
    )
    return system


def _flat(text: str) -> str:
    return " ".join(text.split())


def _between(text: str, start: str, end: str) -> str:
    begin = text.index(start)
    return text[begin : text.index(end, begin)]


class TestThePromptReadsTheTag:
    def test_own_terms_rule_names_the_tag_and_the_terms_it_covers(self):
        rule = _flat(_between(_system(), "OWN CREDENTIALS AND TERMS.", "\n  (a) GAP."))

        assert f'A document whose header says "{GENERAL_ARTICLE_TAG}" is one of these.' in rule
        assert (
            "SLAs, response or remediation times, guarantees and the countries Acme serves are Acme's own "
            "only when an untagged document states them for Acme." in rule
        )

    def test_a_borrowed_figure_is_not_a_closest_fact(self):
        """The MTTD answer said it had no SLA, then quoted a checklist's figures
        as "the closest published targets"."""
        rule = _flat(_between(_system(), "OWN CREDENTIALS AND TERMS.", "\n  (a) GAP."))

        assert (
            "A figure given as an example, a best practice or what to ask of a provider is never ours, "
            "not even as a closest or typical target: say our exact terms come from our team." in rule
        )

    def test_a_yes_matches_the_exact_capability(self):
        rule = _flat(_between(_system(), "\n5c. ", "\n5d. "))

        assert (
            "A yes must match the exact capability asked: on-premises is not air-gapped, and offices or "
            "clients in a region are not service in a named country. When only the nearer fact is stated, "
            "give that fact and the gap." in rule
        )

    def test_each_new_clause_is_stated_once(self):
        prompt = _system()

        assert prompt.count(GENERAL_ARTICLE_TAG) == 1
        assert prompt.count("on-premises is not air-gapped") == 1
