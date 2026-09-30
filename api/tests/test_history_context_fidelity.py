"""The bot's previous reply reaches the answer model intact.

Production, Eventus, 2026-09-28 (case y-e04-last-one): the bot listed 21
services, ``_build_history_context`` cut that reply to 500 characters, ending
"- **Penetration T [truncated]", and on "tell me about the last one" the model
took Penetration Testing as the last item. The query rewrite, which reads the
untruncated rows, had resolved it correctly. The same cut made
w-recap-for-boss rebuild the service list from retrieved press releases and add
services the bot never mentioned.

The bot's own replies now keep a much larger cap than the visitor's messages
(a pasted wall of text is still bounded), a message that has to be cut is cut
at a line boundary so no item is ever left half-written, and the history opens
with one line saying what "[truncated]" means.
"""

from types import SimpleNamespace

import pytest

from app.db.repository import add_chat_message
from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _stub_pipeline,
)

_SERVICES = [
    "Managed SOC",
    "Managed Detection and Response",
    "Threat Intelligence",
    "Vulnerability Management",
    "Incident Response",
    "Digital Forensics",
    "Red Teaming",
    "Cloud Security",
    "Application Security",
    "Network Security",
    "Endpoint Security",
    "Email Security",
    "Identity and Access Management",
    "Security Awareness Training",
    "Compliance Advisory",
    "Risk Assessment",
    "Security Architecture Review",
    "Third-Party Risk Management",
    "Data Loss Prevention",
    "VAPT",
    "Penetration Testing",
]

_LIST_REPLY = "**Eventus** offers these services:\n" + "\n".join(
    f"- **{name}**: {name.lower()} delivered by our certified team" for name in _SERVICES
)


def _user(content: str):
    return SimpleNamespace(role="user", content=content)


def _bot(content: str):
    return SimpleNamespace(role="bot", content=content)


class TestReplyKeptIntact:
    def test_a_21_item_list_survives_into_history_verbatim(self):
        assert len(_LIST_REPLY) > 500, "the fixture must exceed the old 500-character cap"

        out = rs._build_history_context([_user("what services do you offer"), _bot(_LIST_REPLY)])

        assert _LIST_REPLY in out
        assert "[truncated]" not in out
        assert out.endswith("- **Penetration Testing**: penetration testing delivered by our certified team")

    def test_the_reply_cap_is_sized_in_the_thousands(self):
        assert rs._HISTORY_REPLY_MAX_CHARS >= 2000
        assert rs._HISTORY_REPLY_MAX_CHARS > rs._HISTORY_MESSAGE_MAX_CHARS

    def test_a_visitor_wall_of_text_is_still_bounded(self):
        pasted = "lorem ipsum dolor sit amet " * 400
        out = rs._build_history_context([_user(pasted)])

        assert len(out) < len(pasted)
        assert out.endswith("[truncated]")


class TestCutAtLineBoundary:
    def _long_reply(self) -> tuple[str, list[str]]:
        items = [f"- **Item {i:03d}**: " + ("detail " * 12).strip() for i in range(1, 200)]
        return "Here is everything:\n" + "\n".join(items), items

    def test_an_overlong_reply_is_cut_between_items_never_inside_one(self):
        reply, items = self._long_reply()
        assert len(reply) > rs._HISTORY_REPLY_MAX_CHARS

        out = rs._build_history_context([_bot(reply)])
        body = out.split("bot: ", 1)[1]
        kept, marker = body.rsplit(" [truncated]", 1)

        assert marker == ""
        kept_lines = kept.split("\n")
        assert kept_lines[0] == "Here is everything:"
        for line in kept_lines[1:]:
            assert line in items, f"a partial item leaked into history: {line!r}"
        assert len(kept) <= rs._HISTORY_REPLY_MAX_CHARS

    def test_the_header_line_explains_the_marker_only_when_something_was_cut(self):
        reply, _items = self._long_reply()

        cut = rs._build_history_context([_user("list everything"), _bot(reply)])
        whole = rs._build_history_context([_user("hi"), _bot("hello")])

        assert cut.startswith(rs._HISTORY_TRUNCATION_NOTE)
        assert "[truncated]" in rs._HISTORY_TRUNCATION_NOTE
        assert "continued" in rs._HISTORY_TRUNCATION_NOTE
        assert rs._HISTORY_TRUNCATION_NOTE not in whole
        assert whole == "user: hi\nbot: hello"

    def test_a_single_unbroken_line_falls_back_to_a_hard_cut(self):
        reply = "x" * (rs._HISTORY_REPLY_MAX_CHARS + 500)
        out = rs._build_history_context([_bot(reply)])
        assert ("bot: " + "x" * rs._HISTORY_REPLY_MAX_CHARS + " [truncated]") in out


class TestLastOneFollowUp:
    """The y-e04 shape end to end: the list, then "the last one"."""

    @pytest.mark.asyncio
    async def test_generation_sees_the_whole_list(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-f21-last-one")
        add_chat_message(
            db,
            "sess-f21-last-one",
            client_id=client.id,
            role="user",
            content="what services do you offer",
            bot_id=bot.id,
        )
        add_chat_message(db, "sess-f21-last-one", client_id=client.id, role="bot", content=_LIST_REPLY, bot_id=bot.id)
        db.commit()
        cap = _stub_pipeline(
            monkeypatch,
            retrieved=(_doc("Penetration Testing simulates a real attack against your systems."),),
            chunks=("Penetration Testing simulates a real attack.",),
        )

        await _drive_stream(bot, "tell me about the last one", "sess-f21-last-one")

        assert len(cap["prompts"]) == 1
        _system, user_prompt = cap["prompts"][0]
        for name in _SERVICES:
            assert f"- **{name}**" in user_prompt, f"{name} was cut from the generation input"
        assert "[truncated]" not in user_prompt
