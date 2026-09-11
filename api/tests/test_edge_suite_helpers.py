"""The evaluation suite's pure helpers: what the visitor sees, and what is grounded."""

import pytest

from eval.edge_suite import edge_eval as e


def test_widget_sentinels_are_stripped_and_brackets_kept():
    assert e.strip_sentinels("Follow up soon.[LEAVE_MESSAGE_CARD]") == "Follow up soon."
    assert e.strip_sentinels("See [1] and [DOWNLOAD_CARD:https://x.com/a.pdf|a.pdf]") == "See [1] and"


def test_strip_sentinels_removes_a_meeting_card_token():
    assert e.strip_sentinels("Happy to set that up.[MEETING_CARD]") == "Happy to set that up."


def test_strip_sentinels_removes_a_youtube_card_token():
    assert (
        e.strip_sentinels("Watch this [YOUTUBE_CARD:dQw4w9WgXcQ] for a walkthrough.")
        == "Watch this  for a walkthrough."
    )


def test_strip_sentinels_removes_cta_tokens():
    assert e.strip_sentinels("Sure, happy to help![CTA:book_demo]") == "Sure, happy to help!"
    assert e.strip_sentinels("Want a demo?[CTA_Q:Would you like to book a demo?]") == "Want a demo?"


def test_grounding_splits_claims_by_the_knowledge_base(monkeypatch):
    monkeypatch.setitem(e._KB_TEXT, 99, "our ceo is maya rao and plans start at ₹12,500 per month")
    row = {"bot_id": 99, "company": "Acme", "final_answer": "Our CEO is Maya Rao. Plans start at ₹12,500 and ₹99,999."}
    found, missing = e.grounding(row)
    assert "Maya Rao" in found and "₹12,500" in found
    assert "₹99,999" in missing


def test_a_booking_card_satisfies_an_expected_handoff():
    row = {"expect_handoff": True, "handoff_shown": False, "booking_card": True, "transcript": [], "final_answer": ""}
    assert "expected a handoff/form, none shown" not in e.auto_checks(row)


def test_bots_load_from_a_file(tmp_path):
    path = tmp_path / "bots.json"
    path.write_text(
        '[{"id": 8, "key": "bot-x", "name": "Acme", "origin": "https://a.test", "company": "Acme", "short": "acme", "product": "consulting", "config": "test"}]'
    )
    bots = e.load_bots(path)
    assert bots[0]["key"] == "bot-x"


def test_load_bots_raises_on_a_missing_field(tmp_path):
    path = tmp_path / "bots.json"
    path.write_text(
        '[{"id": 8, "key": "bot-x", "name": "Acme", "origin": "https://a.test", "company": "Acme", "short": "acme", "product": "consulting"}]'
    )
    with pytest.raises(ValueError, match="config"):
        e.load_bots(path)


def test_judge_stops_before_any_call_without_a_provider_key(monkeypatch):
    import app.config as config

    monkeypatch.setattr(config, "GOOGLE_API_KEY", None)
    with pytest.raises(SystemExit):
        e.cmd_judge()


def test_a_bare_only_flag_is_rejected_instead_of_running_every_bot():
    with pytest.raises(SystemExit):
        e.build_parser().parse_args(["run", "--only"])


def test_only_with_ids_parses_to_a_list():
    args = e.build_parser().parse_args(["run", "--only", "8"])
    assert args.only == [8]


def test_no_only_flag_means_every_bot():
    args = e.build_parser().parse_args(["run"])
    assert args.only is None
