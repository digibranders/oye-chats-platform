"""Integration tests for ``app.services.knowledge_quota_service``. Real Postgres.

Uses the shared ``db`` fixture (throwaway Postgres from ``conftest.py``). The
quota logic is DB-bound: the counter lives on ``clients.kb_characters_used``,
the cap comes from a real ``Plan`` row, and the drift-correction queries rely on
``DISTINCT ON``. None of which a mock can exercise faithfully.
"""

import os
from types import SimpleNamespace

import pytest
from sqlalchemy import make_url, select

from app.db.models import Bot, Client, Document, Plan
from app.services import knowledge_quota_service as svc
from app.services.plan_service import UNLIMITED

pytestmark = pytest.mark.skipif(
    os.getenv("DB_URL") is None,
    reason="knowledge quota integration tests need a reachable Postgres at DB_URL",
)

_ = make_url  # imported for parity with the conftest URL handling

_seq = iter(range(1, 100_000))

_EMBEDDING = [0.0] * 768


def make_client(db, *, kb_used=0) -> Client:
    n = next(_seq)
    client = Client(
        name=f"KB Client {n}",
        email=f"kb{n}@example.com",
        hashed_password="$2b$12$notarealhash",
        api_key=f"kb-api-key-{n}",
        kb_characters_used=kb_used,
    )
    db.add(client)
    db.commit()
    return client


def make_plan(db, *, kb_limit, slug=None, is_default=True) -> Plan:
    n = next(_seq)
    plan = Plan(
        name=f"Plan {n}",
        slug=slug or f"plan-{n}",
        limits={"knowledge_characters": kb_limit},
        features={},
        is_active=True,
        is_default=is_default,
    )
    db.add(plan)
    db.commit()
    return plan


def make_bot(db, client) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-kb-{n}", name="KB Bot")
    db.add(bot)
    db.commit()
    return bot


def add_document(db, *, client, bot, name, source_char_count, source="upload", chunks=1):
    for i in range(chunks):
        db.add(
            Document(
                client_id=client.id,
                bot_id=bot.id if bot is not None else None,
                document_name=name,
                source=source,
                file_hash=f"hash-{name}-{i}-{next(_seq)}",
                content=f"chunk {i}",
                source_char_count=source_char_count,
                embedding=_EMBEDDING,
            )
        )
    db.commit()


def _kb_used(db, client_id) -> int:
    return int(db.execute(select(Client.kb_characters_used).where(Client.id == client_id)).scalar_one())


# ── get_kb_char_limit (pure) ─────────────────────────────────────────────────


class TestGetKbCharLimit:
    def test_reads_limit_from_plan(self):
        plan = SimpleNamespace(limits={"knowledge_characters": 5000})
        assert svc.get_kb_char_limit(plan) == 5000

    def test_missing_key_denies_by_default(self):
        plan = SimpleNamespace(limits={"other": 1})
        assert svc.get_kb_char_limit(plan) == 0

    def test_unlimited_sentinel_passes_through(self):
        plan = SimpleNamespace(limits={"knowledge_characters": UNLIMITED})
        assert svc.get_kb_char_limit(plan) == UNLIMITED


# ── check_kb_quota ───────────────────────────────────────────────────────────


class TestCheckKbQuota:
    def test_under_limit_is_allowed(self, db):
        make_plan(db, kb_limit=1000)
        client = make_client(db, kb_used=0)
        # No raise.
        svc.check_kb_quota(db, client.id, 500)

    def test_exact_boundary_is_allowed(self, db):
        make_plan(db, kb_limit=1000)
        client = make_client(db, kb_used=500)
        # 500 + 500 == 1000 is NOT over the cap.
        svc.check_kb_quota(db, client.id, 500)

    def test_one_over_boundary_raises(self, db):
        make_plan(db, kb_limit=1000)
        client = make_client(db, kb_used=500)
        with pytest.raises(svc.KnowledgeQuotaExceeded) as exc:
            svc.check_kb_quota(db, client.id, 501)
        err = exc.value
        assert err.current == 500
        assert err.attempted == 501
        assert err.limit == 1000

    def test_error_carries_plan_slug(self, db):
        make_plan(db, kb_limit=100, slug="tiny-kb")
        client = make_client(db, kb_used=100)
        with pytest.raises(svc.KnowledgeQuotaExceeded) as exc:
            svc.check_kb_quota(db, client.id, 1)
        assert exc.value.plan_slug == "tiny-kb"

    def test_zero_or_negative_additional_is_noop(self, db):
        make_plan(db, kb_limit=100)
        client = make_client(db, kb_used=10_000)  # already way over
        svc.check_kb_quota(db, client.id, 0)
        svc.check_kb_quota(db, client.id, -50)

    def test_unlimited_plan_never_blocks(self, db):
        make_plan(db, kb_limit=UNLIMITED)
        client = make_client(db, kb_used=10_000_000)
        svc.check_kb_quota(db, client.id, 5_000_000)

    def test_no_plan_rows_fails_open(self, db):
        # No Plan seeded → get_client_plan raises RuntimeError → enforcement skipped.
        client = make_client(db, kb_used=10_000_000)
        svc.check_kb_quota(db, client.id, 5_000_000)

    def test_non_integer_limit_fails_open(self, db):
        make_plan(db, kb_limit="not-a-number")
        client = make_client(db, kb_used=10_000_000)
        # A non-int JSONB limit means the quota path isn't real. Don't 402.
        svc.check_kb_quota(db, client.id, 5_000_000)


