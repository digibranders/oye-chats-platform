# Enterprise Tier & Per-Bot Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an Enterprise plan for agencies — unlimited bots, seats and domains with one shared credit pool — and per-bot reporting so an agency can show each client their own numbers.

**Architecture:** The credit ledger already supports two scopes: `bot_id IS NULL` is a shared client pool, `bot_id = <int>` is an isolated per-bot ledger (`credit_service.py:40-56`). Enterprise uses the pooled path, so no new ledger machinery is needed. The gap is *attribution*: pooled deductions carry `bot_id = NULL`, so per-bot spend is invisible to reporting. We add a dedicated `attributed_bot_id` column that is set on every deduction regardless of scope, ignored by balance maths, and grouped by in reports. The analytics layer is already bot-scoped, so reporting is a rollup endpoint plus a UI, not a rebuild.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL 16 · pytest · React 19 (admin dashboard)

---

## Scope note

This plan covers two subsystems that could ship separately:

- **Phase A (Tasks 1–5)** — the Enterprise plan tier. Ships working software on its own.
- **Phase B (Tasks 6–11)** — per-bot attribution and reporting. Ships working software on its own, and is useful to every tier, not just Enterprise.

**They are sequenced deliberately.** Task 6 (the `attributed_bot_id` migration) must land *before* the first Enterprise account goes live, otherwise pooled spend during that window is unattributable and cannot be backfilled. If you split these into two efforts, do Task 6 first regardless.

**Unlimited websites needs no work.** `Bot.allowed_domains` (`api/app/db/models.py:471`) is an uncapped JSONB list and no plan limit governs it. Unlimited bots therefore gives unlimited domains for free — there is no task for it because there is nothing to build.

**Working with the test fixtures.** Tasks 7, 8 and the DB-backed tests use a shared `db` fixture and construct `Client` / `Bot` rows directly. The constructor kwargs shown are the minimum this plan needs; before writing each test, open an existing DB-backed test such as `api/tests/test_credit_daily.py` and copy its row-construction style so required NOT NULL columns are not missed. These tests skip without `DB_URL` — export it against a local Postgres first.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `api/scripts/seed_plans.py` | Add the Enterprise plan row | A |
| `api/app/api/bot_routes.py` | Enforce the `bots` limit on creation | A |
| `api/app/services/plan_entitlements_service.py` | Free-tier fallback gains a `bots` key | A |
| `api/alembic/versions/<rev>_credit_attributed_bot.py` | New nullable indexed column | B |
| `api/app/db/models.py` | `CreditLedger.attributed_bot_id` | B |
| `api/app/services/credit_service.py` | Set attribution on every deduct | B |
| `api/app/services/reporting_service.py` | **New.** Per-bot rollup queries | B |
| `api/app/api/analytics_routes.py` | `/analytics/by-bot` and CSV export | B |
| `app/src/pages/Reports.jsx` | **New.** Multi-bot reporting table | B |

---

## Phase A — Enterprise plan tier

### Task 1: Seed the Enterprise plan row

**Files:**
- Modify: `api/scripts/seed_plans.py` (append to the `_PLANS` list, after the `professional` entry)
- Test: `api/tests/test_enterprise_plan_seed.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_enterprise_plan_seed.py`:

```python
"""The Enterprise plan row: unlimited bots/operators, pooled credits.

Asserts the seed definition itself, not the DB — this is a pure data check
so it runs without Postgres.
"""

from __future__ import annotations

from scripts.seed_plans import _PLANS


def _plan(slug: str) -> dict:
    for p in _PLANS:
        if p["slug"] == slug:
            return p
    raise AssertionError(f"plan {slug!r} not in _PLANS")


def test_enterprise_plan_exists_with_agency_entitlements():
    ent = _plan("enterprise")

    assert ent["credits_per_month"] == 13000
    assert ent["monthly_price_cents"] == 479900       # ₹4,799
    assert ent["annual_price_cents"] == 4606800       # ₹46,068 (₹3,839/mo)
    assert ent["monthly_price_usd_cents"] == 9199     # $91.99
    assert ent["annual_price_usd_cents"] == 91188     # $911.88 ($75.99/mo)

    # Unlimited is -1 everywhere in this codebase.
    assert ent["limits"]["bots"] == -1
    assert ent["limits"]["operators"] == -1
    assert ent["limits"]["knowledge_characters"] == -1
    assert ent["limits"]["documents"] == -1
    assert ent["limits"]["page_scraping"] == -1

    # Everything Professional has, plus white-label included (not an add-on).
    prof = _plan("professional")
    for flag, value in prof["features"].items():
        assert ent["features"][flag] == value, f"enterprise lost feature {flag}"
    assert ent["features"]["branding_removable"] is True


def test_enterprise_sorts_after_professional():
    assert _plan("enterprise")["sort_order"] > _plan("professional")["sort_order"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_enterprise_plan_seed.py -v`
Expected: FAIL with `AssertionError: plan 'enterprise' not in _PLANS`

- [ ] **Step 3: Add the plan row**

In `api/scripts/seed_plans.py`, append this dict to `_PLANS` immediately after the `professional` entry (before the closing `]`):

