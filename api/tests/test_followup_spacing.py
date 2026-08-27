"""``_ensure_followup_spacing``: keep a trailing follow-up question on its own
paragraph so the markdown renderer (and the transcript email) never glues it to
the prior sentence.

Covers both shapes:
  * whitespace gap    — "...PPC. Which area?"        (already handled)
  * glued to punctuation — "...fast.What matters?"    (the newly closed gap)
The opener whitelist keeps CamelCase brand names ("CleanSight") from splitting.
"""

from app.services.rag_service import _ensure_followup_spacing as ensure


def test_glued_followup_gets_its_own_paragraph():
    assert (
        ensure("The migration path is designed to be fast.What matters most for your rollout?")
        == "The migration path is designed to be fast.\n\nWhat matters most for your rollout?"
    )


def test_whitespace_gap_case_unchanged():
    assert (
        ensure("We offer SEO and PPC. Which area interests you?")
        == "We offer SEO and PPC.\n\nWhich area interests you?"
    )


def test_already_separated_is_left_alone():
    assert ensure("Already split.\n\nWhat next?") == "Already split.\n\nWhat next?"


def test_non_question_text_untouched():
    assert ensure("It runs on Node.js today.") == "It runs on Node.js today."


def test_brand_name_after_period_is_not_split():
    # "CleanSight" is not a question opener → must not split even though it is a
    # capital word glued to a period and the sentence ends in "?".
    text = "Our images are fast.CleanSight scanning is included?"
    assert ensure(text) == text


def test_empty_and_no_question_pass_through():
    assert ensure("") == ""
    assert ensure("Hello there.") == "Hello there."
