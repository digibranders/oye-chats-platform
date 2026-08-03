"""canonical www branding url

Moves ``bots.branding_url`` to the canonical ``https://www.oyechats.com``.

The apex redirects to www (308), so the old value worked — but it was a
non-canonical URL actively distributed to every visitor through the widget's
"Powered by OyeChats" link, costing a redirect hop on each click and splitting
link equity. The website's own SEO audit flagged the same class of issue.

Two parts, both needed:
  - the column default, so new bots start canonical;
  - existing rows that still hold the OLD DEFAULT, so live widgets stop
    emitting the apex. Rows a customer has customised are matched exactly
    against the old default and therefore left untouched.

Reversible: ``downgrade`` restores the previous default and rewrites only the
rows carrying the new default.

Revision ID: e1c4a7b93d55
Revises: c540327852dc
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e1c4a7b93d55"
down_revision: str | Sequence[str] | None = "c540327852dc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD = "https://oyechats.com"
_NEW = "https://www.oyechats.com"


def upgrade() -> None:
    op.alter_column("bots", "branding_url", server_default=_NEW)
    # Only rows still on the old default — never a customer's own branding URL.
    op.execute(sa.text("UPDATE bots SET branding_url = :new WHERE branding_url = :old").bindparams(new=_NEW, old=_OLD))


def downgrade() -> None:
    op.alter_column("bots", "branding_url", server_default=_OLD)
    op.execute(sa.text("UPDATE bots SET branding_url = :old WHERE branding_url = :new").bindparams(new=_NEW, old=_OLD))