```python
    {
        "slug": "enterprise",
        "name": "Enterprise",
        "description": "For agencies running many client sites from one account.",
        "credits_per_month": 13000,
        "monthly_price_cents": 479900,  # ₹4,799
        "annual_price_cents": 4606800,  # ₹46,068 (₹3,839/mo × 12)
        "monthly_price_usd_cents": 9199,  # $91.99
        "annual_price_usd_cents": 91188,  # $911.88 ($75.99/mo × 12)
        "annual_discount_percent": 20,
        "trial_days": 0,
        "included_operator_seats": -1,
        "extra_seat_price_cents": 0,
        "extra_seat_price_usd_cents": 0,
        "is_default": False,
        "sort_order": 5,
        "limits": {
            "credits": 13000,
            # Unlimited bots is the whole point of this tier. Credits still
            # meter real cost (5 per page, 1 per 250 words), so uncapped
            # ingestion is self-limiting — no separate knowledge cap needed.
            "bots": -1,
            "operators": -1,
            "leads": -1,
            "page_scraping": -1,
            "documents": -1,
            "knowledge_characters": -1,
            "chat_history_days": 365,
            "max_crawl_depth": 5,
            "max_crawl_pages": -1,
            "max_crawl_js_pages": -1,
            "max_crawl_concurrency": 8,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": True,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": True,
            "auto_recrawl": True,
            "integrations": "all",
        },
        "marketing": {"tagline": "For agencies running many client sites from one account."},
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_enterprise_plan_seed.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add api/scripts/seed_plans.py api/tests/test_enterprise_plan_seed.py
git commit -m "feat(billing): add Enterprise plan row for agencies"
```

---

### Task 2: Add a `bots` key to the Free-tier fallback

**Why:** `_FREE_FALLBACK_LIMITS` in `plan_entitlements_service.py:98-110` already has `bots: 1`, but there is no test pinning it. Task 3 depends on it being present, so pin it first.

**Files:**
- Test: `api/tests/test_bots_limit_fallback.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_bots_limit_fallback.py`:

```python
"""The Free fallback must carry a `bots` limit.

Task 3 gates bot creation on `limit_for("bots")`. If the fallback ever loses
this key the gate silently becomes UNLIMITED for accounts with no plan row.
"""

from __future__ import annotations

from app.services.plan_entitlements_service import _FREE_FALLBACK_LIMITS


def test_free_fallback_caps_bots_at_one():
    assert _FREE_FALLBACK_LIMITS["bots"] == 1
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_bots_limit_fallback.py -v`
Expected: PASS. If it FAILS with `KeyError: 'bots'`, add `"bots": 1,` to `_FREE_FALLBACK_LIMITS` in `api/app/services/plan_entitlements_service.py` and re-run.

- [ ] **Step 3: Commit**

```bash
git add api/tests/test_bots_limit_fallback.py api/app/services/plan_entitlements_service.py
git commit -m "test(entitlements): pin bots limit in the Free fallback"
```

---

### Task 3: Enforce the `bots` limit on bot creation

**Why:** `Client.max_bots` exists and `limits.bots` is set on every plan, but nothing reads it. Today any account can create unlimited bots, which means Enterprise has nothing to sell.

**Files:**
- Modify: `api/app/api/bot_routes.py` (inside `create_bot`, which starts at line 1436)
- Test: `api/tests/test_bot_creation_limit.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_bot_creation_limit.py`:

```python
"""POST /bots must refuse to exceed the plan's `bots` limit.

Mirrors the operator-seat gate in operator_routes.py:386. UNLIMITED (-1)
must always pass — that is how Enterprise gets unlimited bots.
"""

from __future__ import annotations

from app.services.plan_entitlements_service import UNLIMITED, PlanEntitlements


def _ents(bots_limit: int) -> PlanEntitlements:
    return PlanEntitlements(
        client_id=1,
        plan_slug="test",
        limits={"bots": bots_limit},
        features={},
    )


def test_within_limit_blocks_at_cap():
    ents = _ents(1)
    assert ents.within_limit("bots", 0) is True   # creating the first bot
    assert ents.within_limit("bots", 1) is False  # creating a second


def test_unlimited_never_blocks():
    ents = _ents(UNLIMITED)
    assert ents.within_limit("bots", 0) is True
    assert ents.within_limit("bots", 500) is True
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd api && uv run pytest tests/test_bot_creation_limit.py -v`
Expected: PASS — `within_limit` already handles UNLIMITED. If the `PlanEntitlements` constructor signature differs, read `api/app/services/plan_entitlements_service.py` around line 130 and adjust the `_ents` helper to match the real dataclass fields, then re-run.

- [ ] **Step 3: Add the gate to `create_bot`**

In `api/app/api/bot_routes.py`, inside `create_bot` (line 1436), add this immediately after the client is resolved and **before** any `Bot(...)` row is constructed:

```python
    from app.db.models import Bot as _BotModel
    from app.services import plan_entitlements_service

    entitlements = plan_entitlements_service.get_entitlements(client_id)
    with get_session() as _db:
        current_bots = _db.query(_BotModel).filter(_BotModel.client_id == client_id).count()
    if not entitlements.within_limit("bots", current_bots):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Your plan allows {entitlements.limit_for('bots')} AI agent(s). "
                "Upgrade to Enterprise for unlimited agents."
            ),
        )
```

Match the surrounding code's import style — if `get_session` and `HTTPException` are already imported at module level, drop the local imports and use the existing ones.

- [ ] **Step 4: Run the full bot test suite**

