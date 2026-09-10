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


def handoff_reply(*, team_available: bool, repeat: bool) -> str:
    """The reply shown above the handoff form.

    ``team_available`` is whether anyone can take the chat now (inside business
    hours and someone reachable). When nobody is, the widget still opens the form
    and then falls back to the offline message flow, so the words promise a reply
    later rather than a connection now.

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
    return "Our team is offline right now. Share your details in the form below and they'll get back to you."
