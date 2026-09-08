"""A judge-prompt change must not keep serving verdicts from the old prompt.

Gate scores are cached in Redis for an hour under a (bot, question) key. The
prompt is part of what produced the score but was not part of the key, so a
prompt fix would have been shadowed by its own stale cache for up to an hour
after deploy, and any before/after measurement of that fix would have read its
own baseline back.
"""

from app.services import relevance_gate
from app.services.relevance_gate import _gate_cache_key


def test_key_carries_the_prompt_version():
    key = _gate_cache_key(8, None, "what do you charge")

    assert key.startswith(f"oyechats:gate:v{relevance_gate._GATE_PROMPT_VERSION}:b8:")


def test_bumping_the_version_invalidates_existing_entries(monkeypatch):
    before = _gate_cache_key(8, None, "what do you charge")
    monkeypatch.setattr(relevance_gate, "_GATE_PROMPT_VERSION", relevance_gate._GATE_PROMPT_VERSION + 1)

    assert _gate_cache_key(8, None, "what do you charge") != before


def test_question_normalisation_survives_versioning():
    assert _gate_cache_key(8, None, "What Do You Charge ") == _gate_cache_key(8, None, "what do you charge")
