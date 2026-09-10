"""Two regexes answer "is this visitor asking for a human", and they disagreed.

`intent_service._HANDOFF_KEYWORDS_RE` decides whether the widget offers a
handoff. `rag_service._HANDOFF_INTENT_PATTERNS` decides whether the turn is fed
to the qualification extractor. They were written at different times, share no
source, and diverged on nine phrasings.

Seven of those were the harmful direction. "transfer me to support", "escalate
this please", "I need a human" and four others were offered a handoff by one
predicate and handed to the lead extractor by the other, which is precisely
the failure `_should_skip_bant_extraction` documents itself as existing to
prevent: the extractor reads "wants help" as qualified pain, scores Need around
15/25, and the never-downgrade rule makes that permanent. A visitor who asked
for a person becomes a warm lead in the customer's pipeline.

The rule now is one-directional and simple: anything the platform will offer a
human for is not a qualification signal. The reverse does not hold, and should
not: `_HANDOFF_INTENT_PATTERNS` also catches generic help-seeking, which is
worth skipping for the same false-Need reason without being a routing request.
"""

from __future__ import annotations

import pytest

from app.services.intent_service import detect_handoff_intent_keywords
from app.services.rag_service import _should_skip_bant_extraction

#: The seven that used to be scored as leads. Every one of them is a person
#: asking for a person.
DIVERGED = [
    "transfer me to support",
    "escalate this please",
    "I want to email your team",
    "how can I contact support",
    "I need a human",
    "leave a message for the team",
    "reach the support team",
]

#: Phrasings both predicates already agreed on. Here so a fix that widened one
#: side by breaking the other would be caught.
ALREADY_AGREED = [
    "I want to talk to a human please",
    "Please connect me with support",
    "Can I speak with an agent",
    "get me a real person",
]


class TestAskingForAPersonIsNeverALeadSignal:
    @pytest.mark.parametrize("message", DIVERGED + ALREADY_AGREED)
    def test_the_handoff_detector_recognises_it(self, message):
        assert detect_handoff_intent_keywords(message) is True

    @pytest.mark.parametrize("message", DIVERGED + ALREADY_AGREED)
    def test_and_so_extraction_is_skipped(self, message):
        assert _should_skip_bant_extraction(message, {}) is True


class TestARealQuestionStillReachesTheExtractor:
    """The guard on the guard. A filter that skipped everything would pass the
    class above and silently switch qualification off."""

    @pytest.mark.parametrize(
        "message",
        [
            "We have a budget of around 50k for this quarter",
            "I am the head of marketing and we need this live by March",
            "Does the Professional plan include operator seats",
            "how many documents can I upload on the free tier",
        ],
    )
    def test_a_qualifying_message_is_not_skipped(self, message):
        assert detect_handoff_intent_keywords(message) is False
        assert _should_skip_bant_extraction(message, {}) is False


class TestThePipelineDecisionIsTheSkipSignal:
    """The regexes are English. The handoff OFFER is not limited to them: when
    they miss, an LLM classifier decides. Whatever that classifier says the
    platform will act on, so the skip must follow the same decision."""

    def test_a_handoff_the_classifier_found_skips_extraction(self):
        assert _should_skip_bant_extraction("mujhe kisi insaan se baat karni hai", {}, handoff_offered=True) is True

    def test_without_that_signal_the_regexes_still_decide(self):
        assert _should_skip_bant_extraction("mujhe kisi insaan se baat karni hai", {}, handoff_offered=False) is False