Run: `cd api && uv run pytest tests/ -k "bot" -v`
Expected: PASS. Any test that creates several bots for one client on a Free plan will now fail — that is the gate working. Fix those tests by seeding a plan with a higher `bots` limit rather than removing the gate.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/bot_routes.py api/tests/test_bot_creation_limit.py
git commit -m "feat(bots): enforce the plan bots limit on creation"
```

---

### Task 4: Pin that Enterprise subscriptions pool credits

**Why:** `resolve_bot_ledger_bot_id` (`credit_service.py:60`) returns a per-bot ledger only when `subscription.bot_id == bot.id`. Enterprise must create its subscription with `bot_id = NULL` so every bot drains one shared pool. This is existing behaviour — the test locks it in so a future refactor cannot silently split an agency's pool.

**Files:**
- Test: `api/tests/test_enterprise_pooled_ledger.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_enterprise_pooled_ledger.py`:

```python
"""Enterprise credits are a single shared pool across every bot.

`resolve_bot_ledger_bot_id` returns None (client pool) unless the bot's own
subscription is bot-scoped. An account-level subscription (bot_id NULL) must
route every bot to the same pool — that is what "shared credits" means.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.credit_service import resolve_bot_ledger_bot_id


def test_account_level_subscription_pools_every_bot():
    subscription = SimpleNamespace(bot_id=None)
    bot_a = SimpleNamespace(id=1, is_legacy_pooled=False, subscription=subscription, subscription_id=99)
    bot_b = SimpleNamespace(id=2, is_legacy_pooled=False, subscription=subscription, subscription_id=99)

    assert resolve_bot_ledger_bot_id(bot_a) is None
    assert resolve_bot_ledger_bot_id(bot_b) is None


def test_bot_scoped_subscription_isolates_that_bot():
    bot = SimpleNamespace(id=7, is_legacy_pooled=False, subscription=SimpleNamespace(bot_id=7), subscription_id=42)
    assert resolve_bot_ledger_bot_id(bot) == 7
```

- [ ] **Step 2: Run test**

Run: `cd api && uv run pytest tests/test_enterprise_pooled_ledger.py -v`
Expected: PASS. If it fails on attribute access, read `resolve_bot_ledger_bot_id` at `api/app/services/credit_service.py:60-95` and add whatever attributes it reads (for example `_subscription_bot_id`) to the `SimpleNamespace` stubs.

- [ ] **Step 3: Commit**

```bash
git add api/tests/test_enterprise_pooled_ledger.py
git commit -m "test(credits): pin pooled-ledger routing for account-level subscriptions"
```

---

### Task 5: Publish Enterprise on the pricing page

**Files:**
- Verify: `api/app/api/public_pricing_routes.py`
- Test: `api/tests/test_public_pricing_enterprise.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_public_pricing_enterprise.py`:

```python
"""The public pricing catalog must expose Enterprise.

`/public/pricing` drives both the marketing site and the in-app plan picker,
so a missing row means Enterprise is invisible to buyers.
"""

from __future__ import annotations

import inspect

from app.api import public_pricing_routes


def test_catalog_does_not_filter_out_enterprise():
    source = inspect.getsource(public_pricing_routes)
    for excluded in ('!= "enterprise"', "!= 'enterprise'", 'slug != "enterprise"'):
        assert excluded not in source, f"pricing catalog explicitly excludes enterprise: {excluded}"
```

- [ ] **Step 2: Run test**

Run: `cd api && uv run pytest tests/test_public_pricing_enterprise.py -v`
Expected: PASS — the catalog reads every plan row. If it FAILS, remove the exclusion from `public_pricing_routes.py` and re-run.

- [ ] **Step 3: Create the live Razorpay plans**

Razorpay plans are immutable, so Enterprise needs new IDs in both Test and Live mode. Create four: Enterprise Monthly INR ₹4,799, Enterprise Annual INR ₹46,068, and the USD equivalents if the USD rail is active.

Record them in `docs/billing/razorpay-plan-ids.md` under a new Enterprise row in both the Test and Live tables, then attach them:

```bash
cd api && uv run python scripts/set_razorpay_plan_ids.py --help
```

Follow the flag pattern the script prints for the Enterprise slug. If the script has no `--enterprise-*` flags yet, add them mirroring the existing `--professional-*` pair.

- [ ] **Step 4: Seed and verify locally**

```bash
cd api && uv run python scripts/seed_plans.py --apply
curl -s localhost:8000/public/pricing | python3 -m json.tool | grep -A3 enterprise
```

Expected: an `enterprise` object with `credits_per_month: 13000`.

- [ ] **Step 5: Commit**

```bash
git add api/tests/test_public_pricing_enterprise.py docs/billing/razorpay-plan-ids.md
git commit -m "feat(billing): publish Enterprise in the public pricing catalog"
```

---

## Phase B — Per-bot attribution & reporting

### Task 6: Add `attributed_bot_id` to the credit ledger

**Why:** In pooled mode every ledger row carries `bot_id = NULL`, so per-bot spend is invisible. `reference_id` is documented as a *"coarse AUDIT label: bot_id / document_id / invoice_id"* — polymorphic, so it cannot be grouped on safely. A dedicated column makes attribution exact. Balance maths (`_scope_clause`, `get_balance`) ignore it entirely, so this is additive with zero behaviour change.

**This task must land before the first Enterprise account goes live.** Spend during any gap is unattributable and cannot be backfilled.

**Files:**
- Modify: `api/app/db/models.py` (the `CreditLedger` class, near `bot_id` at line 1911)
- Create: `api/alembic/versions/<rev>_credit_attributed_bot.py`
- Test: `api/tests/test_credit_attribution.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_credit_attribution.py`:

```python
"""Every deduction records which bot spent the credits.

