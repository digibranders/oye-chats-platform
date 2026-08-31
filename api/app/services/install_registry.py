"""Reads and writes for ``bot_domain_installs``.

Both producers funnel through here so the two rules that keep this table from
becoming a liability live in one place: every write is an upsert on
``(bot_id, hostname)``, and the number of rows one chatbot can accumulate is
capped.

The cap is not tidiness. The passive producer's hostname comes from the
``Origin`` header on ``GET /bots/settings/public``, an unauthenticated endpoint
whose bot key is public by design, so the hostname is attacker-supplied. Without
a ceiling, a loop of forged origins would write a row per accepted heartbeat
forever. With one, the worst case is a bounded set of junk rows that a support
engineer can recognise and clear.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.sql import func

from app.db.models import BotDomainInstall

logger = logging.getLogger(__name__)

# Most domains one chatbot may accumulate from OBSERVATION. Generous for a real
# customer — a franchise with a site per location is the widest honest case —
# and low enough that a forged-origin loop cannot grow the table without bound.
# The probe is not subject to it: those hostnames come from the account's own
# ``allowed_domains``, which is already capped at 50 by the API.
MAX_OBSERVED_DOMAINS_PER_BOT = 100


def record_observed_domain(session, bot_id: int, hostname: str) -> None:
    """Note that the widget bootstrapped from ``hostname``.

    Called only when the per-bot heartbeat throttle has already decided a write
    is due, which is what bounds this to 2/hour/bot. The throttle is
    deliberately NOT re-keyed on the hostname here: doing so would let one
    forged ``Origin`` per request buy its own throttle slot, which is the exact
    bypass ``_widget_heartbeat_key`` documents at length. The cost is that a
    chatbot newly added to a second domain is recorded within the hour rather
    than within the page load, which is the right trade for a dashboard.
    """
    if not hostname:
        return

    existing = session.execute(
        select(func.count()).select_from(BotDomainInstall).where(BotDomainInstall.bot_id == bot_id)
    ).scalar_one()

    if existing >= MAX_OBSERVED_DOMAINS_PER_BOT:
        # At the ceiling, still refresh a domain we already know: a customer
        # who genuinely has 100 sites must not have the hundred-and-first
        # forged origin freeze the liveness of the hundred real ones.
        session.execute(
            BotDomainInstall.__table__.update()
            .where(
                BotDomainInstall.bot_id == bot_id,
                BotDomainInstall.hostname == hostname,
            )
            .values(observed_last_at=func.now())
        )
        return

    session.execute(
        pg_insert(BotDomainInstall)
        .values(
            bot_id=bot_id,
            hostname=hostname,
            observed_first_at=func.now(),
            observed_last_at=func.now(),
        )
        .on_conflict_do_update(
            constraint="uq_bot_domain_install",
            # `observed_first_at` is absent on purpose: it is a first-seen
            # stamp, and an upsert that refreshed it would turn the whole
            # column into a duplicate of `observed_last_at`.
            set_={"observed_last_at": func.now()},
        )
    )


def record_probe_result(
    session,
    bot_id: int,
    *,
    hostname: str,
    status: str,
    bot_key: str | None = None,
    detail: str | None = None,
) -> None:
    """Store one active-probe verdict.

    Writes only the ``probe_*`` columns. A probe must never touch
    ``observed_*``: those say a real visitor loaded the widget from a real
    browser, and letting our own fetch stamp them would make the product's
    strongest signal indistinguishable from the product checking its own
    homework.
    """
    session.execute(
        pg_insert(BotDomainInstall)
        .values(
            bot_id=bot_id,
            hostname=hostname,
            probe_status=status,
            probe_checked_at=func.now(),
            probe_bot_key=bot_key,
            probe_detail=detail,
        )
        .on_conflict_do_update(
            constraint="uq_bot_domain_install",
            set_={
                "probe_status": status,
                "probe_checked_at": func.now(),
                "probe_bot_key": bot_key,
                "probe_detail": detail,
            },
        )
    )


def list_domain_installs(session, bot_id: int) -> list[BotDomainInstall]:
    """Every domain this chatbot has been seen on or checked against.

    Ordered so the rows that need a decision surface first: anything the probe
    flagged, then live domains, then the rest alphabetically. The API layer adds
    the allow-list domains that have no row at all, because "configured but
    never seen" is a state this table cannot represent on its own.
    """
    rows = session.execute(select(BotDomainInstall).where(BotDomainInstall.bot_id == bot_id)).scalars().all()

    severity = {"foreign": 0, "missing": 1, "unreachable": 2}
    return sorted(
        rows,
        key=lambda r: (
            severity.get(r.probe_status or "", 3),
            r.observed_last_at is None,
            r.hostname,
        ),
    )
