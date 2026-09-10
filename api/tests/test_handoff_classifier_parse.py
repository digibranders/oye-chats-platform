"""The handoff classifier is asked for the bare word YES or NO.

Models wrap it anyway: ``"YES"`` in quotes, ``**YES**`` in bold, ``yes.`` with a
full stop. The parse is ``startswith("YES")`` on the raw upper-cased reply, so
each of those decorated affirmatives read as NO and a visitor asking for a
person was not offered one. Decoration is stripped before the test; the
``startswith`` itself stays, because "NO, but YES if..." must still be NO.
"""

from __future__ import annotations

import pytest

from app.services import intent_service as svc


def _llm_says(monkeypatch, reply: str) -> None:
    monkeypatch.setattr(svc, "generate_response", lambda *a, **k: reply)


@pytest.mark.parametrize("reply", ['"YES"', "**YES**", " yes.", "`YES`", "'Yes'", "YES\n"])
def test_a_decorated_yes_is_yes(monkeypatch, reply):
    _llm_says(monkeypatch, reply)
    assert svc._detect_handoff_intent_raw("what is the weather today") is True


@pytest.mark.parametrize("reply", ["NO, but YES if they insist", "NO", '"NO"', "**NO**", "", "YESTERDAY was fine"])
def test_anything_else_is_no(monkeypatch, reply):
    _llm_says(monkeypatch, reply)
    assert svc._detect_handoff_intent_raw("what is the weather today") is False