In pooled mode `bot_id` is NULL so the shared balance works. `attributed_bot_id`
is set regardless of scope and is what per-bot reporting groups on. It must
never affect balance maths.
"""

from __future__ import annotations

from app.db.models import CreditLedger


def test_ledger_has_attributed_bot_id_column():
    assert hasattr(CreditLedger, "attributed_bot_id")


def test_attributed_bot_id_is_nullable_and_indexed():
    col = CreditLedger.__table__.columns["attributed_bot_id"]
    assert col.nullable is True
    assert col.index is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_credit_attribution.py -v`
Expected: FAIL with `AssertionError: assert False` on `hasattr`

- [ ] **Step 3: Add the column to the model**

In `api/app/db/models.py`, inside `class CreditLedger`, immediately after the `bot_id` column (line 1911), add:

```python
    # Reporting attribution — ALWAYS set on deductions, independent of ledger
    # scope. `bot_id` above is the SCOPE key (NULL = shared client pool) and
    # balance maths keys off it. This column answers "which bot spent this?"
    # even when the spend came out of a pooled Enterprise balance. Never read
    # by _scope_clause or get_balance.
    attributed_bot_id = Column(Integer, ForeignKey("bots.id", ondelete="SET NULL"), nullable=True, index=True)
```

- [ ] **Step 4: Generate and edit the migration**

```bash
cd api && uv run alembic revision -m "credit attributed bot"
```

Open the generated file in `api/alembic/versions/` and replace `upgrade`/`downgrade` with:

```python
def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("credit_ledger", sa.Column("attributed_bot_id", sa.Integer(), nullable=True))
    op.create_index("ix_credit_ledger_attributed_bot_id", "credit_ledger", ["attributed_bot_id"])
    op.create_foreign_key(
        "fk_credit_ledger_attributed_bot_id",
        "credit_ledger",
        "bots",
        ["attributed_bot_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("fk_credit_ledger_attributed_bot_id", "credit_ledger", type_="foreignkey")
    op.drop_index("ix_credit_ledger_attributed_bot_id", table_name="credit_ledger")
    op.drop_column("credit_ledger", "attributed_bot_id")
```

Leave the auto-generated `revision` and `down_revision` values exactly as Alembic wrote them.

- [ ] **Step 5: Apply and verify**

```bash
cd api && uv run alembic upgrade head
uv run pytest tests/test_credit_attribution.py -v
```

Expected: migration applies cleanly, 2 passed.

- [ ] **Step 6: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/ api/tests/test_credit_attribution.py
git commit -m "feat(credits): add attributed_bot_id for per-bot reporting"
```

---

### Task 7: Set attribution on every deduction

**Files:**
- Modify: `api/app/services/credit_service.py` (`check_and_deduct`, line 548)
- Test: `api/tests/test_credit_attribution.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_credit_attribution.py`:

```python
def test_pooled_deduction_still_records_the_bot(db):
    """A pooled deduction has bot_id NULL but attributed_bot_id set."""
    from app.db.models import Client
    from app.services import credit_service

    client = Client(email="agency@example.com", hashed_password="x", api_key="k-attr-1")
    db.add(client)
    db.flush()

    credit_service.grant(db, client_id=client.id, amount=1000, reason="plan_grant", bot_id=None)
    credit_service.check_and_deduct(
        db,
        client_id=client.id,
        amount=5,
        reason="ai_chat",
        bot_id=None,              # pooled scope
        attributed_bot_id=42,     # which bot spent it
    )
    db.flush()

    row = (
        db.query(CreditLedger)
        .filter(CreditLedger.client_id == client.id, CreditLedger.delta < 0)
        .one()
    )
    assert row.bot_id is None
    assert row.attributed_bot_id == 42
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_credit_attribution.py::test_pooled_deduction_still_records_the_bot -v`
Expected: FAIL with `TypeError: check_and_deduct() got an unexpected keyword argument 'attributed_bot_id'`

If it SKIPs, export `DB_URL` for a local Postgres first — this test needs a real database.

- [ ] **Step 3: Add the parameter**

In `api/app/services/credit_service.py`, change the `check_and_deduct` signature (line 548) to add one keyword-only argument:

```python
def check_and_deduct(
    session: Session,
    client_id: int,
    amount: int,
    reason: str,
    reference_id: int | None = None,
    bot_id: int | None = None,
    idempotency_key: str | None = None,
    *,
    attributed_bot_id: int | None = None,
) -> int:
```

Then, wherever the function constructs a `CreditLedger(...)` row for the debit, add the field. It defaults to `bot_id` so scoped ledgers stay attributed without every caller changing:

```python
            attributed_bot_id=attributed_bot_id if attributed_bot_id is not None else bot_id,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_credit_attribution.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Thread it through the chat path**

In `api/app/api/chat_routes.py`, find the `check_and_deduct` call for `ai_chat` and pass the bot's own id:

```python
        credit_service.check_and_deduct(
            session,
            client_id=client_id,
            amount=chat_cost,
            reason="ai_chat",
            bot_id=ledger_bot_id,          # scope — may be None when pooled
            attributed_bot_id=bot.id,      # attribution — always the real bot
        )
```

Repeat for the crawl path in `api/app/services/crawl_orchestrator.py` and the upload path in `api/app/api/document_routes.py`, passing the real bot id as `attributed_bot_id` in each.

- [ ] **Step 6: Run the full credit suite**

Run: `cd api && uv run pytest tests/ -k "credit" -v`
Expected: PASS — no existing test should change behaviour, since attribution defaults to `bot_id`.

- [ ] **Step 7: Commit**

```bash
git add api/app/services/credit_service.py api/app/api/chat_routes.py api/app/api/document_routes.py api/app/services/crawl_orchestrator.py api/tests/test_credit_attribution.py
git commit -m "feat(credits): attribute every deduction to its bot"
```

---

### Task 8: Per-bot rollup service

**Why:** `analytics_routes.py` is already bot-scoped (51 `bot_id` references, ownership verified via `_verify_bot_ownership`), but an agency with 20 clients would need 20 round-trips. One rollup query returns every bot side by side.

**Files:**
- Create: `api/app/services/reporting_service.py`
- Test: `api/tests/test_reporting_service.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_reporting_service.py`:

```python
"""Per-bot rollup: one row per bot, for the account's reporting table."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.db.models import Bot, Client, CreditLedger
from app.services.reporting_service import get_per_bot_rollup


