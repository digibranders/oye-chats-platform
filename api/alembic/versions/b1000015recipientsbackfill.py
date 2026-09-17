"""Save a default notification recipient list on every bot.

Production audit, 2026-09-17: all eight bots had ``notification_emails`` and
``notification_email`` NULL. Mail still reached each owner through the
send-time fallback in ``email_service.get_notification_recipients``, but the
console showed an empty recipient field. New bots now start with the owner's
address saved (``services/bot_defaults.py``); this brings existing bots level.

The resolver reads a per-event list, then ``notification_emails.default``,
then the legacy comma-separated ``notification_email``, then the owner. Each
step below writes the address that chain already produced, so delivery does
not change, with one requested exception:

1. A bot with no usable default list but a usable legacy value gets that value
   as its default list, and the legacy column is cleared. The legacy value is
   split on commas, trimmed, and blank parts are dropped, exactly as the
   resolver does.
2. A bot that still has neither gets its owner's account email as the default
   list, and a blank legacy value is cleared.
3. Product owner, 2026-09-17: Eventus (``bot-2cd622e21f80``) and the eval bot
   (``bot-7b18925d18a7``) get gaurav@fynix.digital instead of their owner, and
   only if they reach step 2 (a list saved since is kept).

Per-event lists are never touched and a usable default list is never
replaced. A default list counts as usable when it holds at least one
non-blank string, the same test the resolver applies. ``business_hours`` is
deliberately not backfilled: no production bot has a schedule, and NULL means
always available.

Revision ID: b1000015recipientsbackfill
Revises: b1000014queuetimeout
"""

from __future__ import annotations

from alembic import op

revision: str = "b1000015recipientsbackfill"
down_revision: str | None = "b1000014queuetimeout"
branch_labels = None
depends_on = None

NAMED_RECIPIENT = "gaurav@fynix.digital"
NAMED_BOT_KEYS = ("bot-2cd622e21f80", "bot-7b18925d18a7")

# ``notification_emails`` as an object, whatever it holds today (SQL NULL,
# JSON null, or an object).
_AS_OBJECT = (
    "(CASE WHEN jsonb_typeof(b.notification_emails) = 'object' THEN b.notification_emails ELSE '{}'::jsonb END)"
)

_HAS_DEFAULT = """
(
    CASE
        WHEN jsonb_typeof(b.notification_emails -> 'default') = 'array' THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(b.notification_emails -> 'default') AS entry
            WHERE jsonb_typeof(entry) = 'string' AND btrim(entry #>> '{}') <> ''
        )
        ELSE false
    END
)
"""

_HAS_LEGACY = "COALESCE(b.notification_email ~ '[^,[:space:]]', false)"

MOVE_LEGACY_SQL = f"""
WITH legacy AS (
    SELECT b.id, jsonb_agg(btrim(part.value) ORDER BY part.ordinality) AS addresses
    FROM bots AS b
    CROSS JOIN LATERAL unnest(string_to_array(b.notification_email, ',')) WITH ORDINALITY AS part(value, ordinality)
    WHERE b.notification_email IS NOT NULL
      AND btrim(part.value) <> ''
      AND NOT {_HAS_DEFAULT}
    GROUP BY b.id
)
UPDATE bots AS b
SET notification_emails = {_AS_OBJECT} || jsonb_build_object('default', legacy.addresses),
    notification_email = NULL
FROM legacy
WHERE legacy.id = b.id
"""

NAMED_KEYS_SQL = ", ".join(f"'{key}'" for key in NAMED_BOT_KEYS)

FILL_OWNER_SQL = f"""
UPDATE bots AS b
SET notification_emails = {_AS_OBJECT} || jsonb_build_object(
        'default',
        jsonb_build_array(
            CASE WHEN b.bot_key IN ({NAMED_KEYS_SQL}) THEN '{NAMED_RECIPIENT}' ELSE btrim(c.email) END
        )
    ),
    notification_email = NULL
FROM clients AS c
WHERE c.id = b.client_id
  AND btrim(c.email) <> ''
  AND NOT {_HAS_DEFAULT}
  AND NOT {_HAS_LEGACY}
"""


def upgrade() -> None:
    # Row-level UPDATEs take only row locks, but a concurrent DDL or a long
    # transaction holding the table could still queue this behind it. Fail
    # fast rather than stall the deploy.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(MOVE_LEGACY_SQL)
    op.execute(FILL_OWNER_SQL)


def downgrade() -> None:
    """Deliberately a no-op.

    Every value written is the address the resolver already sent that mail
    to (or, for the two named bots, the address the product owner chose), and
    the previous code reads the saved list the same way. Reverting would mean
    clearing default lists, which cannot tell a list this migration wrote from
    one a customer saved in the console after it ran.
    """
