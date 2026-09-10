"""A cached answer written under the previous prompt must not outlive a deploy.

``qa_response_key`` was ``bot:lang:question_hash`` with a one-hour TTL, so for
up to an hour after a prompt-library change every cached FAQ answer was the old
prompt's answer. The gate cache already carries a prompt version in its key;
the QA cache now does too.
"""

from __future__ import annotations

from app.core import cache


class TestTheKeyCarriesThePromptVersion:
    def test_the_version_segment_is_in_the_key(self):
        key = cache.qa_response_key(7, "hash")

        assert f":v{cache.QA_PROMPT_VERSION}:" in key
        assert key.endswith(":hash")

    def test_a_bump_changes_every_key(self, monkeypatch):
        before = cache.qa_response_key(7, "hash", "hi")
        monkeypatch.setattr(cache, "QA_PROMPT_VERSION", cache.QA_PROMPT_VERSION + 1)

        assert cache.qa_response_key(7, "hash", "hi") != before

    def test_the_version_is_at_least_two(self):
        """1 is the implicit version of every key written before the segment
        existed; 2 is the first deploy that invalidates them."""
        assert isinstance(cache.QA_PROMPT_VERSION, int)
        assert cache.QA_PROMPT_VERSION >= 2

    def test_language_still_partitions(self):
        assert cache.qa_response_key(7, "hash", "hi") != cache.qa_response_key(7, "hash", "es")
        assert cache.qa_response_key(7, "hash", "hi") != cache.qa_response_key(7, "hash")


class TestTheBotPrefixStillReachesRealKeys:
    """The gate prefix once silently stopped matching real keys after a version
    segment was added to the key and not to the prefix. Pin the QA pair."""

    def test_with_and_without_a_language(self):
        prefix = cache.qa_prefix_for_bot(7)

        assert cache.qa_response_key(7, "hash").startswith(prefix)
        assert cache.qa_response_key(7, "hash", "hi").startswith(prefix)

    def test_the_prefix_does_not_bleed_into_another_bot(self):
        assert not cache.qa_response_key(71, "hash").startswith(cache.qa_prefix_for_bot(7))
