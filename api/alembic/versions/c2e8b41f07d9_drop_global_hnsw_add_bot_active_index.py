"""Drop the global HNSW index; add (bot_id, is_active) — filtered ANN returned zero rows

THE BUG (measured, not theoretical)
-----------------------------------
Every vector search in this system is tenant-scoped —
``search_similar_documents`` (``app/db/repository.py``) always filters
``bot_id``/``client_id``/``is_active`` and then orders by ``embedding <=> :emb``.
``documents_embedding_hnsw_idx`` is a *global* HNSW index covering every
tenant's vectors in one graph.

With an approximate index pgvector applies the filter **after** the graph walk.
The walk collects ``hnsw.ef_search`` candidates (default 40) from a graph
dominated by other tenants' vectors; the tenant filter then discards all of
them. The query returns an **empty set with no error** — the bot answers "I
don't know" while hundreds of matching chunks sit in the table, and nothing is
logged.

Reproduced on a 2 vCPU/4 GB VM against this exact schema and query shape:
a 45,350-row corpus over 200 tenants.

    tenant size        baseline (global HNSW)   after this migration
    300 chunks         0 rows returned  ← BUG   5 rows
    5,000 chunks       5 rows                   5 rows

Counter-intuitively **small tenants are the ones that break.** A 300-chunk
tenant is 0.66% of that corpus, so essentially none of the 40 candidates belong
to it; a 5,000-chunk tenant is 11% and survives. That is the worst possible
shape here: the typical OyeChats customer has a small knowledge base (CAG-lite
handles bots at or under 20 chunks), and the trigger is not one tenant growing
— it is the *total* corpus growing as customers are added. Every new customer
raises the odds that existing small customers silently get nothing.

WHY NOT THE OBVIOUS FIXES
-------------------------
* Raising ``hnsw.ef_search`` does **not** work. Measured at 40 / 200 / 1000
  (the maximum): zero rows at every value.
* Adding the composite index alone does **not** work. The planner still prefers
  the HNSW index for ``ORDER BY ... LIMIT`` (measured: still zero rows).
* ``hnsw.iterative_scan`` — the documented remedy — needs pgvector >= 0.8.0,
  defaults to ``off`` even there, and caps at ``hnsw.max_scan_tuples`` (20,000)
  which silently truncates. This codebase never sets it, and the deployed
  pgvector version is not pinned anywhere, so it cannot be relied on.

WHAT THIS DOES
--------------
Drops the global HNSW index and adds a composite ``(bot_id, is_active)`` btree
matching the filter every search applies. Retrieval then runs as an exact
bitmap scan over one tenant's rows: **100% recall, and fast at these sizes** —
measured 0.7 ms for a 300-chunk tenant and 7.3 ms for a 5,000-chunk tenant,
against a 45k-row table.

This is a net win today, not a trade-off. Exact search over one tenant beats an
approximate search over all tenants both on correctness and — below roughly 5k
chunks per tenant — on latency.

WHEN TO REINTRODUCE ANN
-----------------------
Only per-tenant, never global. When a single bot exceeds ~5k chunks and its
exact scan becomes the bottleneck, partition ``documents`` by ``bot_id`` and
build one HNSW index per partition (pgvector's own multitenancy guidance), on
pgvector >= 0.8.0 with ``hnsw.iterative_scan = 'relaxed_order'``. Verify with
``EXPLAIN (ANALYZE)`` that a small tenant still returns rows before shipping it.

``downgrade()`` restores the previous shape exactly, including the bug.

Revision ID: c2e8b41f07d9
Revises: f3a7c1e9b204
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

# revision identifiers, used by Alembic.
revision: str = "c2e8b41f07d9"
down_revision: str | Sequence[str] | None = "f3a7c1e9b204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "documents"
HNSW_INDEX = "documents_embedding_hnsw_idx"
# Name matches what the model declares, so a database built by
# ``Base.metadata.create_all()`` (app startup) and one built by this migration
# converge — same house rule as ``f3a7c1e9b204``.
COMPOSITE_INDEX = "ix_documents_bot_id_is_active"


def _indexes() -> set[str] | None:
    """Existing index names on ``documents``, or None when offline.

    House standard (see ``f3a7c1e9b204`` / ``a9fc12693ff6``): ``--sql`` offline
    mode has no bind to inspect, so statements are emitted unconditionally.
    Online, the guard matters because ``app/main.py`` calls
    ``Base.metadata.create_all()`` at startup — a database first created from
    the current models already matches, and unguarded DDL would fail the deploy.
    """
    if context.is_offline_mode():
        return None
    return {ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes(TABLE)}


def upgrade() -> None:
    existing = _indexes()

    if existing is None or COMPOSITE_INDEX not in existing:
        op.create_index(COMPOSITE_INDEX, TABLE, ["bot_id", "is_active"])

    if existing is None or HNSW_INDEX in existing:
        op.drop_index(HNSW_INDEX, table_name=TABLE)


def downgrade() -> None:
    existing = _indexes()

    if existing is None or HNSW_INDEX not in existing:
        op.create_index(
            HNSW_INDEX,
            TABLE,
            ["embedding"],
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        )

    if existing is None or COMPOSITE_INDEX in existing:
        op.drop_index(COMPOSITE_INDEX, table_name=TABLE)
