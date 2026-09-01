"""A lead has to say which chatbot produced it.

Leads, Inbox and Journey are workspace-level surfaces: they show every chatbot's
data together. `build_lead_response` emitted no chatbot field at all, so in an
account with more than one chatbot a lead row was unattributable -- you could
neither filter to a chatbot nor tell, looking at a row, where it came from.

Only Enterprise (and an `extra_bot_seats` purchase) can have more than one
chatbot, so this is invisible to most accounts. That is exactly why it survived:
nothing in the common path exercises it.

`bot_name` is denormalised into the row deliberately. The alternative is the
dashboard joining ids against its own chatbot list, which breaks for a lead
whose chatbot has since been deleted -- the row would render "Chatbot 7" or
blank, for a conversation that really did happen.
"""

from __future__ import annotations

from app.db.models import Bot, ChatSession
from app.services.lead_service import build_lead_response


def _session(bot_id: int = 7) -> ChatSession:
    """A real (unsaved) model, not a namespace.

    An ad-hoc stand-in drifts: it only carries the attributes the function
    happened to read on the day it was written, and this payload builder reads
    a couple of dozen. Instantiating the model gives every column its declared
    default and fails honestly if one is added.
    """
    return ChatSession(id=f"sess-{bot_id}", bot_id=bot_id, status="closed")


def _bot(bot_id: int = 7, name: str = "Support") -> Bot:
    return Bot(id=bot_id, name=name, bot_key=f"bot-{bot_id}")


def test_the_payload_names_the_chatbot():
    payload = build_lead_response(_session(), None, bot=_bot())
    assert payload["bot_id"] == 7
    assert payload["bot_name"] == "Support"


def test_it_survives_a_caller_that_passes_no_bot():
    # Several call sites resolve the bot from a map and can miss. The id still
    # comes off the session, which is the authoritative link.
    payload = build_lead_response(_session(bot_id=9), None, bot=None)
    assert payload["bot_id"] == 9
    assert payload["bot_name"] is None


def test_an_unnamed_chatbot_reports_no_name_rather_than_an_empty_string():
    # So the dashboard can fall back to "Chatbot 7" on a real absence instead of
    # rendering a blank cell.
    payload = build_lead_response(_session(), None, bot=_bot(name=""))
    assert payload["bot_name"] is None


def test_the_id_comes_from_the_session_not_the_bot_argument():
    # The session is the record of what actually happened. A mismatched `bot`
    # argument is a caller bug and must not silently relabel the lead.
    payload = build_lead_response(_session(bot_id=7), None, bot=_bot(bot_id=99, name="Other"))
    assert payload["bot_id"] == 7
