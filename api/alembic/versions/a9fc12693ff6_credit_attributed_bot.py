"""credit_ledger.attributed_bot_id — per-bot spend, independent of ledger scope

``credit_ledger.bot_id`` is the SCOPE key: NULL means the row lives in the
shared client pool, non-NULL means it lives in that bot's isolated ledger.
Every balance query keys off it (``credit_service._scope_clause`` /
``get_balance``), so it cannot be repurposed to mean "which bot spent this".

Under pooled billing those two questions have different answers: a pooled
account's deductions all land in the client pool (``bot_id IS NULL``) no matter
which agent served the chat, which makes per-bot spend unrecoverable. This
column records the spender separately so reporting can group on it while the
balance maths keeps reading ``bot_id`` alone.

``reference_id`` is not a substitute — it is a polymorphic audit label holding
a bot_id, document_id or invoice_id depending on ``reason``, so grouping on it
mixes id spaces.

It lands now, before the first pooled account exists, because attribution
cannot be reconstructed after the fact: a deduction row that was written
without a spender has no other record of which bot served the request.

Additive and backfill-free. Every existing row keeps NULL, which reads as
"spender not recorded" — correct for history.

That NULL is not exclusive to history, though, and a recorded attribution is
not permanent. The FK is ``ON DELETE SET NULL`` and bots are HARD-deleted
(``DELETE /bots/{id}`` → ``session.delete(bot)`` in ``app/api/bot_routes.py``),
so removing an agent rewrites every historical deduction attributed to it back
to NULL. A pooled account that deletes an agent therefore loses that agent's
whole spend history into the same "unattributed" bucket as pre-rollout rows,
and loses it silently: the scope column (``bot_id``) is untouched, so balances
and account totals still reconcile and nothing alarms.
``reporting_service._credits_by_bot`` inner-joins ``Bot`` on this column, so
the affected rows drop out of the per-bot rollup rather than resurfacing
misattributed — the loss is invisible, not wrong.

If that fidelity ever matters, the codebase already has the pattern that
survives a delete: ``reference_id`` on this same table is a plain ``Integer``
with no FK precisely so an audit label is not coupled to another row's
lifecycle. Modelling attribution that way is a product decision — it trades
referential integrity (and the FK's guarantee that the id resolves) for
retained history — and is deliberately NOT taken here.

Index and FK are built NON-concurrently. ``credit_ledger`` is the platform's
highest-write table in principle, but the relaunch reset it in July and it
holds double-digit rows today, so the momentary SHARE lock on a table this size
is not worth the CONCURRENTLY path (autocommit block, plus an INVALID index
left behind if the build fails mid-way). Revisit if the ledger reaches a size
where a full scan is not instantaneous.

Revision ID: a9fc12693ff6
Revises: e4c2a8b17f65
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

# revision identifiers, used by Alembic.
revision: str = "a9fc12693ff6"
down_revision: str | Sequence[str] | None = "e4c2a8b17f65"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "credit_ledger"
COLUMN = "attributed_bot_id"
INDEX = "ix_credit_ledger_attributed_bot_id"
# Matches the name Postgres derives for an unnamed FK, so a table built by
# ``create_all`` and one built by this migration end up with the same object.
FK = "credit_ledger_attributed_bot_id_fkey"


def _has_column() -> bool | None:
    """Whether ``credit_ledger`` already has the column, or None when offline.

    House standard (see ``1da557cae107`` / ``d81b4e5c9a37``): without this guard
    ``alembic upgrade --sql`` raises ``NoInspectionAvailable`` on a
    MockConnection and DDL review is impossible. In offline mode the statements
    are emitted unconditionally, which is what a SQL script wants.

    Online, the guard matters because ``app/main.py`` calls
    ``Base.metadata.create_all()`` at startup: a database first created from the
    current models already has the column, index and FK, and a bare
    ``add_column`` would fail the deploy on it.
    """
    if context.is_offline_mode():
        return None
    return COLUMN in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(TABLE, sa.Column(COLUMN, sa.Integer(), nullable=True))
    op.create_index(INDEX, TABLE, [COLUMN])
    op.create_foreign_key(FK, TABLE, "bots", [COLUMN], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    """Drop the column. Loses recorded attribution, which is not rebuildable —
    but nothing reads it yet, and no balance depends on it."""
    if _has_column() is False:
        return
    op.drop_constraint(FK, TABLE, type_="foreignkey")
    op.drop_index(INDEX, table_name=TABLE)
    op.drop_column(TABLE, COLUMN)
