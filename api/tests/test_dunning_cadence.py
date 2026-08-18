"""Which dunning email is due, given days elapsed in past_due.

Day 0 is deliberately calm: Razorpay retries the charge on its own for roughly
3 days and most of these self-resolve without the customer doing anything.
Urgency starts at day 3, when retries are genuinely exhausted.

The cadence CATCHES UP to the newest unsent bucket rather than matching an
exact day. Exact matching silently dropped an email forever whenever a tick was
missed, and not only on a worker outage: any tick where the gateway lookup
failed left the marker unwritten and burned that bucket. Losing day 5 means a
customer is suspended having received only "don't worry, we'll retry".
"""

import pytest

from app.services.dunning_service import DUNNING_CADENCE, SUSPENDED_MARKER, due_email

_ALL_SENT = {"failed_0": "t", "halted_3": "t", "warning_5": "t"}


@pytest.mark.parametrize(
    "days,expected",
    [(0, "failed_0"), (1, "failed_0"), (2, "failed_0"), (3, "halted_3"), (4, "halted_3"), (5, "warning_5")],
)
def test_newest_due_bucket_wins_when_nothing_has_been_sent(days, expected):
    assert due_email(days, sent={}) == expected


@pytest.mark.parametrize("days,expected", [(0, None), (1, None), (3, "halted_3"), (4, "halted_3")])
def test_day_zero_sent_then_nothing_until_day_three(days, expected):
    assert due_email(days, sent={"failed_0": "t"}) == expected


def test_a_missed_day_three_tick_is_caught_up_on_day_four():
    """The whole point of catch-up: the recovery-link email is not lost."""
    assert due_email(4, sent={"failed_0": "t"}) == "halted_3"


def test_a_missed_day_three_is_superseded_not_duplicated_on_day_five():
    """Anti-spam intent preserved: day 5 supersedes an unsent day 3 rather than
    both landing together and contradicting each other."""
    assert due_email(5, sent={"failed_0": "t"}) == "warning_5"


def test_an_older_marker_is_never_sent_after_a_newer_one():
    assert due_email(5, sent={"warning_5": "t"}) is None
    assert due_email(6, sent={"warning_5": "t"}) is None


def test_everything_sent_is_silent():
    for days in range(0, 8):
        assert due_email(days, sent=_ALL_SENT) is None


def test_days_beyond_the_cadence_still_deliver_the_last_unsent_warning():
    """Day 6 is the customer's last full day before the day-7 expiry cron. If
    the day-5 email never went out, it must still land."""
    assert due_email(6, sent={"failed_0": "t", "halted_3": "t"}) == "warning_5"


def test_negative_days_send_nothing():
    """Clock skew or a future-stamped anchor must not fire day 0."""
    assert due_email(-1, sent={}) is None


def test_fractional_days_resolve_to_the_bucket_below():
    """The natural caller computation (total_seconds()/86400) is fractional; an
    exact int lookup would have silently matched nothing and sent no email."""
    assert due_email(3.4, sent={"failed_0": "t"}) == "halted_3"
    assert due_email(2.9, sent={"failed_0": "t"}) is None


def test_none_sent_map_is_treated_as_empty():
    """A freshly-migrated row can carry NULL/None before the default lands."""
    assert due_email(0, sent=None) == "failed_0"


def test_marker_presence_not_truthiness_decides_sent():
    """An empty-string timestamp still means the email went out; re-sending on
    a falsy value would double-mail the customer."""
    assert due_email(0, sent={"failed_0": ""}) is None


def test_cadence_stays_inside_the_grace_window():
    """Every cadence day must land before PAYMENT_FAILED_GRACE_DAYS, or we would
    email a deadline that has already passed."""
    from app.config import PAYMENT_FAILED_GRACE_DAYS

    assert max(DUNNING_CADENCE) < PAYMENT_FAILED_GRACE_DAYS


def test_suspended_marker_is_not_part_of_the_cadence():
    """It is written by the expiry cron, so the cadence must never claim it."""
    assert SUSPENDED_MARKER not in DUNNING_CADENCE.values()


def test_cadence_is_immutable():
    """It decides when customers are told their service is ending; a caller or
    a stray test must not be able to reshape it process-wide."""
    with pytest.raises(TypeError):
        DUNNING_CADENCE[6] = "x"  # type: ignore[index]
