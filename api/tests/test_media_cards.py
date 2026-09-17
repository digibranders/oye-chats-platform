"""Which download cards a bot may offer, and when two cards are the same file.

Evaluation, 2026-09-17: CleanStart offered "**iifl case study** and **iifl case
study**", the same case study stored at two URLs, and the prompt review found
third-party PDFs (NIST, IBM, SEBI) in the files a bot could offer as its own.
"""

import time

import pytest

from app.services.media_cards import (
    card_identity,
    dedupe_cards,
    is_owned_file_url,
    media_owned_domains,
    owned_media_payloads,
)

IIFL = {
    "type": "download",
    "url": "https://cdn.cleanstart.com/case-studies/iifl-case-study.pdf",
    "name": "iifl-case-study.pdf",
}
IIFL_HASHED = {
    "type": "download",
    "url": "https://cdn.cleanstart.com/web/case-study/iifl-case-study-29330f6b.pdf",
    "name": "iifl-case-study-29330f6b.pdf",
}
BROCHURE = {"type": "download", "url": "https://www.cleanstart.com/files/Brochure.pdf", "name": "Brochure.pdf"}
VIDEO = {"type": "youtube", "video_id": "abc123", "title": "Brochure"}


class TestCardIdentity:
    def test_the_same_title_at_two_urls_is_one_file(self):
        assert card_identity(IIFL) & card_identity(IIFL_HASHED)

    @pytest.mark.parametrize(
        "other",
        [
            "HTTPS://WWW.CleanStart.com/files/Brochure.pdf",
            "https://cleanstart.com/files/Brochure.pdf?utm_source=chat",
            "https://www.cleanstart.com/files/Brochure.pdf#page=2",
            "https://www.cleanstart.com/files/Brochure%2Epdf",
        ],
    )
    def test_the_same_url_written_differently_is_one_file(self, other):
        assert card_identity(BROCHURE) & card_identity({"type": "download", "url": other, "name": "x-y.pdf"})

    def test_different_files_are_different(self):
        assert not card_identity(IIFL) & card_identity(BROCHURE)

    @pytest.mark.parametrize("name", ["Brochure.pdf", "Company-Profile.pdf", "Case_Study.pdf", "29330f6b.pdf"])
    def test_a_generic_name_at_two_urls_is_two_files(self, name):
        """Two products can each ship a "Brochure.pdf": only a name that says what the file is about merges them."""
        first = {"type": "download", "url": f"https://acme.com/product-a/{name}", "name": name}
        second = {"type": "download", "url": f"https://acme.com/product-b/{name}", "name": name}
        assert not card_identity(first) & card_identity(second)

    def test_a_video_and_a_file_with_one_title_are_different(self):
        assert not card_identity(VIDEO) & card_identity(BROCHURE)

    def test_a_video_is_its_id(self):
        assert card_identity(VIDEO) == card_identity({"type": "youtube", "video_id": "abc123"})

    @pytest.mark.parametrize("card", [None, {}, {"type": "download"}, {"type": "download", "url": 5}, "x"])
    def test_a_card_without_an_id_has_no_identity(self, card):
        assert card_identity(card) == frozenset()


class TestDedupeCards:
    def test_keeps_the_first_of_each_file_in_order(self):
        assert dedupe_cards([IIFL, BROCHURE, IIFL_HASHED, dict(BROCHURE)]) == [IIFL, BROCHURE]

    def test_skips_empty_entries(self):
        assert dedupe_cards([None, IIFL, {}]) == [IIFL]