def test_rollup_returns_one_row_per_bot_with_credits_spent(db):
    client = Client(email="agency2@example.com", hashed_password="x", api_key="k-rollup-1")
    db.add(client)
    db.flush()

    bot_a = Bot(client_id=client.id, name="Client A", bot_key="bot-aaa")
    bot_b = Bot(client_id=client.id, name="Client B", bot_key="bot-bbb")
    db.add_all([bot_a, bot_b])
    db.flush()

    now = datetime.now(UTC)
    db.add_all([
        CreditLedger(client_id=client.id, bot_id=None, attributed_bot_id=bot_a.id,
                     delta=-30, reason="ai_chat", created_at=now),
        CreditLedger(client_id=client.id, bot_id=None, attributed_bot_id=bot_b.id,
                     delta=-12, reason="ai_chat", created_at=now),
        # A grant must never count as consumption.
        CreditLedger(client_id=client.id, bot_id=None, attributed_bot_id=None,
                     delta=13000, reason="plan_grant", created_at=now),
    ])
    db.flush()

    rows = get_per_bot_rollup(db, client_id=client.id, since=now - timedelta(days=7), until=now + timedelta(minutes=1))

    by_id = {r["bot_id"]: r for r in rows}
    assert by_id[bot_a.id]["credits_spent"] == 30
    assert by_id[bot_b.id]["credits_spent"] == 12
    assert by_id[bot_a.id]["bot_name"] == "Client A"


def test_rollup_excludes_other_clients(db):
    mine = Client(email="mine@example.com", hashed_password="x", api_key="k-rollup-2")
    theirs = Client(email="theirs@example.com", hashed_password="x", api_key="k-rollup-3")
    db.add_all([mine, theirs])
    db.flush()

    their_bot = Bot(client_id=theirs.id, name="Not Mine", bot_key="bot-ccc")
    db.add(their_bot)
    db.flush()

    now = datetime.now(UTC)
    db.add(CreditLedger(client_id=theirs.id, bot_id=None, attributed_bot_id=their_bot.id,
                        delta=-99, reason="ai_chat", created_at=now))
    db.flush()

    rows = get_per_bot_rollup(db, client_id=mine.id, since=now - timedelta(days=7), until=now + timedelta(minutes=1))
    assert rows == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_reporting_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.reporting_service'`

- [ ] **Step 3: Write the service**

Create `api/app/services/reporting_service.py`:

```python
"""Per-bot reporting rollups.

An agency on Enterprise runs many client sites from one account with a shared
credit pool. Pooled ledger rows carry ``bot_id = NULL`` (that is how the shared
balance works), so consumption is grouped by ``attributed_bot_id`` instead.

Consumption = negative deltas on metered reasons only. Grants, monthly resets,
top-ups, refunds and manual adjustments are NOT consumption and are excluded,
so the numbers match what the customer sees on the Usage page.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Bot, ChatSession, CreditLedger, LeadInfo

# Mirrors the consumption reasons used by the /credits/daily trend series.
_CONSUMPTION_REASONS = ("ai_chat", "url_scan", "email_send", "document_upload",
                        "email_verification", "company_name")


def get_per_bot_rollup(
    session: Session,
    *,
    client_id: int,
    since: datetime,
    until: datetime,
) -> list[dict[str, Any]]:
    """Return one row per bot owned by ``client_id`` with activity in range.

    Bots with no activity in the window are omitted. Callers that need every
    bot listed should left-join against the account's bot list themselves.
    """
    credits = dict(
        session.execute(
            select(
                CreditLedger.attributed_bot_id,
                func.coalesce(func.sum(-CreditLedger.delta), 0),
            )
            .where(
                CreditLedger.client_id == client_id,
                CreditLedger.attributed_bot_id.is_not(None),
                CreditLedger.delta < 0,
                CreditLedger.reason.in_(_CONSUMPTION_REASONS),
                CreditLedger.created_at >= since,
                CreditLedger.created_at <= until,
            )
            .group_by(CreditLedger.attributed_bot_id)
        ).all()
    )

    conversations = dict(
        session.execute(
            select(ChatSession.bot_id, func.count(ChatSession.id))
            .join(Bot, Bot.id == ChatSession.bot_id)
            .where(Bot.client_id == client_id, ChatSession.created_at >= since, ChatSession.created_at <= until)
            .group_by(ChatSession.bot_id)
        ).all()
    )

    leads = dict(
        session.execute(
            select(ChatSession.bot_id, func.count(LeadInfo.id))
            .join(ChatSession, ChatSession.id == LeadInfo.session_id)
            .join(Bot, Bot.id == ChatSession.bot_id)
            .where(Bot.client_id == client_id, LeadInfo.created_at >= since, LeadInfo.created_at <= until)
            .group_by(ChatSession.bot_id)
        ).all()
    )

    active_ids = set(credits) | set(conversations) | set(leads)
    if not active_ids:
        return []

    names = dict(
        session.execute(
            select(Bot.id, Bot.name).where(Bot.client_id == client_id, Bot.id.in_(active_ids))
        ).all()
    )

    rows = [
        {
            "bot_id": bot_id,
            "bot_name": names.get(bot_id, "Deleted agent"),
            "credits_spent": int(credits.get(bot_id, 0)),
            "conversations": int(conversations.get(bot_id, 0)),
            "leads": int(leads.get(bot_id, 0)),
        }
        for bot_id in active_ids
        if bot_id in names  # drop bots belonging to another client
    ]
    rows.sort(key=lambda r: r["credits_spent"], reverse=True)
    return rows
```

If `LeadInfo` has no `created_at` column, use `ChatSession.created_at` for the lead window instead and adjust the test comment accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_reporting_service.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/reporting_service.py api/tests/test_reporting_service.py
git commit -m "feat(reporting): per-bot rollup service"
```

---

### Task 9: Expose the rollup endpoint

**Files:**
- Modify: `api/app/api/analytics_routes.py` (append at end of file)
- Test: `api/tests/test_analytics_by_bot.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_analytics_by_bot.py`:

```python
"""GET /analytics/by-bot — the multi-client reporting table.

Available on every tier. An account with one bot gets a one-row table; an
agency on Enterprise gets one row per client site.
"""

