"""Per-bot billing — plan attaches to Bot, not Client.

Introduces the schema needed to move from the "one subscription per client,
pooled credits across all bots" model to "one subscription per bot, isolated
credits per bot". Existing customers are grandfathered via
``bots.is_legacy_pooled`` so their credit deduction path remains unchanged
until they choose to migrate (or churn).

Schema additions
================

``bots``
    * ``plan_id`` (FK → plans.id, nullable) — plan this specific bot is on.
      ``NULL`` for legacy-pooled bots and for the single Free bot.
    * ``subscription_id`` (FK → subscriptions.id, nullable) — subscription
      funding this bot. ``NULL`` for legacy-pooled and Free bots.
    * ``is_legacy_pooled`` (Bool, default false, NOT NULL) — true means
      credit deductions for this bot must fall back to the client-level
      ledger entries (pre-migration behaviour). Set true during backfill
      for every bot owned by a client with > 1 active bot.
    * ``credits_balance`` (Integer, default 0, NOT NULL) — per-bot running
      balance for non-legacy bots. Mirrors ``CreditLedger`` SUM but
      maintained eagerly so the chat hot path doesn't aggregate on every
      request. ``0`` for legacy bots (they read from the client pool).

``subscriptions``
    * ``bot_id`` (FK → bots.id, nullable, ON DELETE SET NULL) — which bot
      this subscription funds. ``NULL`` means a legacy client-level
      subscription (one per client, the pre-migration shape). Non-null
      means a per-bot subscription.

``credit_ledger``
    * ``bot_id`` (FK → bots.id, nullable, ON DELETE SET NULL) — bot whose
      ledger this entry belongs to. ``NULL`` for legacy/client-level
      entries (pre-migration grants & deductions). New per-bot entries
      MUST set this column so the per-bot balance query is cheap.

Index changes
=============

The existing partial unique index ``ix_subscriptions_client_active``
("only one active subscription per client") is replaced by two partial
indexes so both shapes coexist during the dual-path window:

* ``ix_subscriptions_client_legacy_active`` — unique on ``client_id``
  WHERE ``bot_id IS NULL AND status IN ('active','trialing','past_due')``.
  Preserves the legacy "one client-level sub" rule for grandfathered rows.
* ``ix_subscriptions_client_bot_active`` — unique on
  ``(client_id, bot_id)`` WHERE
  ``bot_id IS NOT NULL AND status IN ('active','trialing','past_due')``.
  Enforces "one active subscription per (client, bot)" for the new model
  while allowing the same client to have many bot-scoped subscriptions.

Data backfill
=============

Run in-Python so we can branch on subscription state per client:

1. For every active bot whose client owns ``> 1`` active bots → set
   ``is_legacy_pooled = true``. Their credits stay pooled forever (no
   billing change forced on existing customers).
2. For every active bot whose client owns exactly 1 active bot AND has an
   active/trialing/past_due subscription → copy ``subscription.id`` and
   ``subscription.plan_id`` onto the bot. The subscription stays
   client-level (``subscription.bot_id`` remains ``NULL``) so the legacy
   client-level webhook path still updates it correctly. The bot links
   are just convenience pointers used by the new entitlements service.
3. Single-bot clients on the Free tier → leave all new fields at their
   defaults. The single bot is implicitly Free; the entitlements service
   recognises this via "client has 1 bot, no paid sub" rather than via
   a sentinel value.

The backfill is idempotent: re-running it on an already-migrated row
produces the same result because the WHERE clauses key off ``is_active``
and subscription status, not the new columns.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "f8b2c4d6e1a3"
down_revision = "0ace0a17"
branch_labels = None
depends_on = None


# Status set that counts as "subscription currently funding the bot".
# Matches the existing ix_subscriptions_client_active partial index so
# the grandfathering query lines up with the constraint it's replacing.
_ACTIVE_SUB_STATUSES = "('active','trialing','past_due')"


def upgrade() -> None:
    bind = op.get_bind()

    # ── 1. Add new columns ────────────────────────────────────────────────
    # FK on bots.plan_id — RESTRICT so a plan can't be deleted while bots
    # reference it. Mirrors subscriptions.plan_id.
    op.add_column(
        "bots",
        sa.Column("plan_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_bots_plan_id",
        "bots",
        "plans",
        ["plan_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_bots_plan_id", "bots", ["plan_id"])

    # FK on bots.subscription_id — SET NULL so cancelling a subscription
    # doesn't cascade-delete the bot (the bot stays around in a paused
    # state until the customer resubscribes or deletes it manually).
    op.add_column(
        "bots",
        sa.Column("subscription_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_bots_subscription_id",
        "bots",
        "subscriptions",
        ["subscription_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_bots_subscription_id", "bots", ["subscription_id"])

    op.add_column(
        "bots",
        sa.Column(
            "is_legacy_pooled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "bots",
        sa.Column(
            "credits_balance",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )

    op.add_column(
        "subscriptions",
        sa.Column("bot_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_subscriptions_bot_id",
        "subscriptions",
        "bots",
        ["bot_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_subscriptions_bot_id", "subscriptions", ["bot_id"])

    op.add_column(
        "credit_ledger",
        sa.Column("bot_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_credit_ledger_bot_id",
        "credit_ledger",
        "bots",
        ["bot_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_credit_ledger_bot_id", "credit_ledger", ["bot_id"])

    # ── 2. Swap the "one active subscription per client" index ────────────
    op.drop_index("ix_subscriptions_client_active", table_name="subscriptions")

    op.create_index(
        "ix_subscriptions_client_legacy_active",
        "subscriptions",
        ["client_id"],
        unique=True,
        postgresql_where=sa.text(
            f"bot_id IS NULL AND status IN {_ACTIVE_SUB_STATUSES}",
        ),
    )
    op.create_index(
        "ix_subscriptions_client_bot_active",
        "subscriptions",
        ["client_id", "bot_id"],
        unique=True,
        postgresql_where=sa.text(
            f"bot_id IS NOT NULL AND status IN {_ACTIVE_SUB_STATUSES}",
        ),
    )

    # ── 3. Backfill ──────────────────────────────────────────────────────
    # Flag every bot of a multi-bot client as legacy-pooled so the chat
    # hot path keeps draining from the client-level credit ledger.
    bind.execute(
        sa.text(
            """
            UPDATE bots
               SET is_legacy_pooled = true
             WHERE is_active = true
               AND client_id IN (
                   SELECT client_id
                     FROM bots
                    WHERE is_active = true
                 GROUP BY client_id
                   HAVING COUNT(*) > 1
               )
            """,
        ),
    )

    # For single-bot paid clients, link the bot to the existing client-level
    # subscription so the new entitlements service has a direct pointer.
    # The subscription row itself stays bot_id=NULL (legacy client-level)
    # so the existing Stripe/Razorpay webhook handlers don't need branching.
    bind.execute(
        sa.text(
            f"""
            UPDATE bots b
               SET subscription_id = s.id,
                   plan_id = s.plan_id
              FROM subscriptions s
             WHERE b.is_active = true
               AND b.client_id = s.client_id
               AND s.bot_id IS NULL
               AND s.status IN {_ACTIVE_SUB_STATUSES}
               AND b.client_id IN (
                   SELECT client_id
                     FROM bots
                    WHERE is_active = true
                 GROUP BY client_id
                   HAVING COUNT(*) = 1
               )
            """,
        ),
    )


def downgrade() -> None:
    # Restore the original partial unique index first so the constraint
    # set matches the pre-migration shape before any data motion.
    op.drop_index("ix_subscriptions_client_bot_active", table_name="subscriptions")
    op.drop_index("ix_subscriptions_client_legacy_active", table_name="subscriptions")
    op.create_index(
        "ix_subscriptions_client_active",
        "subscriptions",
        ["client_id"],
        unique=True,
        postgresql_where=sa.text(f"status IN {_ACTIVE_SUB_STATUSES}"),
    )

    op.drop_index("ix_credit_ledger_bot_id", table_name="credit_ledger")
    op.drop_constraint("fk_credit_ledger_bot_id", "credit_ledger", type_="foreignkey")
    op.drop_column("credit_ledger", "bot_id")

    op.drop_index("ix_subscriptions_bot_id", table_name="subscriptions")
    op.drop_constraint("fk_subscriptions_bot_id", "subscriptions", type_="foreignkey")
    op.drop_column("subscriptions", "bot_id")

    op.drop_column("bots", "credits_balance")
    op.drop_column("bots", "is_legacy_pooled")

    op.drop_index("ix_bots_subscription_id", table_name="bots")
    op.drop_constraint("fk_bots_subscription_id", "bots", type_="foreignkey")
    op.drop_column("bots", "subscription_id")

    op.drop_index("ix_bots_plan_id", table_name="bots")
    op.drop_constraint("fk_bots_plan_id", "bots", type_="foreignkey")
    op.drop_column("bots", "plan_id")