class TestOwnedDomains:
    def test_reads_the_website_and_the_allowed_domains(self):
        owned = media_owned_domains(
            "https://www.cleanstart.com/", ["*.clnstrt.dev", "partner.example.org", "localhost"]
        )
        assert owned == frozenset({"cleanstart.com", "clnstrt.dev", "example.org"})

    @pytest.mark.parametrize("website", [None, "", "not a url", 42])
    def test_nothing_usable_owns_nothing(self, website):
        assert media_owned_domains(website, None) == frozenset()
        assert media_owned_domains(website, "cleanstart.com") == frozenset()

    def test_a_bare_host_is_read(self):
        assert media_owned_domains("eventussecurity.com", []) == frozenset({"eventussecurity.com"})


class TestIsOwnedFileUrl:
    OWNED = frozenset({"cleanstart.com", "eventussecurity.com"})

    @pytest.mark.parametrize(
        "url",
        [
            "https://cdn.cleanstart.com/web/resource/clean-libraries-data-sheet-0073f630.pdf",
            "https://eventussecurity.com/wp-content/uploads/2023/07/Datasheet-for-SOC-as-a-Service.pdf",
            # Files a website builder or storage bucket serves for the company's own site.
            "https://cdn.prod.website-files.com/64a/Brochure.pdf",
            "https://f.hubspotusercontent10.net/hubfs/123/Case-Study.pdf",
            "https://acme-assets.s3.amazonaws.com/Datasheet.pdf",
            "https://d111111abcdef8.cloudfront.net/whitepaper.pdf",
        ],
    )
    def test_a_file_on_the_company_or_its_asset_host_is_owned(self, url):
        assert is_owned_file_url(url, self.OWNED) is True

    @pytest.mark.parametrize(
        "url",
        [
            "https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-61r2.pdf",
            "https://www.ibm.com/downloads/cas/cost-of-a-data-breach-report-2024.pdf",
            "https://www.sebi.gov.in/legal/circulars/aug-2024/cscrf.pdf",
            "https://cleanstart.com.evil.example/file.pdf",
            "https://notcleanstart.com/file.pdf",
            "https://website-files.com.evil.example/file.pdf",
            "https://evilwebsite-files.com/file.pdf",
            "ftp://cleanstart.com/file.pdf",
            "not a url",
            None,
        ],
    )
    def test_anything_else_is_not(self, url):
        assert is_owned_file_url(url, self.OWNED) is False

    def test_a_bot_with_no_known_domain_filters_nothing(self):
        assert is_owned_file_url("https://www.ibm.com/report.pdf", frozenset()) is True
        assert is_owned_file_url(None, frozenset()) is False


class TestOwnedMediaPayloads:
    def test_drops_foreign_files_and_keeps_videos(self):
        payloads = [
            {
                "files": [
                    {"url": "https://www.cleanstart.com/a.pdf", "name": "a.pdf"},
                    {"url": "https://www.ibm.com/b.pdf", "name": "b.pdf"},
                ],
                "youtube": [{"video_id": "v1"}],
            },
            {"files": [{"url": "https://www.ibm.com/c.pdf"}]},
            "junk",
        ]
        kept = owned_media_payloads(payloads, frozenset({"cleanstart.com"}))
        assert kept == [
            {"files": [{"url": "https://www.cleanstart.com/a.pdf", "name": "a.pdf"}], "youtube": [{"video_id": "v1"}]},
            {"files": []},
        ]
        # The source payloads are not changed.
        assert len(payloads[0]["files"]) == 2

    def test_with_no_known_domain_the_payloads_are_returned_as_they_are(self):
        payloads = [{"files": [{"url": "https://www.ibm.com/b.pdf"}]}]
        assert owned_media_payloads(payloads, frozenset()) == payloads

    def test_reads_anything(self):
        assert owned_media_payloads(None, frozenset({"a.com"})) == []


def test_a_long_name_is_read_quickly():
    card = {"type": "download", "url": "https://a.com/" + "a-" * 20_000 + ".pdf", "name": "a-" * 20_000 + "0" * 9_000}
    started = time.perf_counter()
    card_identity(card)
    is_owned_file_url(card["url"], frozenset({"a.com"}))
    assert time.perf_counter() - started < 0.5