from __future__ import annotations

import inspect

from app.api import analytics_routes


def test_by_bot_route_is_registered():
    source = inspect.getsource(analytics_routes)
    assert '@router.get("/by-bot")' in source


def test_by_bot_uses_the_reporting_service():
    source = inspect.getsource(analytics_routes)
    assert "get_per_bot_rollup" in source
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_analytics_by_bot.py -v`
Expected: FAIL on the first assertion

- [ ] **Step 3: Add the endpoint**

Append to `api/app/api/analytics_routes.py`:

```python
@router.get("/by-bot")
def get_per_bot_report(
    days: int = Query(30, ge=1, le=365, description="Window length in days, ending now"),
    auth: dict = Depends(get_current_client_or_operator),
):
    """One row per AI agent: credits spent, conversations, leads.

    Available on every plan. Accounts with a single agent get a single row;
    agencies on Enterprise get one row per client site, all drawing on the
    same shared credit pool.
    """
    from datetime import UTC, datetime, timedelta

    from app.services.reporting_service import get_per_bot_rollup

    until = datetime.now(UTC)
    since = until - timedelta(days=days)
    try:
        with get_session() as session:
            rows = get_per_bot_rollup(session, client_id=auth["client_id"], since=since, until=until)
        return {
            "since": since.isoformat(),
            "until": until.isoformat(),
            "rows": rows,
            "totals": {
                "credits_spent": sum(r["credits_spent"] for r in rows),
                "conversations": sum(r["conversations"] for r in rows),
                "leads": sum(r["leads"] for r in rows),
            },
        }
    except Exception as e:
        logger.error(f"Failed to build per-bot report: {e}")
        raise HTTPException(status_code=500, detail="Failed to load the report.") from e
```

- [ ] **Step 4: Run test and smoke the endpoint**

```bash
cd api && uv run pytest tests/test_analytics_by_bot.py -v
curl -s -H "X-API-Key: $DEV_API_KEY" "localhost:8000/analytics/by-bot?days=30" | python3 -m json.tool
```

Expected: 2 passed; JSON with `rows` and `totals`.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/analytics_routes.py api/tests/test_analytics_by_bot.py
git commit -m "feat(reporting): GET /analytics/by-bot rollup endpoint"
```

---

### Task 10: CSV export

**Why:** Agencies forward these numbers to their clients. Export covers the need without building a white-labelled share link.

**Files:**
- Modify: `api/app/api/analytics_routes.py`
- Test: `api/tests/test_analytics_by_bot.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_analytics_by_bot.py`:

```python
def test_csv_export_route_is_registered():
    source = inspect.getsource(analytics_routes)
    assert '@router.get("/by-bot.csv")' in source
    assert "text/csv" in source
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_analytics_by_bot.py::test_csv_export_route_is_registered -v`
Expected: FAIL

- [ ] **Step 3: Add the export endpoint**

Append to `api/app/api/analytics_routes.py`:

```python
@router.get("/by-bot.csv")
def export_per_bot_report_csv(
    days: int = Query(30, ge=1, le=365),
    auth: dict = Depends(get_current_client_or_operator),
):
    """The per-bot report as CSV, for forwarding to clients."""
    import csv
    import io
    from datetime import UTC, datetime, timedelta

    from fastapi.responses import StreamingResponse

    from app.services.reporting_service import get_per_bot_rollup

    until = datetime.now(UTC)
    since = until - timedelta(days=days)
    with get_session() as session:
        rows = get_per_bot_rollup(session, client_id=auth["client_id"], since=since, until=until)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["AI agent", "Conversations", "Leads", "Credits used"])
    for row in rows:
        writer.writerow([row["bot_name"], row["conversations"], row["leads"], row["credits_spent"]])
    buffer.seek(0)

    filename = f"oyechats-report-{since.date()}-to-{until.date()}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
```

- [ ] **Step 4: Run test and smoke it**

```bash
cd api && uv run pytest tests/test_analytics_by_bot.py -v
curl -s -H "X-API-Key: $DEV_API_KEY" "localhost:8000/analytics/by-bot.csv?days=30"
```

Expected: 3 passed; CSV rows on stdout.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/analytics_routes.py api/tests/test_analytics_by_bot.py
git commit -m "feat(reporting): CSV export for the per-bot report"
```

---

### Task 11: Reports page in the admin dashboard

**Files:**
- Create: `app/src/pages/Reports.jsx`
- Modify: `app/src/App.jsx` (add the route)

- [ ] **Step 1: Create the page**

Create `app/src/pages/Reports.jsx`:

```jsx
import { useEffect, useState } from 'react';

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

export default function Reports() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/analytics/by-bot?days=${days}`, {
      headers: { 'X-API-Key': localStorage.getItem('apiKey') || '' },
    })
      .then((r) => {
        if (!r.ok) throw new Error('Could not load the report.');
        return r.json();
      })
      .then((json) => !cancelled && setData(json))
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [days]);

  return (
    <div className="reports-page">
      <header>
        <h1>Reports</h1>
        <div role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} aria-pressed={days === r.days}>
              {r.label}
            </button>
          ))}
        </div>
        <a href={`/analytics/by-bot.csv?days=${days}`} download>Download CSV</a>
      </header>

      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading…</p>}

      {data && data.rows.length === 0 && (
        <p>No activity in this period. Once your agents start conversations, they will appear here.</p>
      )}

      {data && data.rows.length > 0 && (
        <table>
          <caption>Activity per AI agent, last {days} days</caption>
          <thead>
            <tr>
              <th scope="col">AI agent</th>
              <th scope="col">Conversations</th>
              <th scope="col">Leads</th>
              <th scope="col">Credits used</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.bot_id}>
                <td>{row.bot_name}</td>
                <td>{row.conversations.toLocaleString()}</td>
                <td>{row.leads.toLocaleString()}</td>
                <td>{row.credits_spent.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td>{data.totals.conversations.toLocaleString()}</td>
              <td>{data.totals.leads.toLocaleString()}</td>
              <td>{data.totals.credits_spent.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
```

