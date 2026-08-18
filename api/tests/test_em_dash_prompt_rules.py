"""The prompts that BAN the em-dash have to contain one.

A repo-wide sweep to remove em-dashes from prose rewrote these rules into
nonsense: "Do NOT use the em-dash character (-) ... use a plain hyphen (-)
instead" bans and prescribes the same character, and the worked ✗ example
stopped demonstrating anything. The widget had the same failure in the other
direction, where the runtime matcher ``/\\s*\\u2014\\s*/`` was widened to a plain
hyphen and started eating markdown bullets.

These are the few places where the character is data, not prose. Anything that
strips em-dashes repo-wide must leave them alone, and this fails loudly if it
does not.
"""

from __future__ import annotations

from pathlib import Path

EM_DASH = "—"


def test_response_style_rule_names_the_character_it_bans() -> None:
    from app.services.response_style import RESPONSE_STYLE_BLOCK

    assert "Do not use the em-dash character" in RESPONSE_STYLE_BLOCK
    assert f"em-dash character ({EM_DASH})" in RESPONSE_STYLE_BLOCK, (
        "the rule must name the character literally, or it reads as 'do not use (-), use (-) instead'"
    )


def test_response_style_shows_a_bad_example_containing_an_em_dash() -> None:
    """The ✗ line demonstrates the mistake; without the character it demonstrates nothing."""
    from app.services.response_style import RESPONSE_STYLE_BLOCK

    bad_examples = [line for line in RESPONSE_STYLE_BLOCK.splitlines() if line.strip().startswith("✗")]
    assert bad_examples, "the em-dash rule lost its worked counter-example"
    assert any(EM_DASH in line for line in bad_examples)


def test_system_prompt_punctuation_rule_names_the_character() -> None:
    from app.services import rag_service

    source = Path(rag_service.__file__).read_text(encoding="utf-8")
    assert f"Do NOT use the em-dash character ({EM_DASH})" in source


def test_no_prompt_tells_the_model_to_use_em_dash_separators() -> None:
    """Rule 11 bans the character, so no other instruction may ask for it.

    A formatting rule used to ask for "a short em-dash-separated inline",
    directly contradicting the ban a few rules later.
    """
    from app.services import rag_service

    source = Path(rag_service.__file__).read_text(encoding="utf-8")
    assert "em-dash-separated" not in source
