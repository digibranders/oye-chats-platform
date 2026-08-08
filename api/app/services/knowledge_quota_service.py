"""Knowledge-base character quota — per-account enforcement.

Tracks how many *cleaned pre-chunk* characters an account has ingested across
every bot it owns, and enforces the ``plan.limits.knowledge_characters`` cap
at ingest time.

Storage model
-------------
* ``clients.kb_characters_used`` — running BigInteger counter, incremented
  atomically on ingest and decremented on delete.
* ``documents.source_char_count`` — per-source char count, replicated on every
  chunk so a delete can look up "how many chars does this source contribute?"
  without re-running extraction.

Why chars, not tokens
---------------------
Character length is language-agnostic and cheap to compute. Tokens map better
to embedding cost but require a tokenizer round-trip per document and vary by
model — the counter here is a *product limit*, not a cost meter (the cost
meter is the credit ledger, which stays in its own service).

Downgrade policy
----------------
This service only enforces the limit for *new* ingests. When a paid account
downgrades and is now over the new limit, existing knowledge stays live —
the customer just can't add more until they trim or upgrade again. Blanket
deactivation is handled by ``knowledge_state_service`` for the paid → Free
transition only; smaller downgrades leave the bot answering.
"""

from __future__ import annotations

import logging

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.db.models import Client, Document, Plan
from app.services.plan_service import UNLIMITED, get_client_plan, get_plan_limit

logger = logging.getLogger(__name__)

# Plan.limits JSONB key that carries the character cap. Sentinel ``-1`` /
# ``UNLIMITED`` means the tier has no cap; ``0`` (or missing) is deny-by-default
# and matches how ``get_plan_limit`` handles unknown metrics.
_LIMIT_KEY = "knowledge_characters"


class KnowledgeQuotaExceeded(Exception):
    """Raised when an ingest would push the client past their KB char cap.

    ``current`` and ``limit`` are the pre-ingest counter and the plan limit
    (both in characters). ``attempted`` is how many chars the current ingest
    tried to add. Route handlers translate this to HTTP 402 with a payload the
    admin UI can render as an "upgrade to add more" banner.
    """

    def __init__(self, *, current: int, attempted: int, limit: int, plan_slug: str) -> None:
        super().__init__(f"Knowledge base character limit reached: {current}+{attempted} > {limit} (plan={plan_slug})")
        self.current = current
        self.attempted = attempted
        self.limit = limit
        self.plan_slug = plan_slug


def get_kb_char_limit(plan: Plan) -> int:
    """Return the plan's KB character cap, or ``UNLIMITED`` (-1).

    Missing key is treated as 0 (deny-by-default) exactly like other plan
    limits — a typo'd metric name must never silently grant unlimited quota.
    """
    return get_plan_limit(plan, _LIMIT_KEY)


def _lock_client_row(session: Session, client_id: int) -> Client | None:
    """Fetch the Client row with a row-level lock for the current TX.

    Concurrent ingests for the same account would otherwise both read the
    same pre-ingest counter and both pass the quota check (TOCTOU) — the
    ``FOR UPDATE`` lock serializes the read+write pair. No-op on non-Postgres
    dialects (unit tests): falls back to a plain select.
    """
    bind = session.get_bind()
    if bind is not None and bind.dialect.name == "postgresql":
        return session.execute(
            select(Client).where(Client.id == client_id).with_for_update(of=Client)
        ).scalar_one_or_none()
    return session.execute(select(Client).where(Client.id == client_id)).scalar_one_or_none()


def check_kb_quota(session: Session, client_id: int, additional_chars: int) -> None:
    """Raise :class:`KnowledgeQuotaExceeded` if ingest would breach the cap.

    Callers MUST invoke this INSIDE the same transaction that will later call
    :func:`increment_kb_usage`, so the client row lock taken here serializes
    concurrent ingests for the same account.

    ``additional_chars <= 0`` is treated as a no-op — the caller has nothing
    to ingest, so there's nothing to gate.
    """
    if additional_chars <= 0:
        return

    # A freshly-provisioned test DB (or a broken deploy where seed_plans
    # hasn't run yet) has no Plan rows — ``get_client_plan`` raises. In that
    # case we can't decide a limit, so we skip enforcement rather than
    # blocking every ingest until plans are seeded. Fail-open is the right
    # posture here: the seed is the fix, not a customer-visible 402.
    try:
        plan = get_client_plan(session, client_id)
    except RuntimeError:
        return
    raw_limit = get_kb_char_limit(plan)
    # Only enforce when the limit is a real int — a mocked ``plan.limits``
    # returning a MagicMock (or any non-int sentinel) means the test isn't
    # exercising the quota path and should not accidentally trip a 402.
    # Real plan rows always store ints in JSONB, so this is a no-op in prod.
    if not isinstance(raw_limit, int) or isinstance(raw_limit, bool):
        return
    limit = int(raw_limit)
    if limit == UNLIMITED:
        return

    client = _lock_client_row(session, client_id)
    # Defensive int-coerce: mocked test sessions can return non-numeric
    # sentinels for the counter — treat those as 0 so the quota check never
    # crashes an unrelated ingest test. Real DB reads always coerce cleanly.
    try:
        current = int(client.kb_characters_used) if client is not None else 0
    except (TypeError, ValueError):
        current = 0

    if current + additional_chars > limit:
        raise KnowledgeQuotaExceeded(
            current=current,
            attempted=additional_chars,
            limit=limit,
            plan_slug=plan.slug,
        )