Match the surrounding codebase for the API client and auth header — if `app/src/services/api.js` exposes a helper, use it instead of raw `fetch`.

- [ ] **Step 2: Register the route**

In `app/src/App.jsx`, add the import alongside the other page imports and a route alongside the others:

```jsx
import Reports from './pages/Reports';
```

```jsx
<Route path="/reports" element={<Reports />} />
```

- [ ] **Step 3: Verify in the browser**

```bash
cd app && npm run dev
```

Open `http://localhost:5174/reports`. Expected: the table renders with one row per agent, the range buttons refetch, and Download CSV returns a file.

- [ ] **Step 4: Run the frontend gates**

```bash
cd app && npm run lint && npm run build
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/Reports.jsx app/src/App.jsx
git commit -m "feat(app): per-agent Reports page with CSV export"
```

---

## Pre-merge checklist

- [ ] `cd api && uv run ruff check . && uv run ruff format . && uv run pytest`
- [ ] `cd app && npm run lint && npm run build`
- [ ] `git branch --show-current` outputs `development`
- [ ] `docs/billing/razorpay-plan-ids.md` lists Enterprise IDs for both Test and Live
- [ ] Task 6 migration applied to the dev database before any Enterprise account is created

## Deliberately out of scope

- **White-labelled client-facing report links.** CSV export covers the need. Revisit if agencies ask.
- **Unanswered-questions in the rollup.** `/analytics/unanswered-questions` already exists and is bot-scoped; wire it into the Reports page as a second panel once the table is proven.
- **Per-client credit budgets.** An agency may eventually want to cap what one client site can spend from the shared pool. Real demand should drive that, not speculation.

---

## Phase C — Agent switcher & gating (added after code review)

**Context from the code, not the docs.** `shell/TopBar.tsx` already renders `<WorkspaceSwitcher />` and `<BotSwitcher />` immediately before `<Breadcrumbs />`, so the control is in the right place already. Routes are agent-scoped at `/agents/:agentId/<tab>` (`app/routes.tsx:108`), and `context/AgentContext.tsx:42` resolves the active agent from the **URL param**, not from `BotContext.selectedBot`.

That mismatch is a live bug, and two more gaps appear at agency scale. These three tasks make the switcher work for an Enterprise account with many client sites.

---

### Task 12: Switching agents must navigate, preserving the current tab

**The bug:** `BotContext.selectBot` (`app/src/context/BotContext.jsx:133`) only calls `setSelectedBot` and `persistBotId` — it never navigates. On any `/agents/:agentId/*` route, `AgentContext` keeps resolving the agent from the unchanged URL. The switcher chip updates to "Beta" while the page still shows Acme. On agent-scoped routes the switcher is currently cosmetic.

**Files:**
- Modify: `app/src/shell/BotSwitcher.tsx` (the `handleSelect` callback, around line 25)

- [ ] **Step 1: Reproduce the bug in the browser**

```bash
cd app && npm run dev
```

Open `http://localhost:5174/agents/<id>/analytics` on an account with two or more agents. Pick a different agent in the top-bar switcher.
Expected (broken): the chip label changes, the URL stays on the old `:agentId`, and the page content does not change.

- [ ] **Step 2: Make the switcher navigate**

In `app/src/shell/BotSwitcher.tsx`, add the router imports at the top:

```tsx
import { useLocation, useNavigate, useParams } from 'react-router-dom';
```

Inside the component, above `handleSelect`:

```tsx
  const navigate = useNavigate();
  const location = useLocation();
  const { agentId } = useParams<{ agentId: string }>();
```

Then replace the body of `handleSelect` with:

```tsx
  const handleSelect = useCallback(
    (bot: Bot, close: () => void) => {
      close();
      // No-op when the user picks what's already selected - avoids a needless
      // rerender + persistence write and keeps the popover feel snappy.
      if (bot.id === selectedBot?.id) return;
      selectBot(bot);

      // Agent-scoped routes resolve the active agent from `:agentId` in the
      // URL (AgentContext), NOT from BotContext.selectedBot. Without this the
      // chip updates but the page keeps rendering the previous agent. Swap the
      // id in place so the user stays on the same tab - an agency comparing
      // Analytics across client sites should not be bounced to Overview.
      if (agentId) {
        const next = location.pathname.replace(
          new RegExp(`^/agents/${agentId}(?=/|$)`),
          `/agents/${bot.id}`,
        );
        if (next !== location.pathname) navigate(next + location.search);
      }
    },
    [selectBot, selectedBot, agentId, location.pathname, location.search, navigate],
  );
```

- [ ] **Step 3: Verify the fix in the browser**

Reload `http://localhost:5174/agents/<id>/analytics` and switch agents.
Expected: the URL becomes `/agents/<other-id>/analytics`, the page re-renders with the new agent's data, and you stay on the Analytics tab.

Then switch agents from a non-agent-scoped page such as `/reports`.
Expected: no navigation, the chip updates, and workspace-level pages continue to use `selectedBot` as before.

- [ ] **Step 4: Run the frontend gates**

```bash
cd app && npm run lint && npm run build
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/shell/BotSwitcher.tsx
git commit -m "fix(shell): agent switcher navigates and preserves the current tab"
```

---

### Task 13: Make the switcher searchable

