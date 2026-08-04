"""payment methods rbi columns

Reshapes ``payment_methods`` into an RBI-compliant display mirror of Razorpay's
per-customer token list.

DROPS ``brand``, ``expiry_month``, ``expiry_year``. Under the RBI card-on-file
guidelines a merchant may retain only the last four digits, the network and
issuer metadata — cardholder name, BIN/IIN and **expiry** must not be stored
after 1 Oct 2022. Those columns were a compliance liability waiting for a
writer; the table has never had one.

ADDS ``network`` / ``issuer`` (the permitted metadata, replacing ``brand``),
``upi_handle`` (VPA, so a UPI mandate shows as more than "upi"),
``razorpay_customer_id`` (tokens are addressed per customer) and ``synced_at``
(drives the read-through TTL so Billing does not call the gateway on every page
load).

The drops are safe because the table is EMPTY in every environment — nothing in
the codebase has ever constructed a ``PaymentMethod``. The upgrade asserts that
rather than trusting it: if a row exists, the migration fails loudly instead of
silently destroying card metadata.

Revision ID: c96e2d24b7b4
Revises: e1c4a7b93d55
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c96e2d24b7b4"
down_revision: str | Sequence[str] | None = "e1c4a7b93d55"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _assert_empty() -> None:
    """Refuse to drop card metadata from a populated table.

    A destructive column drop is only justified by the table being unused. If
    that stops being true between authoring and deploy, failing the migration
    is far better than discovering it after the data is gone.
    """
    # Offline (`--sql`) renders a script instead of executing: op.get_bind()
    # hands back a MockConnection whose execute() returns None, so the guard
    # would crash with an opaque AttributeError AND emit a meaningless
    # SELECT into the generated script. Refuse explicitly instead -- a DBA must
    # never be handed DROP statements with the safety check silently stripped.
    if op.get_context().as_sql:
        raise RuntimeError(
            "This migration drops card metadata and must run ONLINE so it can verify "
            "payment_methods is empty; --sql (offline) is not supported."
        )
    count = op.get_bind().execute(sa.text("SELECT count(*) FROM payment_methods")).scalar_one()
    if count:
        raise RuntimeError(
            f"payment_methods has {count} row(s); this migration drops card metadata columns "
            "and is only safe on an empty table. Migrate the data first."
        )


def upgrade() -> None:
    _assert_empty()
    op.add_column("payment_methods", sa.Column("network", sa.String(), nullable=True))
    op.add_column("payment_methods", sa.Column("issuer", sa.String(), nullable=True))
    op.add_column("payment_methods", sa.Column("upi_handle", sa.String(), nullable=True))
    # razorpay_customer_id records which gateway customer a token came from
    # (provenance, and how you would spot a rotated customer id). It is
    # deliberately NOT indexed: nothing queries by it — the service reads by
    # client_id and deletes by token id, both already indexed — so an index
    # here would be pure write amplification.
    op.add_column("payment_methods", sa.Column("razorpay_customer_id", sa.String(), nullable=True))
    op.add_column("payment_methods", sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_column("payment_methods", "brand")
    op.drop_column("payment_methods", "expiry_year")
    op.drop_column("payment_methods", "expiry_month")


def downgrade() -> None:
    op.add_column("payment_methods", sa.Column("expiry_month", sa.INTEGER(), nullable=True))
    op.add_column("payment_methods", sa.Column("expiry_year", sa.INTEGER(), nullable=True))
    op.add_column("payment_methods", sa.Column("brand", sa.VARCHAR(), nullable=True))
    op.drop_column("payment_methods", "synced_at")
    op.drop_column("payment_methods", "razorpay_customer_id")
    op.drop_column("payment_methods", "upi_handle")
    op.drop_column("payment_methods", "issuer")
    op.drop_column("payment_methods", "network")
