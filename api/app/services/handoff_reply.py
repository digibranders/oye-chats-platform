"""Fixed wording for the turn a visitor asks for a person.

The pipeline decides a handoff before generation (``suggest_handoff``), and the
widget opens its "Talk to a human" form from that flag. The words used to be
left to the model. On 2026-09-10 a live bot answered "connect me" with "I'll
open a quick message form for you", copied from the leave-a-message example in
the prompt, above the "Talk to a human" form, then "I'll open the message form
now." when the visitor asked again.

The reply has one job: say what the form below is for and what happens after it.
"""

from __future__ import annotations

from dataclasses import dataclass


def handoff_reply(*, team_available: bool, repeat: bool) -> str:
    """The reply shown above the handoff form.

    ``team_available`` is whether anyone can take the chat now (inside business
    hours and someone reachable). When nobody is, the words promise to tell the
    team rather than a connection now, and never call the team offline: after the
    form, ``POST /operators/handoff`` queues the visitor and pushes the team when
    an operator can be reached on a phone or another tab, and shows the message
    form only when nobody can.

    ``repeat`` is True when this conversation was already offered the form. The
    widget re-opens it if the visitor closed it, so on a repeat the form is below
    again, and the reply points at it instead of announcing it a second time.
    """
    if repeat:
        if team_available:
            return "The form is just below. Share your details there and I'll connect you with our team."
        return "The form is just below. Share your details there and our team will get back to you."
    if team_available:
        return "Sure. Share your details in the form below and I'll connect you with our team."
    return "Sure. Share your details in the form below and I'll let our team know you're waiting."


@dataclass(frozen=True)
class HandoffOffer:
    """A fixed reply that hands the visitor to the team, and how the widget opens it."""

    text: str
    suggest_handoff: bool
    needs_message_card: bool


def unhelped_offer(*, live_chat_enabled: bool, team_available: bool) -> HandoffOffer:
    """The reply after two turns in a row the bot could not help with.

    On 2026-09-10 a visitor asked a live bot four times to buy the company and
    got a refusal or a model-written brush-off every time, never the team. This
    says plainly that the bot could not help, then offers the channel the plan
    has: the live form when live chat is on (worded for nobody being available
    when that is the case, without calling the team offline), the message card
    when it is off. Only called on a plan that includes human support.
    """
    if not live_chat_enabled:
        return HandoffOffer(
            text="I haven't been able to help with that here. I'll open a quick message form so our team can get back to you.",
            suggest_handoff=False,
            needs_message_card=True,
        )
    if team_available:
        return HandoffOffer(
            text=(
                "I haven't been able to help with that here, but our team can. "
                "Share your details in the form below and I'll connect you with them."
            ),
            suggest_handoff=True,
            needs_message_card=False,
        )
    return HandoffOffer(
        text=(
            "I haven't been able to help with that here, but our team can. "
            "Share your details in the form below and I'll let them know you're waiting."
        ),
        suggest_handoff=True,
        needs_message_card=False,
    )