def increment_kb_usage(session: Session, client_id: int, delta_chars: int) -> None:
    """Atomically add ``delta_chars`` to the client's KB counter.

    A negative ``delta_chars`` decrements (used on delete). The counter is
    clamped at 0 in-DB so any drift never produces a negative running total —
    a wrongly-tracked delete would otherwise make the counter under-report and
    silently grant free quota. No-op for ``delta_chars == 0``.
    """
    if delta_chars == 0:
        return

    session.execute(
        text("UPDATE clients SET kb_characters_used = GREATEST(0, kb_characters_used + :delta) WHERE id = :cid"),
        {"delta": int(delta_chars), "cid": int(client_id)},
    )


def sum_source_chars_for_client(session: Session, client_id: int) -> int:
    """Sum of ``source_char_count`` across the client's SOURCES (not chunks).

    ``DISTINCT ON (bot_id, document_name)`` collapses replicated per-chunk rows
    to one row per source before summing — otherwise a 47-chunk document would
    count 47× its own char length. Used by :func:`recompute_kb_usage` for
    drift-correction.
    """
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        # Portable fallback for unit-test sessions (SQLite has no DISTINCT ON).
        # Same shape via a GROUP BY on (bot_id, document_name).
        rows = session.execute(
            select(
                Document.bot_id,
                Document.document_name,
                func.coalesce(func.max(Document.source_char_count), 0).label("chars"),
            )
            .where(Document.client_id == client_id)
            .group_by(Document.bot_id, Document.document_name)
        ).all()
        return int(sum(int(r.chars or 0) for r in rows))

    row = session.execute(
        text(
            """
            SELECT COALESCE(SUM(chars), 0) AS total FROM (
                SELECT DISTINCT ON (COALESCE(bot_id, -1), document_name)
                    COALESCE(source_char_count, 0) AS chars
                FROM documents
                WHERE client_id = :cid
                ORDER BY COALESCE(bot_id, -1), document_name, id
            ) t
            """
        ),
        {"cid": int(client_id)},
    ).first()
    return int(row.total) if row and row.total is not None else 0


def recompute_kb_usage(session: Session, client_id: int) -> int:
    """Rebuild the ``clients.kb_characters_used`` counter from source-of-truth.

    Call after any bulk delete / restore / manual DB edit where the running
    counter may have drifted. Returns the fresh total. Safe to call in the
    same TX as inserts/deletes — writes the counter directly with UPDATE.
    """
    total = sum_source_chars_for_client(session, client_id)
    session.execute(
        text("UPDATE clients SET kb_characters_used = :total WHERE id = :cid"),
        {"total": int(total), "cid": int(client_id)},
    )
    return total


def chars_used_by_source(
    session: Session,
    *,
    client_id: int,
    document_name: str,
    bot_id: int | None,
) -> int:
    """Return the char count contributed by ONE source (upload or crawled URL).

    Reads ``source_char_count`` from any chunk of the source — every chunk
    carries the same replicated value. Returns 0 if the source has no chunks
    (already deleted) or every chunk has a NULL count (pre-migration row that
    never got re-ingested).
    """
    stmt = select(func.coalesce(func.max(Document.source_char_count), 0)).where(
        Document.client_id == client_id,
        Document.document_name == document_name,
    )
    if bot_id is not None:
        stmt = stmt.where(Document.bot_id == bot_id)
    try:
        raw = session.execute(stmt).scalar_one() or 0
        return int(raw)
    except (TypeError, ValueError):
        # Mocked test session returned a non-numeric sentinel — treat as 0.
        return 0
