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


class TestAPromptChangeCannotShipWithoutAVersionBump:
    """The miss this exists for.

    159fc1e2 restored the media-card rule and did not bump ``QA_PROMPT_VERSION``.
    On 2026-09-10, after that deploy, two of three topical questions on a live bot
    were served hour-old answers written under the previous rule, and a correct fix
    looked broken on production when it was merely cached.

    The assembled system prompt is fingerprinted for one canonical configuration.
    Change the prompt and the fingerprint changes; this then fails until the version
    is bumped and the new fingerprint recorded under it. That friction is the point:
    it turns "remember to bump the cache version" into something a test asks for.

    The date is frozen because the system prompt carries TODAY'S DATE. The recorded
    fingerprint was confirmed identical with and without ``api/.env`` loaded, so it
    holds in CI as well as locally.
    """

    #: ``QA_PROMPT_VERSION`` -> sha256 of the canonical system prompt at that version.
    #: When this fails, bump ``QA_PROMPT_VERSION`` in ``app/core/cache.py`` and add the
    #: new fingerprint under the new number. Do not overwrite an existing entry.
    FINGERPRINTS = {
        3: "777485cd41cd66f55ca5c5c5f9bba8d7bad0a1c99c4c7289b274065de1d7a68b",
        4: "c56da7549a2bf7c499422009acf9c483fa5656f9e7f7a25de0870c0f5eccb453",
    }

    @staticmethod
    def _fingerprint(monkeypatch) -> str:
        import datetime as _dt
        import hashlib
        from types import SimpleNamespace

        from app.services import rag_service as rs
        from app.services.qualification_service import get_framework_config

        class _FrozenDate(_dt.date):
            @classmethod
            def today(cls):
                return cls(2026, 1, 1)

        monkeypatch.setattr(rs, "date", _FrozenDate)
        context = (
            "<<<DOCUMENT 1 | about.md>>>\nAcme builds analytics tooling.\n<<<END DOCUMENT 1>>>\n"
            "\nAVAILABLE MEDIA (pick the ONE whose title best matches):\n"
            "  - Downloadable file (guide.pdf): https://acme.com/guide.pdf"
        )
        system, _user = rs.build_hybrid_prompt(
            SimpleNamespace(name="Acme"),
            "what does the company do",
            context,
            "USER: hi\nBOT: hello",
            bant_enabled=True,
            bant_config=get_framework_config(None),
            live_chat_enabled=True,
            support_enabled=True,
            company_name="Acme",
        )
        return hashlib.sha256(system.encode()).hexdigest()

    def test_the_prompt_matches_the_fingerprint_recorded_for_this_version(self, monkeypatch):
        fingerprint = self._fingerprint(monkeypatch)
        expected = self.FINGERPRINTS.get(cache.QA_PROMPT_VERSION)

        assert expected is not None, (
            f"No fingerprint recorded for QA_PROMPT_VERSION={cache.QA_PROMPT_VERSION}. "
            f"Add {cache.QA_PROMPT_VERSION}: {fingerprint!r} to FINGERPRINTS."
        )
        assert fingerprint == expected, (
            "The assembled system prompt changed. Bump QA_PROMPT_VERSION in app/core/cache.py and "
            f"record {fingerprint!r} under the new version, or answers written under the old prompt "
            "keep being served for up to an hour after the deploy."
        )

    def test_the_latest_recorded_version_is_the_live_one(self):
        """A bump without a recorded fingerprint, or a fingerprint recorded under a
        version nobody bumped to, both fail here."""
        assert max(self.FINGERPRINTS) == cache.QA_PROMPT_VERSION
