"""Force plan pricing to USD-cents (corrects an in-flight re-pricing).

The preceding revision ``e1f2a3b4c5d6`` was authored in two passes:

  1. First pass stored Standard / seat amounts as INR-paise equivalents
     of the $49 / $5 headline (406,700 / 41,500). Some databases applied
     this version before it was rewritten.
  2. The rewrite switched all plans to USD-cents with ``currency='USD'``
     and kept the same revision id, so alembic now sees those databases
     as already at ``e1f2a3b4c5d6`` and refuses to re-apply.

This migration is the corrective step: it unconditionally writes the
final USD-cents values regardless of which intermediate state the row
is in. Idempotent — re-running it on a database already at the right
values is a no-op (same UPDATE writes the same numbers).

Headline pricing (USD-cents):

  Free:        $0  / mo, seat $5
  Starter:     $19 / mo  ($159.60 / yr at 30% off), seat $5
  Standard:    $49 / mo  ($411.60 / yr at 30% off), seat $5
  Enterprise:  $0  / mo (custom), seat $5

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-06-16
"""

from alembic import op

revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


_FREE_MONTHLY = 0
_FREE_ANNUAL = 0
_STARTER_MONTHLY = 1900
_STARTER_ANNUAL = 15960
_STANDARD_MONTHLY = 4900
_STANDARD_ANNUAL = 41160
_ENTERPRISE_MONTHLY = 0
_ENTERPRISE_ANNUAL = 0
_SEAT_USD_CENTS = 500


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_FREE_MONTHLY},
            annual_price_cents  = {_FREE_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'free'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_STARTER_MONTHLY},
            annual_price_cents  = {_STARTER_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'starter'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_STANDARD_MONTHLY},
            annual_price_cents  = {_STANDARD_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'standard'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_ENTERPRISE_MONTHLY},
            annual_price_cents  = {_ENTERPRISE_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'enterprise'
        """
    )
    op.execute(
        f"""
        UPDATE pricing_config
        SET value = '{_SEAT_USD_CENTS}'::jsonb
        WHERE key = 'seat_price_cents'
        """
    )


def downgrade() -> None:
    # Intentionally a no-op: the previous revision is itself a USD-cents
    # writer (post-rewrite), so the only "earlier state" we could
    # restore would be the abandoned INR-paise intermediate that this
    # migration exists specifically to clean up. Leaving downgrade blank
    # avoids reintroducing the bug.
    pass
