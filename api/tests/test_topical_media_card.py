"""A document card is attached when the question is clearly about one file.

The prompt asks the model to attach a card whenever a question names a subject
the catalog covers, and in production it almost never did. On 2026-09-10 a
fresh "what is red teaming" on the Eventus bot, with ``Red-Teaming.pdf`` in
context and the corrected prompt loaded, produced a full answer and no card.
The media rule shapes a carded reply as one sentence plus the card; the
response-style rules after it demand full bulleted answers. The model picks the
full answer. ``_topical_media_card`` makes the decision on the server instead.

The catalog below is Eventus's real one, trimmed, because the edge cases that
matter (a sample report sharing two words with the real datasheet, two
platform datasheets that differ by one word, a company name in half the file
names) are the ones that catalog actually has.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.rag_service import _topical_media_card

_U = "https://eventussecurity.com/wp-content/uploads"

_CATALOG = [
    {
        "files": [
            {"url": f"{_U}/2023/07/Datasheet-for-SOC-as-a-Service.pdf", "name": "Datasheet-for-SOC-as-a-Service.pdf"}
        ]
    },
    {"files": [{"url": f"{_U}/2023/07/Red-Teaming.pdf", "name": "Red-Teaming.pdf"}]},
    {"files": [{"url": f"{_U}/2023/09/Penetration-Testing.pdf", "name": "Penetration-Testing.pdf"}]},
    {
        "files": [
            {
                "url": f"{_U}/2024/02/Sample_Web_Application_Penetration_Testing_Report_v1.0.pdf",
                "name": "Sample_Web_Application_Penetration_Testing_Report_v1.0.pdf",
            }
        ]
    },
    {
        "files": [
            {"url": f"{_U}/2025/11/Eventus-SOAR-Platform-Datasheet.pdf", "name": "Eventus-SOAR-Platform-Datasheet.pdf"},
            {"url": f"{_U}/2024/08/Eventus-Platform-V6.3.pdf", "name": "Eventus-Platform-V6.3.pdf"},
            {"url": f"{_U}/2023/10/BAS-As-a-Service-4.pdf", "name": "BAS-As-a-Service-4.pdf"},
            {
                "url": f"{_U}/2024/04/Cyber-Threat-Intelligence-Service-2.pdf",
                "name": "Cyber-Threat-Intelligence-Service-2.pdf",
            },
            {
                "url": f"{_U}/2023/07/Incident-Response-Service-Datasheet.pdf",
                "name": "Incident-Response-Service-Datasheet.pdf",
            },
            {"url": f"{_U}/2025/04/Software-Security-datasheet.pdf", "name": "Software-Security-datasheet.pdf"},
        ]
    },
]
_COMPANY = "Eventus Security"


def _card(question, *, retrieved=None, catalog=_CATALOG, company=_COMPANY):
    return _topical_media_card(question, company, retrieved or [], catalog)


class TestTheQuestionsThatShowedNoCardOnProduction:
    @pytest.mark.parametrize(
        ("question", "expected_name"),
        [
            ("tell me about SOC as a Service", "Datasheet-for-SOC-as-a-Service.pdf"),
            ("what is red teaming", "Red-Teaming.pdf"),
            ("explain penetration testing", "Penetration-Testing.pdf"),
        ],
    )
    def test_the_matching_file_is_attached(self, question, expected_name):
        card = _card(question)
        assert card is not None, question
        assert card["type"] == "download"
        assert card["name"] == expected_name
        assert card["url"].endswith(expected_name)


class TestItPicksTheFileThatIsAboutTheSubject:
    def test_the_datasheet_beats_a_sample_report_that_shares_the_same_two_words(self):
        """Both share "penetration" and "testing". Only one is entirely about
        the subject, and coverage decides the tie."""
        assert _card("explain penetration testing")["name"] == "Penetration-Testing.pdf"

    def test_more_words_in_common_wins(self):
        assert _card("tell me about the eventus soar platform")["name"] == "Eventus-SOAR-Platform-Datasheet.pdf"

    def test_a_retrieved_chunk_wins_a_tie_over_the_bot_wide_catalog(self):
        """Two copies of the SOC datasheet exist on the site. The one that rode in
        with retrieval is the one this answer was actually built from."""
        newer = f"{_U}/2023/10/Datasheet-for-SOC-as-a-Service.pdf"
        retrieved = [
            SimpleNamespace(
                metadata_info={"media_urls": {"files": [{"url": newer, "name": "Datasheet-for-SOC-as-a-Service.pdf"}]}}
            )
        ]
        assert _card("tell me about SOC as a Service", retrieved=retrieved)["url"] == newer


class TestItStaysQuietWhenTheQuestionIsNotAboutAFile:
    @pytest.mark.parametrize(
        "question",
        [
            "what services do you offer",
            "who is the VP of sales",
            "what are your office hours",
            "hi",
            "what does eventus security do",
        ],
    )
    def test_no_card(self, question):
        assert _card(question) is None

    def test_the_company_name_does_not_count_toward_a_match(self):
        """ "eventus" is in half the file names. Left in, "is eventus platform
        secure" would share two words with the platform datasheet on the
        strength of the company name alone."""
        assert _card("is eventus platform secure") is None
        assert _card("is eventus platform secure", company=None) is not None

    @pytest.mark.parametrize("question", ["", None, "   "])
    def test_empty_input_is_safe(self, question):
        assert _card(question) is None

    def test_an_empty_catalog_is_safe(self):
        assert _card("what is red teaming", catalog=[]) is None
        assert _card("what is red teaming", catalog=None) is None


class TestOnlyRealCatalogEntriesBecomeCards:
    def test_an_invalid_file_url_is_never_attached(self):
        junk = [{"files": [{"url": "not-a-url", "name": "Red-Teaming.pdf"}]}]
        assert _card("what is red teaming", catalog=junk) is None

    def test_a_malformed_payload_is_ignored(self):
        assert _card("what is red teaming", catalog=[None, "x", {"files": [None, 7]}, {"youtube": "nope"}]) is None


class TestVideos:
    def test_a_video_is_attached_when_it_is_the_only_match(self):
        videos = [{"youtube": [{"video_id": "Ved27B0ApjM", "title": "What is Red Teaming? A Practical Walkthrough"}]}]
        card = _card("what is red teaming", catalog=videos)
        assert card == {
            "type": "youtube",
            "video_id": "Ved27B0ApjM",
            "title": "What is Red Teaming? A Practical Walkthrough",
        }

    def test_a_file_entirely_about_the_subject_beats_a_longer_video_title(self):
        both = [
            {"youtube": [{"video_id": "Ved27B0ApjM", "title": "What is Red Teaming? A Practical Walkthrough"}]},
            {"files": [{"url": f"{_U}/2023/07/Red-Teaming.pdf", "name": "Red-Teaming.pdf"}]},
        ]
        assert _card("what is red teaming", catalog=both)["type"] == "download"


class TestATieIsDecidedTheSameWayEveryTime:
    """Eventus holds two SOAR documents that are equally about "Eventus Soar Platform".

    Before this, which one a visitor got depended on the order the catalog rows
    arrived in, and the catalog query had no ORDER BY, so the answer could swap
    between two identical questions. Two things were wrong. The company name was
    stripped from the question but not from file titles, so the file Eventus named
    after itself covered less of its own title and lost for a reason nobody chose.
    And a genuine tie had no rule at all.

    Now the company name is noise on both sides, "whitepaper" is a generic document
    word like "datasheet" already was, and a remaining tie goes to the asset's own
    URL. That is a stability rule, not a relevance judgement.
    """

    _DATASHEET = {
        "url": f"{_U}/2025/11/Eventus-SOAR-Platform-Datasheet.pdf",
        "name": "Eventus-SOAR-Platform-Datasheet.pdf",
    }
    _WHITEPAPER = {"url": f"{_U}/2026/01/Whitepaper-SOAR-platform.pdf", "name": "Whitepaper-SOAR-platform.pdf"}

    @pytest.mark.parametrize("whitepaper_first", [False, True])
    def test_the_same_soar_card_whichever_order_the_catalog_arrives_in(self, whitepaper_first):
        files = [self._WHITEPAPER, self._DATASHEET] if whitepaper_first else [self._DATASHEET, self._WHITEPAPER]
        catalog = [{"files": [entry]} for entry in files]

        assert _card("Eventus Soar Platform", catalog=catalog)["name"] == "Eventus-SOAR-Platform-Datasheet.pdf"

    @pytest.mark.parametrize("whitepaper_first", [False, True])
    def test_both_orders_inside_one_payload_agree(self, whitepaper_first):
        files = [self._WHITEPAPER, self._DATASHEET] if whitepaper_first else [self._DATASHEET, self._WHITEPAPER]

        assert (
            _card("Eventus Soar Platform", catalog=[{"files": files}])["name"] == "Eventus-SOAR-Platform-Datasheet.pdf"
        )

    def test_the_tie_break_is_the_url_not_a_preference_for_datasheets(self):
        """Swap which file has the earlier URL and the other one wins. The rule is
        stability, and it does not quietly rank document types."""
        datasheet_late = {**self._DATASHEET, "url": f"{_U}/2027/01/Eventus-SOAR-Platform-Datasheet.pdf"}

        card = _card("Eventus Soar Platform", catalog=[{"files": [datasheet_late, self._WHITEPAPER]}])

        assert card["name"] == "Whitepaper-SOAR-platform.pdf"

    def test_whitepaper_is_a_generic_document_word(self):
        from app.services.rag_service import _title_tokens

        assert _title_tokens("Whitepaper-SOAR-platform.pdf") == {"soar", "platform"}

    def test_a_company_name_in_a_file_title_no_longer_lowers_its_coverage(self):
        """Both reduce to {soar, platform}, so the earlier URL wins. Before the
        change the company-named file covered two of three title words and lost
        to the other file outright, whatever its URL."""
        named = {"url": f"{_U}/a/Eventus-SOAR-Platform.pdf", "name": "Eventus-SOAR-Platform.pdf"}
        plain = {"url": f"{_U}/b/SOAR-Platform-Overview.pdf", "name": "SOAR-Platform-Overview.pdf"}

        assert (
            _card("Eventus Soar Platform", catalog=[{"files": [plain, named]}])["name"] == "Eventus-SOAR-Platform.pdf"
        )

    def test_a_retrieved_asset_still_outranks_the_url_tie_break(self):
        """The URL only settles a true tie. The document this answer was actually
        built from still wins over an equally scored one from the bot-wide catalog."""
        retrieved = [SimpleNamespace(metadata_info={"media_urls": {"files": [self._WHITEPAPER]}})]

        card = _card("Eventus Soar Platform", retrieved=retrieved, catalog=[{"files": [self._DATASHEET]}])

        assert card["name"] == "Whitepaper-SOAR-platform.pdf"

    def test_repeated_calls_agree(self):
        catalog = [{"files": [self._WHITEPAPER, self._DATASHEET]}]

        assert len({_card("Eventus Soar Platform", catalog=catalog)["url"] for _ in range(5)}) == 1