# ── increment_kb_usage ───────────────────────────────────────────────────────


class TestIncrementKbUsage:
    def test_positive_delta_increments(self, db):
        client = make_client(db, kb_used=100)
        svc.increment_kb_usage(db, client.id, 250)
        db.commit()
        assert _kb_used(db, client.id) == 350

    def test_negative_delta_decrements(self, db):
        client = make_client(db, kb_used=500)
        svc.increment_kb_usage(db, client.id, -200)
        db.commit()
        assert _kb_used(db, client.id) == 300

    def test_decrement_clamped_at_zero(self, db):
        client = make_client(db, kb_used=10)
        svc.increment_kb_usage(db, client.id, -50)
        db.commit()
        assert _kb_used(db, client.id) == 0

    def test_zero_delta_is_noop(self, db):
        client = make_client(db, kb_used=77)
        svc.increment_kb_usage(db, client.id, 0)
        db.commit()
        assert _kb_used(db, client.id) == 77


# ── sum_source_chars_for_client ──────────────────────────────────────────────


class TestSumSourceChars:
    def test_replicated_chunks_counted_once_per_source(self, db):
        client = make_client(db)
        bot = make_bot(db, client)
        # Source A: 3 chunks each replicating 100 → should count 100, not 300.
        add_document(db, client=client, bot=bot, name="a.pdf", source_char_count=100, chunks=3)
        # Source B: single chunk of 50.
        add_document(db, client=client, bot=bot, name="b.pdf", source_char_count=50, chunks=1)
        assert svc.sum_source_chars_for_client(db, client.id) == 150

    def test_same_name_on_different_bots_counted_separately(self, db):
        client = make_client(db)
        bot1 = make_bot(db, client)
        bot2 = make_bot(db, client)
        add_document(db, client=client, bot=bot1, name="dup.pdf", source_char_count=100, chunks=2)
        add_document(db, client=client, bot=bot2, name="dup.pdf", source_char_count=100, chunks=2)
        # Distinct (bot_id, document_name) → two sources → 200.
        assert svc.sum_source_chars_for_client(db, client.id) == 200

    def test_empty_client_sums_to_zero(self, db):
        client = make_client(db)
        assert svc.sum_source_chars_for_client(db, client.id) == 0


# ── recompute_kb_usage ───────────────────────────────────────────────────────


class TestRecomputeKbUsage:
    def test_rebuilds_counter_from_source_of_truth(self, db):
        client = make_client(db, kb_used=99_999)  # drifted value
        bot = make_bot(db, client)
        add_document(db, client=client, bot=bot, name="a.pdf", source_char_count=100, chunks=4)
        add_document(db, client=client, bot=bot, name="b.pdf", source_char_count=25, chunks=1)

        total = svc.recompute_kb_usage(db, client.id)
        db.commit()

        assert total == 125
        assert _kb_used(db, client.id) == 125

    def test_recompute_to_zero_when_no_documents(self, db):
        client = make_client(db, kb_used=500)
        total = svc.recompute_kb_usage(db, client.id)
        db.commit()
        assert total == 0
        assert _kb_used(db, client.id) == 0


# ── chars_used_by_source ─────────────────────────────────────────────────────


class TestCharsUsedBySource:
    def test_returns_source_char_count(self, db):
        client = make_client(db)
        bot = make_bot(db, client)
        add_document(db, client=client, bot=bot, name="doc.pdf", source_char_count=321, chunks=5)
        got = svc.chars_used_by_source(db, client_id=client.id, document_name="doc.pdf", bot_id=bot.id)
        assert got == 321

    def test_unknown_source_returns_zero(self, db):
        client = make_client(db)
        bot = make_bot(db, client)
        got = svc.chars_used_by_source(db, client_id=client.id, document_name="ghost.pdf", bot_id=bot.id)
        assert got == 0

    def test_bot_filter_scopes_the_lookup(self, db):
        client = make_client(db)
        bot1 = make_bot(db, client)
        bot2 = make_bot(db, client)
        add_document(db, client=client, bot=bot1, name="shared.pdf", source_char_count=111, chunks=1)
        # Same name under a different bot must not leak into bot2's lookup.
        assert svc.chars_used_by_source(db, client_id=client.id, document_name="shared.pdf", bot_id=bot2.id) == 0
        assert svc.chars_used_by_source(db, client_id=client.id, document_name="shared.pdf", bot_id=bot1.id) == 111
