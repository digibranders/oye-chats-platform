"""Carry a greeting typed before be984949 into the columns the widget reads.

The Experience page had fields for the widget's greeting and subtitle, and
until be984949 it wrote them to ``widget_messages->>'welcome_greeting'`` and
``widget_messages->>'welcome_subtitle'``, two JSONB keys nothing displays. The
widget renders the ``bots.welcome_title`` / ``bots.welcome_subtitle`` columns,
which is where the console reads and writes now. A customer who typed a
greeting before that fix therefore sees the console revert to the seeded
default, with their own words stranded in the JSONB.

This copies each stranded value into its column, once, and only where doing so
cannot overwrite anything a customer chose since:

* the JSONB value is a string with non-blank content;
* for the greeting, it is not the JSONB column's own seeded default
  (``"Hi There, How can I help you today?"``), which every bot carries whether
  or not anyone typed anything. Copying that would change the greeting on
  every untouched widget on the platform;
* the target column is NULL or still holds its seeded default. Both columns
  are NOT NULL with a server default, so NULL is unreachable today; the
  clause is kept so a later relaxation cannot make this a clobber.

Values are cut to the API's own limits for the same fields
(``UpdateBotRequest.welcome_title`` is ``Name``, 200 characters, whitespace
stripped; ``welcome_subtitle`` is ``ShortText``, 500 characters), so the row
stays writable through the console afterwards.

Revision ID: b1000013welcomebackfill
Revises: b1000012auditindex
"""

from __future__ import annotations

from alembic import op

revision: str = "b1000013welcomebackfill"
down_revision: str | None = "b1000012auditindex"
branch_labels = None
depends_on = None

# Seeded column defaults (``app/db/models.py``, ``Bot.welcome_title`` /
# ``Bot.welcome_subtitle``). A column holding one of these was never edited.
SEEDED_WELCOME_TITLE = "Hi there 👋"
SEEDED_WELCOME_SUBTITLE = "How can we help you today?"

# The JSONB column's own seeded greeting (``Bot.widget_messages`` server
# default). Present on every bot; it is not a customer's words.
SEEDED_JSONB_GREETING = "Hi There, How can I help you today?"

# ``app/schemas/validators.py``: MAX_NAME and MAX_SHORT_TEXT.
MAX_TITLE_CHARS = 200
MAX_SUBTITLE_CHARS = 500

# One statement, row-level, no loop. Each column moves only when its own
# condition holds; the other keeps its current value through the CASE.
BACKFILL_SQL = f"""
UPDATE bots
SET
    welcome_title = CASE
        WHEN jsonb_typeof(widget_messages -> 'welcome_greeting') = 'string'
         AND btrim(widget_messages ->> 'welcome_greeting') <> ''
         AND widget_messages ->> 'welcome_greeting' <> '{SEEDED_JSONB_GREETING}'
         AND (welcome_title IS NULL OR welcome_title = '{SEEDED_WELCOME_TITLE}')
        THEN left(btrim(widget_messages ->> 'welcome_greeting'), {MAX_TITLE_CHARS})
        ELSE welcome_title
    END,
    welcome_subtitle = CASE
        WHEN jsonb_typeof(widget_messages -> 'welcome_subtitle') = 'string'
         AND btrim(widget_messages ->> 'welcome_subtitle') <> ''
         AND (welcome_subtitle IS NULL OR welcome_subtitle = '{SEEDED_WELCOME_SUBTITLE}')
        THEN left(widget_messages ->> 'welcome_subtitle', {MAX_SUBTITLE_CHARS})
        ELSE welcome_subtitle
    END
WHERE
    (
        jsonb_typeof(widget_messages -> 'welcome_greeting') = 'string'
        AND btrim(widget_messages ->> 'welcome_greeting') <> ''
        AND widget_messages ->> 'welcome_greeting' <> '{SEEDED_JSONB_GREETING}'
        AND (welcome_title IS NULL OR welcome_title = '{SEEDED_WELCOME_TITLE}')
    )
    OR (
        jsonb_typeof(widget_messages -> 'welcome_subtitle') = 'string'
        AND btrim(widget_messages ->> 'welcome_subtitle') <> ''
        AND (welcome_subtitle IS NULL OR welcome_subtitle = '{SEEDED_WELCOME_SUBTITLE}')
    )
"""


def upgrade() -> None:
    # A row-level UPDATE takes only row locks, but a concurrent DDL or a long
    # transaction holding the table could still queue this behind it. Fail
    # fast rather than stall the deploy.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(BACKFILL_SQL)


def downgrade() -> None:
    """Deliberately a no-op.

    The upgrade copies data between two places on the same row and drops
    nothing: the JSONB keys are left exactly as they were. Reverting would
    mean resetting ``welcome_title`` / ``welcome_subtitle`` to their seeded
    defaults, which cannot tell a value this migration wrote from one a
    customer typed into the console after it ran, and would erase the latter.
    A copy that loses nothing has nothing safe to undo.
    """
