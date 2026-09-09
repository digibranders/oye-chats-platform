"""The assembled prompt has a size ceiling, and it only ever goes down.

Nothing in the suite failed when the prompt grew. Measured on 2026-09-09 before
any consolidation: 7,192 tokens for the simplest possible bot, and 15,233 once
the bot owned any media, because the media rulebook alone was ~32,000
characters. Shrinking that rulebook to its rules took the media case to 8,120.

The ceilings below are a ratchet. Lower them when a change makes the prompt
smaller; raising one is a decision that needs saying out loud in review, because
every token here is attention taken from the grounding rules and paid for on
every single turn of every bot.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.qualification_service import get_framework_config
from app.services.rag_service import build_hybrid_prompt

tiktoken = pytest.importorskip("tiktoken")

_CLIENT = SimpleNamespace(name="Acme")
_CONTEXT = "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"
_MEDIA_CONTEXT = (
    _CONTEXT
    + "\nAVAILABLE MEDIA (pick the ONE whose title best matches):\n  - Downloadable file (guide.pdf): https://acme.com/guide.pdf"
)
_HISTORY = "USER: hi\nBOT: hello"


def _tokens(text: str) -> int:
    return len(tiktoken.get_encoding("o200k_base").encode(text))


def _system_prompt(**kwargs) -> str:
    context = kwargs.pop("context", _CONTEXT)
    system, _user = build_hybrid_prompt(_CLIENT, "what does the company do", context, _HISTORY, **kwargs)
    return system


#: (label, kwargs, ceiling in tokens)
_CONFIGURATIONS = (
    (
        "minimal: no qualification, no human path, no media",
        {"bant_enabled": False, "live_chat_enabled": False, "support_enabled": False},
        7300,
    ),
    (
        "qualification and live chat on",
        {
            "bant_enabled": True,
            "bant_config": get_framework_config(None),
            "live_chat_enabled": True,
            "support_enabled": True,
            "company_name": "Acme",
        },
        7900,
    ),
    (
        "media catalog present",
        {
            "bant_enabled": True,
            "bant_config": get_framework_config(None),
            "live_chat_enabled": True,
            "support_enabled": True,
            "company_name": "Acme",
            "context": _MEDIA_CONTEXT,
        },
        8300,
    ),
    (
        "everything on",
        {
            "bant_enabled": True,
            "bant_config": get_framework_config(None),
            "live_chat_enabled": True,
            "support_enabled": True,
            "company_name": "Acme",
            "meeting_booking_enabled": True,
            "services": [{"name": "Analytics", "url": "https://acme.com/analytics"}],
            "answer_links": [{"keyword": "pricing", "url": "https://acme.com/pricing"}],
            "context": _MEDIA_CONTEXT,
        },
        8800,
    ),
)


@pytest.mark.parametrize("label,kwargs,ceiling", _CONFIGURATIONS, ids=[c[0] for c in _CONFIGURATIONS])
def test_the_prompt_stays_under_its_ceiling(label, kwargs, ceiling):
    size = _tokens(_system_prompt(**kwargs))

    assert size <= ceiling, f"{label}: {size} tokens, ceiling {ceiling}. Lower the ceiling or shrink the prompt."


def test_media_is_what_doubles_the_prompt():
    """Kept as a standing measurement, because it is the argument for bounding
    the media rulebook and for injecting only the media a turn retrieved."""
    base = {
        "bant_enabled": True,
        "bant_config": get_framework_config(None),
        "live_chat_enabled": True,
        "support_enabled": True,
        "company_name": "Acme",
    }
    without = _tokens(_system_prompt(**base))
    with_media = _tokens(_system_prompt(**base, context=_MEDIA_CONTEXT))

    assert with_media > without
    assert with_media - without <= 900, "the media rulebook grew back; it was 8,000 tokens once"
