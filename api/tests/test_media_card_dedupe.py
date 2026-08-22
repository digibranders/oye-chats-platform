"""Media-card per-session dedupe + explicit-request exemption.

Bug report: the same document card was rendered on two consecutive replies
(the bot auto-attached the same PDF turn after turn). Media cards had no
per-session dedupe, unlike the meeting/team/leave cards. These pin:

1. ``_media_card_key`` produces a stable per-card identity.
2. ``_is_explicit_media_request`` recognises a direct ask for the file/video,
   which is exempt from dedupe so an explicit "send me the pdf" is never
   suppressed into dangling "here it is" text with no card.
"""

from app.services.rag_service import _is_explicit_media_request, _media_card_key


class TestMediaCardKey:
    def test_document_card_keyed_by_url(self):
        card = {"type": "download", "url": "https://cdn.x.com/a/cleansight.pdf", "filename": "cleansight.pdf"}
        assert _media_card_key(card) == "media:https://cdn.x.com/a/cleansight.pdf"

    def test_video_card_keyed_by_video_id(self):
        assert _media_card_key({"type": "youtube", "video_id": "abc123"}) == "media:abc123"

    def test_none_card_returns_none(self):
        assert _media_card_key(None) is None

    def test_card_without_stable_id_returns_none(self):
        # No url / video_id / id -> dedupe is skipped (fail-open, never hide a card).
        assert _media_card_key({"type": "download", "filename": "x.pdf"}) is None


class TestIsExplicitMediaRequest:
    def test_pdf_request(self):
        assert _is_explicit_media_request("do you have a pdf about cleansight") is True

    def test_send_the_file(self):
        assert _is_explicit_media_request("can you send me the file") is True

    def test_share_the_document(self):
        assert _is_explicit_media_request("please share the document") is True

    def test_video_walkthrough_request(self):
        assert _is_explicit_media_request("is there a walkthrough video?") is True

    def test_plain_topical_question_is_not_a_request(self):
        assert _is_explicit_media_request("how does cleansight detect outdated images") is False

    def test_empty_is_not_a_request(self):
        assert _is_explicit_media_request("") is False
        assert _is_explicit_media_request(None) is False