**Why:** `BotSwitcher.tsx:75` renders `bots.map(...)` with no filter, inside a `max-h-80` scroll area. That is fine for three agents and unusable for an agency with forty client sites. Enterprise sells unlimited agents, so the switcher has to scale with it.

**Files:**
- Modify: `app/src/shell/BotSwitcher.tsx`

- [ ] **Step 1: Add filter state**

Inside the component, alongside the other hooks:

```tsx
  const [query, setQuery] = useState('');

  const visibleBots = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter((bot) => {
      const name = (bot.name || `Agent #${bot.id}`).toLowerCase();
      const key = (bot.bot_key || '').toLowerCase();
      return name.includes(q) || key.includes(q);
    });
  }, [bots, query]);
```

Add `useState` and `useMemo` to the existing `react` import if they are not already there.

- [ ] **Step 2: Render the search box above the list**

Replace the popover body — the block starting `<p className="px-3 pb-1 pt-2 ...">Switch agent</p>` — with:

```tsx
        <div>
          <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Switch agent
          </p>
          {bots.length > 7 && (
            <div className="px-2 pb-1">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
                autoFocus
                className="h-8 w-full rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg)] px-2 text-[13px] text-[var(--ds-text)] placeholder:text-[var(--ds-text-subtle)]"
              />
            </div>
          )}
          <div className="max-h-80 overflow-y-auto p-1">
            {visibleBots.length === 0 && (
              <p className="px-3 py-4 text-center text-[13px] text-[var(--ds-text-subtle)]">
                No agents match “{query}”.
              </p>
            )}
            {visibleBots.map((bot) => (
              <BotOption
                key={bot.id}
                logo={bot.bot_logo}
                avatarType={bot.avatar_type}
                orbColor={bot.orb_color}
                primaryColor={bot.primary_color}
                label={bot.name || `Agent #${bot.id}`}
                sublabel={bot.bot_key ?? undefined}
                active={selectedBot?.id === bot.id}
                onSelect={() => handleSelect(bot, close)}
              />
            ))}
          </div>
        </div>
```

The `bots.length > 7` guard keeps the control out of the way for ordinary accounts and only appears when the list is long enough to need it.

- [ ] **Step 3: Clear the query when the popover closes**

So a stale filter is not waiting on the next open, reset inside `handleSelect` right after `close()`:

```tsx
      close();
      setQuery('');
```

- [ ] **Step 4: Verify in the browser**

Open the switcher on an account with more than seven agents.
Expected: a search box appears and is focused; typing narrows the list; a non-matching query shows the empty message; picking an agent closes the popover and clears the query. On an account with two or three agents, no search box appears.

- [ ] **Step 5: Run the frontend gates**

```bash
cd app && npm run lint && npm run build
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell/BotSwitcher.tsx
git commit -m "feat(shell): searchable agent switcher for large accounts"
```

---

### Task 14: Gate agent creation in the UI

**Why:** Task 3 adds the server-side 403, but no UI anywhere reads `limits.bots` — a grep across `app/src` for a bots limit returns nothing. Without this the user fills in the whole create-agent form and only then hits a server error, which reads as a bug rather than a plan boundary.

**Files:**
- Modify: the page holding the create-agent entry point. Find it with:
  `grep -rln "New agent\|Create agent\|New Agent" app/src --include="*.tsx" --include="*.jsx"`

- [ ] **Step 1: Read the entitlements hook**

```bash
sed -n '1,60p' app/src/hooks/useEntitlements.ts
```

Note the exact shape it returns — the next step needs the real property name for limits (`limits.bots`) rather than an assumed one.

- [ ] **Step 2: Add the gate to the create-agent control**

In the component that renders the create-agent button:

```tsx
import { useEntitlements } from '../../hooks/useEntitlements';
import { useBotContext } from '../../context/BotContext';

// inside the component:
const { limits } = useEntitlements();
const { bots } = useBotContext();

const botLimit = limits?.bots ?? 1;
const atAgentLimit = botLimit !== -1 && bots.length >= botLimit;  // -1 is UNLIMITED
```

Then on the button:

```tsx
<Button
  onClick={handleCreateAgent}
  disabled={atAgentLimit}
  title={
    atAgentLimit
      ? `Your plan includes ${botLimit} AI agent${botLimit === 1 ? '' : 's'}. Upgrade to Enterprise for unlimited agents.`
      : undefined
  }
>
  New agent
</Button>
{atAgentLimit && (
  <p className="mt-2 text-[13px] text-[var(--ds-text-subtle)]">
    You have used all {botLimit} agent{botLimit === 1 ? '' : 's'} on your plan.{' '}
    <Link to="/workspace/billing">Upgrade to Enterprise</Link> for unlimited agents.
  </p>
)}
```

Match the surrounding file's own button component and link target rather than importing a different one — check what the neighbouring controls use.

- [ ] **Step 3: Verify both states in the browser**

On a Free or Starter account that already has its one agent: the button is disabled and the upgrade copy shows.
On an account whose plan has `bots: -1`: the button is enabled regardless of how many agents exist.

To test the unlimited path locally, seed the Enterprise plan and attach it to your dev account:

```bash
cd api && uv run python scripts/seed_plans.py --apply
```

- [ ] **Step 4: Run the frontend gates**

```bash
cd app && npm run lint && npm run build
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add app/src
git commit -m "feat(agents): gate agent creation on the plan limit"
```

---

## Phase C verification

- [ ] Switching agents on `/agents/:agentId/analytics` lands on the same tab for the new agent
- [ ] Switching agents on `/reports` does not navigate
- [ ] Search appears above seven agents, hidden below
- [ ] Create-agent is disabled at the limit and enabled when `bots: -1`
- [ ] `cd app && npm run lint && npm run build` clean
