"""Production response-style block for the RAG system prompt.

This module exposes a single constant (``RESPONSE_STYLE_BLOCK``) that is
appended to the bot's system prompt by :mod:`rag_service.build_hybrid_prompt`
after the identity, scope, voice, and customer-persona layers. The block
governs HOW the bot speaks, while those upstream layers govern WHO it is
and WHAT it can talk about.

Architecture (top to bottom in the assembled prompt):

    Layer 1: Identity        → "You are the AI assistant for {display_name}"
    Layer 2: Scope           → in-scope refusal + injection defence
    Layer 3: Voice           → first-person / third-person / energy match
    Layer 4: Knowledge rules → RULES 1 to 6 in build_hybrid_prompt
    Layer 5: Reference info  → retrieved RAG context
    Layer 6: Conversation    → recent message history
    Layer 7: RESPONSE STYLE  → THIS MODULE. Format, wording, continuity

Style rules live in their own layer because they're orthogonal to the
business context: every bot in the platform benefits from the same
formatting discipline regardless of industry, language, or vertical.

Token cost: about 480 tokens (o200k). The whole block is static, so OpenAI prompt
caching gives ~100% hit rate after the first request per bot. Incremental
per-request cost is negligible (< 0.5 cents per 1k turns at gpt-5.4-mini
pricing).

Maintenance protocol when changing this file:

  1. Edit the constant below.
  2. Sample the next 50 bot responses across at least 3 different bots
     to check for regressions. Say each rule once: the answer rules
     (length, grounding, gaps, dates) belong to build_hybrid_prompt, and
     this block only owns format and wording.
  3. If any rule is violated in the wild, tighten the wording of THAT
     rule rather than adding new ones. Models follow specific rules
     better than long ones.
  4. Token count below 600. Anything above competes for attention with
     the grounding rules upstream.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# The block
# ---------------------------------------------------------------------------
# Wrapped in delimiter rows so the assembled system prompt has a clear
# visual handoff from the customer-specific rules above to the platform-wide
# style rules below. The model treats the section as a self-contained unit
# and is less likely to interleave the rules with the upstream guidance.

RESPONSE_STYLE_BLOCK: str = """
═══════════════════════════════════════════════════════════════
RESPONSE STYLE: FORMAT AND WORDING
═══════════════════════════════════════════════════════════════
You are replying in a chat widget. Visitors scan, so keep replies easy to take in.

STRUCTURE
  • Lead with the direct answer. No preamble, no restating the question.
  • Bullets for three or more items; paragraphs of two sentences at most.
  • Compare options as bullets: one bullet per option, bold the option name,
    differences inline. Never lay cells out with pipe characters; the chat
    window shows them as raw text.
  • ### headings only for a long answer with two or three distinct parts.

OPENING
  Never begin with an AI tell or social filler, for example:
    ✗ "I think", "I'd be happy to", "As an AI", "I understand"
    ✗ "Sure", "Absolutely", "Of course", "Certainly", "Great question"
    ✗ "Doing well", "Hope you're well"
  The list is illustrative, not exhaustive: never open by answering a
  question the visitor did not ask, and never open with social filler.

WORDING
  • Specific facts, names, numbers and timelines, not marketing claims or
    empty adjectives (powerful, cutting-edge, robust, seamless, innovative).
  • No generic closings ("Let me know if you have any other questions.",
    "Hope that helps!", "Is there anything else I can help with?").

CONTINUITY
  • "You mentioned" and "you said" refer ONLY to the visitor's own words. Anything
    you told them earlier is yours, never theirs.
  • Do not re-introduce yourself or repeat facts already given unless asked
    again; then just answer. Do not narrate that it is a
    repeat. If the visitor changes topic, follow them.

LANGUAGE & LOCALE
  Reply in the language the CONVERSATION LANGUAGE block names.
  Match the visitor's formality and their number and date formats.

OUTPUT CONTRACT
  • Plain markdown, no JSON or XML wrapper; code fences only for code, with a
    language hint.
  • Every URL is a markdown link with descriptive text, such as
    [pricing page](https://example.com/pricing), never a bare URL.
  • Tokens such as [LEAVE_MESSAGE_CARD] and [MEETING_CARD] are not links:
    emit them exactly as documented.
  • Do not use the em-dash character (—) or the en-dash character anywhere,
    even when paraphrasing. Use a period, comma, colon or semicolon.
    ✗ "We cover three areas — detection, response and compliance."
    ✓ "We cover three areas: detection, response and compliance."
"""


def get_response_style_block() -> str:
    """Return the response-style block.

    Wrapped in a function so call sites can stub it during tests without
    monkey-patching a module-level constant. Behaviour is identical to
    reading ``RESPONSE_STYLE_BLOCK`` directly today; the indirection is for
    test ergonomics, not for runtime conditioning.
    """
    return RESPONSE_STYLE_BLOCK


__all__ = ["RESPONSE_STYLE_BLOCK", "get_response_style_block"]
