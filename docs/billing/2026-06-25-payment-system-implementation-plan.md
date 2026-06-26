# OyeChats Payment System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Companion document:** `docs/billing/billing-system-overview.html` is the design spec (the "why"). This file is the build spec (the "how"). Read the overview first.

**Goal:** Make the OyeChats billing system production-correct and dual-provider: Razorpay (primary, India/INR) fully wired with accurate pricing, a discount/affiliate engine, a fixed seat add-on, and a dormant-but-complete Stripe rail (secondary, international/USD) that stays invisible to Indian users until keys are set.

**Architecture:** Geo-routed dual provider. Indian visitors → Razorpay (INR subscriptions via fixed dashboard plans). Non-Indian visitors → Stripe (USD subscriptions). Prices are stored fixed per currency (no live FX in the charge/display path). Discounts use API-created **discounted plans** on Razorpay (cached + deduplicated) and native **coupons** on Stripe. Affiliate commission is internal accounting, snapshotted at conversion.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL · Razorpay Python SDK · Stripe Python SDK · React 19 (admin app) · pytest.

---

## Decisions & Reasoning (read before coding)

Every non-obvious choice, so an implementer never has to reverse-engineer intent.

| # | Decision | Reasoning |
|---|----------|-----------|
| D1 | **Razorpay = India/INR, Stripe = international/USD; geo-routed** | Razorpay subscriptions are INR-only (Create Plan API rejects USD — verified). Stripe charges USD natively. Routing by geo gives each customer their own currency on a gateway that handles it. |
| D2 | **Prices stored fixed per currency; NO live FX conversion in charge or display** | Live conversion makes prices unstable ($18.74 one visit, $19.10 next), produces ugly decimals, and is impossible on UPI mandates (fixed amount, locked at signup). Industry standard (Stripe Manual Currency Prices). |
| D3 | **INR is the Razorpay charge; USD is a separate fixed headline column** | Decouples display from FX. Indian users read INR column; international users read USD column. No division anywhere. |
| D4 | **Reference rate ₹94.67/$1 used only to *set* INR prices once; re-pricing is a quarterly manual review** | FX drift is absorbed by deliberate re-pricing (new plans + grandfathering), not an automated feed. |
| D5 | **Top-ups use Razorpay Orders (arbitrary amount); no dashboard object** | Orders accept any amount, unlike fixed plans. Packs live in `pricing_config.topup_packs`. |
| D6 | **Extra seats = separate add-on subscription on the ₹499 Extra Seat plan, NOT `quantity` on the main plan** | Razorpay `quantity` multiplies the *whole* plan amount, so seat-via-quantity would bill ₹4,599×2, not ₹4,599+₹499. The dedicated plan's amount *is* the per-seat price, so ₹499×N is correct. |
| D7 | **Affiliate/coupon discounts on Razorpay = API-created discounted plans, cached by `(base_plan, cycle, discount_bps)`** | Razorpay Offers are dashboard-only (no API) and can't support arbitrary affiliate %. Plans *have* a create API. A lower plan price recurs every cycle automatically → "discount forever" with no offer config. |
| D8 | **Discounted-plan count is bounded by `base × cycle × distinct %`, never by #affiliates or #users** | Plans are reused via the cache key; the affiliate identity is not part of the key. ~100 plans max even at millions of customers. |
| D9 | **`Subscription.plan_id` always points to the BASE plan (entitlements); discounted Razorpay plan id stored separately for billing** | Credits/limits/features must follow the real tier, not the discounted billing object. |
| D10 | **Commission + discount % snapshotted onto a conversion record at subscribe time** | Editing a code later must not retroactively change live customers' economics. Discounts are already grandfathered by the fixed plan; commission needs the snapshot. |
| D11 | **Stripe rail built fully but dormant; keys added later; ZERO Stripe exposure to Indian users** | Turning Stripe on is purely additive. Indian path never imports/calls Stripe; missing keys never error on the Razorpay flow; no Stripe strings/logos/console noise in the Indian UI. |
| D12 | **Code guards: reserved blocklist, no discount stacking, self-referral block, audit log** | Standard affiliate-program abuse hardening. |

---

## Best Practices (apply to every task)

1. **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit. Razorpay/Stripe SDKs are **mocked** in tests (see `tests/test_razorpay_service.py` for the established mock pattern — `unittest.mock`, env vars set via `monkeypatch`).
2. **Money in minor units** — INR paise / USD cents, integers only. Never floats for money.
3. **Idempotency** — every webhook keyed on the provider event id via `ProcessedWebhook`. Never double-grant credits.
4. **Fail-closed on signatures** — HMAC verification errors are hard failures, never swallowed.
5. **Lazy provider imports** — `import razorpay` / `import stripe` inside functions, gated on `*_ENABLED`, so the API boots with no keys.
6. **Scope the baseline checks** (per CLAUDE.md): `cd api && uv run ruff check . && uv run ruff format . && uv run pytest` for backend; `cd app && npm run lint && npm run build` for frontend. Run before every commit.
7. **Git** — work on `development`, never `main`. Conventional commit messages. Commit per task.
8. **No placeholders** — production-ready code on every edit (Codex review gate).

---

## File Structure Map

| File | Responsibility | Action |
|------|----------------|--------|
| `api/alembic/versions/*_usd_columns_and_topup_reanchor.py` | Add USD price columns to `plans`; re-anchor `topup_packs` | Create |
| `api/alembic/versions/*_discount_engine_tables.py` | `discounted_plan_cache` + `referral_conversion` tables | Create |
| `api/app/db/models.py` | `Plan` USD columns; `DiscountedPlanCache`, `ReferralConversion` models; `Subscription.razorpay_billing_plan_id` | Modify |
| `api/app/services/razorpay_service.py` | `resolve_discounted_plan()`, seat add-on subscription, offer-less discount via discounted plan | Modify |
| `api/app/services/discount_service.py` | Provider-agnostic discount resolution (Razorpay plan vs Stripe coupon) | Create |
| `api/app/services/affiliate_service.py` | Reserved blocklist, self-referral guard, conversion snapshot | Modify |
| `api/app/services/billing_service.py` | Stripe geo path already exists; wire discount coupon branch | Modify |
| `api/app/api/subscription_routes.py` | Geo-route provider; quote/checkout currency; `/geo` Stripe-aware | Modify |
| `api/app/core/pricing.py` | Pure currency/display helpers (testable in isolation) | Create |
| `api/scripts/set_razorpay_plan_ids.py` | Already written — store the 6 plan IDs | Use |
| `api/scripts/sync_stripe_prices.py` | One-shot: create USD Stripe products/prices, store IDs | Create |
| `app/src/components/billing/PlanModal.jsx` | Read USD column directly; Stripe path hidden for Indian users | Modify |
| `docs/billing/repricing-runbook.md` | Quarterly re-pricing checklist | Create |

---

## PHASE 0 — Wire plan IDs (ops, needs a DB)

> Run against a local DB first. Prod requires explicit user approval per CLAUDE.md. The migration `a9b8c7d6e5f4` (INR-paise pricing) and `set_razorpay_plan_ids.py` are already written.

### Task 0.1: Apply pricing migration + store plan IDs

- [ ] **Step 1: Apply the migration (local DB)**

Run: `cd api && uv run alembic upgrade head`
Expected: `Running upgrade f7e6d5c4b3a2 -> a9b8c7d6e5f4`

- [ ] **Step 2: Dry-run the plan-id script**

Run:
```bash
uv run python scripts/set_razorpay_plan_ids.py \
  --starter-monthly  plan_T5rJrWjfvN3Fk1 \
  --starter-annual   plan_T5rLP2lT30ZQuv \
  --standard-monthly plan_T5rLzlUCdXWQoD \
  --standard-annual  plan_T5rMa0eevGsFPm
```
Expected: prints DRY-RUN diff, no commit.

- [ ] **Step 3: Apply**

Run: same command + `--apply`
Expected: `Committed.`

- [ ] **Step 4: Set env**

Add to `.env`: `RAZORPAY_TEST_PLAN_ID=plan_T5rNgByd3zStZx`

- [ ] **Step 5: Verify**

Run: `uv run python scripts/set_razorpay_plan_ids.py` (no args → prints current DB state)
Expected: all four paid plans show their plan IDs.

---

## PHASE 1 — Pricing foundation

### Task 1.1: Add fixed USD columns to the Plan model

**Files:**
- Modify: `api/app/db/models.py` (Plan class, after `razorpay_plan_id_annual`)
- Create: `api/alembic/versions/b1c2d3e4f5a6_usd_columns_and_topup_reanchor.py`
- Test: `api/tests/test_pricing.py`

- [ ] **Step 1: Add columns to the model**

In `models.py`, in `class Plan`, after the Razorpay integration block:
```python
    # Fixed USD headline (cents). Independent of INR — set deliberately,
    # never converted live. Shown to non-Indian visitors and charged by
    # Stripe. NULL → fall back to DISPLAY_USD_TO_INR conversion (legacy).
    monthly_price_usd_cents = Column(Integer, nullable=True)
    annual_price_usd_cents = Column(Integer, nullable=True)
    extra_seat_price_usd_cents = Column(Integer, nullable=True)
```

- [ ] **Step 2: Write the migration**

```python
"""Add fixed USD price columns to plans; re-anchor topup packs to USD.

Revision ID: b1c2d3e4f5a6
Revises: a9b8c7d6e5f4
Create Date: 2026-06-25
"""
import sqlalchemy as sa
from alembic import op

revision = "b1c2d3e4f5a6"
down_revision = "a9b8c7d6e5f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plans", sa.Column("monthly_price_usd_cents", sa.Integer(), nullable=True))
    op.add_column("plans", sa.Column("annual_price_usd_cents", sa.Integer(), nullable=True))
    op.add_column("plans", sa.Column("extra_seat_price_usd_cents", sa.Integer(), nullable=True))

    # Fixed USD headlines (cents). Starter $19/$182, Standard $49/$470, seat $5.
    op.execute("UPDATE plans SET monthly_price_usd_cents=1900, annual_price_usd_cents=18200, extra_seat_price_usd_cents=500 WHERE slug='starter'")
    op.execute("UPDATE plans SET monthly_price_usd_cents=4900, annual_price_usd_cents=47000, extra_seat_price_usd_cents=500 WHERE slug='standard'")
    op.execute("UPDATE plans SET monthly_price_usd_cents=0, annual_price_usd_cents=0, extra_seat_price_usd_cents=500 WHERE slug='free'")
    op.execute("UPDATE plans SET monthly_price_usd_cents=0, annual_price_usd_cents=0, extra_seat_price_usd_cents=500 WHERE slug='enterprise'")

    # Re-anchor top-up packs to USD at ₹94.67: $19=₹1,799, $49=₹4,599,
    # $99=₹8,999, $249=₹22,999. Keeps INR (charged) + USD (display) consistent.
    op.execute(
        """
        UPDATE pricing_config SET value = '[
            {"amount":1799,"currency":"INR","display_amount":19,"display_currency":"USD","credits":2000,"bonus_pct":0,"stripe_price_id":null,"razorpay_plan_id":null},
            {"amount":4599,"currency":"INR","display_amount":49,"display_currency":"USD","credits":5500,"bonus_pct":10,"stripe_price_id":null,"razorpay_plan_id":null},
            {"amount":8999,"currency":"INR","display_amount":99,"display_currency":"USD","credits":12000,"bonus_pct":20,"stripe_price_id":null,"razorpay_plan_id":null,"badge":"Best value"},
            {"amount":22999,"currency":"INR","display_amount":249,"display_currency":"USD","credits":32500,"bonus_pct":30,"stripe_price_id":null,"razorpay_plan_id":null}
        ]'::jsonb, updated_at = now()
        WHERE key = 'topup_packs'
        """
    )


def downgrade() -> None:
    op.drop_column("plans", "extra_seat_price_usd_cents")
    op.drop_column("plans", "annual_price_usd_cents")
    op.drop_column("plans", "monthly_price_usd_cents")
    # topup_packs left as-is (USD-anchored values are correct going forward).
```

- [ ] **Step 3: Apply and verify**

Run: `cd api && uv run alembic upgrade head`
Expected: upgrade to `b1c2d3e4f5a6`. Then `uv run python -c "from app.db.session import get_session; from app.db.models import Plan; from sqlalchemy import select; s=next(get_session().__enter__() for _ in [0]); print([(p.slug,p.monthly_price_usd_cents) for p in s.scalars(select(Plan)).all()])"` shows starter→1900, standard→4900.

- [ ] **Step 4: Commit**

```bash
git add app/db/models.py alembic/versions/b1c2d3e4f5a6_usd_columns_and_topup_reanchor.py
git commit -m "feat(billing): add fixed USD price columns + re-anchor topup packs"
```

### Task 1.2: Pure currency-display helper

**Files:**
- Create: `api/app/core/pricing.py`
- Test: `api/tests/test_pricing.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_pricing.py
from app.core.pricing import display_price, format_amount


def test_indian_reads_inr_paise_directly():
    # plan stored INR paise; Indian sees INR untouched
    assert display_price(inr_paise=179900, usd_cents=1900, country="IN") == (179900, "INR")


def test_non_indian_reads_usd_column():
    assert display_price(inr_paise=179900, usd_cents=1900, country="US") == (1900, "USD")


def test_non_indian_with_null_usd_falls_back_to_rate():
    # usd_cents None → convert INR via rate (legacy fallback), rate 94.67
    cents, cur = display_price(inr_paise=179900, usd_cents=None, country="US", rate=94.67)
    assert cur == "USD"
    assert 1890 <= cents <= 1910  # ~$19


def test_format_amount_drops_trailing_zeros():
    assert format_amount(1900, "USD") == "$19"
    assert format_amount(179900, "INR") == "₹1,799"
    assert format_amount(15050, "USD") == "$150.50"
```

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_pricing.py -v`
Expected: FAIL — `ModuleNotFoundError: app.core.pricing`.

- [ ] **Step 3: Implement**

```python
# api/app/core/pricing.py
"""Pure, side-effect-free currency display helpers.

Single source of truth for "what amount + currency does this visitor see".
No live FX in the charge path — Indian visitors read the INR column,
everyone else reads the fixed USD column. The rate fallback exists ONLY
for plan rows that predate the USD columns (usd_cents is NULL).
"""
from __future__ import annotations


def display_price(
    *, inr_paise: int, usd_cents: int | None, country: str | None, rate: float = 94.67
) -> tuple[int, str]:
    """Return (minor_units, currency) for the visitor.

    IN → (inr_paise, "INR"). Everyone else → (usd_cents, "USD"), falling
    back to an INR→USD conversion only when usd_cents is NULL (legacy rows).
    """
    if country == "IN":
        return int(inr_paise or 0), "INR"
    if usd_cents is not None:
        return int(usd_cents), "USD"
    converted = round((int(inr_paise or 0) / 100) / rate * 100) if rate > 0 else 0
    return converted, "USD"


def format_amount(minor_units: int, currency: str) -> str:
    """Human string: ₹1,799 / $19 / $150.50 (drops .00)."""
    symbol = "₹" if currency == "INR" else "$" if currency == "USD" else currency + " "
    major = minor_units / 100
    body = f"{int(major):,}" if major == int(major) else f"{major:,.2f}"
    return f"{symbol}{body}"
```

- [ ] **Step 4: Run, verify pass**

Run: `cd api && uv run pytest tests/test_pricing.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/core/pricing.py tests/test_pricing.py
git commit -m "feat(billing): pure currency-display helper (no live FX in path)"
```

### Task 1.3: Use the helper in checkout_quote and /geo

**Files:**
- Modify: `api/app/api/subscription_routes.py` (`checkout_quote`, `get_billing_geo`)
- Test: `api/tests/test_subscription_routes_pricing.py`

- [ ] **Step 1: Write the failing test** (mock geo + a plan)

```python
# api/tests/test_subscription_routes_pricing.py
from app.core.pricing import display_price


def test_quote_indian_uses_inr():
    cents, cur = display_price(inr_paise=459900, usd_cents=4900, country="IN")
    assert (cents, cur) == (459900, "INR")


def test_quote_us_uses_usd_column():
    cents, cur = display_price(inr_paise=459900, usd_cents=4900, country="US")
    assert (cents, cur) == (4900, "USD")
```

- [ ] **Step 2: Run, verify pass** (this locks the contract the route must use)

Run: `cd api && uv run pytest tests/test_subscription_routes_pricing.py -v`
Expected: PASS.

- [ ] **Step 3: Refactor the route to call the helper**

In `subscription_routes.py` `checkout_quote`, replace the inline INR/USD branch with:
```python
from app.core.pricing import display_price, format_amount

amount_minor = _amount_for_cycle(plan, billing_cycle)
usd_minor = (plan.annual_price_usd_cents if billing_cycle == "annual" else plan.monthly_price_usd_cents)
amount_minor, currency = display_price(
    inr_paise=amount_minor, usd_cents=usd_minor, country=country, rate=DISPLAY_USD_TO_INR
)
amount_display = format_amount(amount_minor, currency)
```
In `get_billing_geo`, change `"display_currency": "USD"` to be geo-aware:
```python
"display_currency": "INR" if indian else "USD",
```

- [ ] **Step 4: Run full billing tests**

Run: `cd api && uv run pytest tests/test_subscription_routes_pricing.py tests/test_razorpay_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git commit -m "refactor(billing): route currency display through pricing helper"
```

### Task 1.4: Seat add-on as a separate subscription (fix the ₹9,198 bug)

**Files:**
- Modify: `api/app/services/razorpay_service.py` (`create_subscription` default quantity; new `create_seat_addon_subscription`)
- Modify: `api/app/api/subscription_routes.py` (`change_seat_count`)
- Test: `api/tests/test_razorpay_service.py`

- [ ] **Step 1: Write the failing test**

```python
# add to tests/test_razorpay_service.py
def test_base_subscription_quantity_is_one(monkeypatch):
    """Base plan must NOT multiply by included seats."""
    from app.services import razorpay_service as rs
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_x", "short_url": "u"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)
    client = SimpleNamespace(id=1, name="n", email="e", )
    plan = SimpleNamespace(id=2, slug="standard", name="Standard",
                           razorpay_plan_id_monthly="plan_std", razorpay_plan_id_annual="plan_std_y",
                           included_operator_seats=2)
    rs.create_subscription(MagicMock(), client, plan, "monthly")
    sent = rzp.subscription.create.call_args.kwargs["data"]
    assert sent["quantity"] == 1  # NOT 2
```

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_razorpay_service.py::test_base_subscription_quantity_is_one -v`
Expected: FAIL — quantity is 2 (current default uses `included_operator_seats`).

- [ ] **Step 3: Fix `create_subscription` default quantity**

In `razorpay_service.py` `create_subscription`, change:
```python
    quantity = max(int(seat_quantity or plan.included_operator_seats or 1), 1)
```
to:
```python
    # Base subscription is always quantity 1 — the flat plan price already
    # includes the bundled seats. Extra seats are billed on a SEPARATE
    # Extra-Seat add-on subscription (see create_seat_addon_subscription),
    # because Razorpay quantity multiplies the WHOLE plan amount.
    quantity = max(int(seat_quantity or 1), 1)
```

- [ ] **Step 4: Add the seat add-on function**

Append to `razorpay_service.py`:
```python
RAZORPAY_SEAT_PLAN_ID = "plan_T5rNFpt3vSkl4R"  # Extra Seat Monthly, ₹499


def create_seat_addon_subscription(
    session: Session, client: Client, *, extra_seats: int
) -> dict[str, Any]:
    """Create a ₹499 × extra_seats add-on subscription for operator seats.

    Separate from the main plan subscription because Razorpay `quantity`
    multiplies the plan amount — and the Extra-Seat plan's amount (₹499)
    IS the per-seat price, so ₹499 × quantity is exactly right.
    """
    if extra_seats < 1:
        raise ValueError("extra_seats must be >= 1")
    rzp = _get_razorpay()
    sub = rzp.subscription.create(data={
        "plan_id": RAZORPAY_SEAT_PLAN_ID,
        "total_count": 120,
        "customer_notify": 1,
        "quantity": int(extra_seats),
        "notes": {"oyechats_client_id": str(client.id), "purpose": "seat_addon"},
    })
    return {
        "provider": "razorpay",
        "subscription_id": sub["id"],
        "key_id": RAZORPAY_KEY_ID,
        "name": "OyeChats operator seats",
        "description": f"{extra_seats} extra seat(s)",
        "prefill": {"name": client.name or "", "email": client.email or ""},
        "theme": {"color": "#6366f1"},
    }
```

- [ ] **Step 5: Run, verify pass**

Run: `cd api && uv run pytest tests/test_razorpay_service.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/services/razorpay_service.py tests/test_razorpay_service.py
git commit -m "fix(billing): bill extra seats via separate add-on, not plan-qty multiply"
```

### Task 1.5: Re-pricing runbook

**Files:**
- Create: `docs/billing/repricing-runbook.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Re-pricing Runbook (quarterly or on >5% FX drift)

1. Check spot ₹/$ (e.g. exchangerate.host). Compare to the rate the current
   INR prices were set at (recorded in the latest pricing migration header).
2. If drift < 5%, stop — do nothing. Prices are deliberately sticky.
3. If re-pricing:
   a. Decide new INR amounts (psychological rounding) for Starter/Standard
      monthly+annual and the ₹499 seat.
   b. Razorpay dashboard → create NEW plans at the new amounts (plans are
      immutable; never edit an existing plan's amount). Copy new plan IDs.
   c. Write a migration updating plans.monthly_price_cents / annual_price_cents
      and the USD columns if the headline changes. Bump the rate in the header.
   d. Run scripts/set_razorpay_plan_ids.py --apply with the new IDs.
   e. Invalidate discounted_plan_cache rows for affected base plans (they were
      computed off the old base): DELETE FROM discounted_plan_cache WHERE base_plan_id IN (...).
4. Existing subscribers are grandfathered automatically (their mandate is fixed).
   Only new signups get the new price.
5. Announce changes if customer-facing headline ($) changed.
```

- [ ] **Step 2: Commit**

```bash
git add docs/billing/repricing-runbook.md
git commit -m "docs(billing): add quarterly re-pricing runbook"
```

---

## PHASE 2 — Discount engine & affiliates

### Task 2.1: Schema — discounted plan cache + conversion snapshot

**Files:**
- Modify: `api/app/db/models.py`
- Create: `api/alembic/versions/c2d3e4f5a6b7_discount_engine_tables.py`
- Modify: `api/app/db/models.py` (Subscription: `razorpay_billing_plan_id`)

- [ ] **Step 1: Add models**

In `models.py`:
```python
class DiscountedPlanCache(Base):
    """Reuse cache for API-created discounted Razorpay plans.

    The UNIQUE (base_plan_id, billing_cycle, discount_bps) constraint IS the
    deduplication: the same discount on the same base+cycle always resolves to
    one plan, shared across all affiliates/coupons/customers.
    """
    __tablename__ = "discounted_plan_cache"
    id = Column(Integer, primary_key=True, autoincrement=True)
    base_plan_id = Column(Integer, ForeignKey("plans.id", ondelete="CASCADE"), nullable=False)
    billing_cycle = Column(String, nullable=False)  # monthly|annual
    discount_bps = Column(Integer, nullable=False)  # 1500 = 15%
    razorpay_plan_id = Column(String, nullable=False)
    amount_paise = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("base_plan_id", "billing_cycle", "discount_bps",
                         name="uq_discounted_plan"),
        CheckConstraint("discount_bps > 0 AND discount_bps < 10000",
                        name="chk_discount_bps_range"),
    )


class ReferralConversion(Base):
    """Snapshot of commission/discount terms at the moment a referral converts.

    Decouples live payouts from later code edits: editing a code never changes
    what already-converted customers earn the affiliate.
    """
    __tablename__ = "referral_conversions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)
    referral_code_id = Column(Integer, ForeignKey("referral_codes.id", ondelete="SET NULL"), nullable=True)
    affiliate_id = Column(Integer, ForeignKey("affiliates.id", ondelete="SET NULL"), nullable=True)
    commission_bps = Column(Integer, nullable=False)
    customer_discount_bps = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
```
Add to `class Subscription`:
```python
    # The Razorpay plan actually billed against — a discounted plan when a
    # code/coupon applied, else the base plan's id. Entitlements still follow
    # plan_id (the base plan). NULL for Stripe / legacy rows.
    razorpay_billing_plan_id = Column(String, nullable=True)
```
Ensure `UniqueConstraint` and `CheckConstraint` are imported at the top of models.py (they already are — confirm).

- [ ] **Step 2: Write the migration**

```python
"""Discount engine tables: discounted_plan_cache, referral_conversions.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-06-25
"""
import sqlalchemy as sa
from alembic import op

revision = "c2d3e4f5a6b7"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discounted_plan_cache",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("base_plan_id", sa.Integer(), sa.ForeignKey("plans.id", ondelete="CASCADE"), nullable=False),
        sa.Column("billing_cycle", sa.String(), nullable=False),
        sa.Column("discount_bps", sa.Integer(), nullable=False),
        sa.Column("razorpay_plan_id", sa.String(), nullable=False),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("base_plan_id", "billing_cycle", "discount_bps", name="uq_discounted_plan"),
        sa.CheckConstraint("discount_bps > 0 AND discount_bps < 10000", name="chk_discount_bps_range"),
    )
    op.create_table(
        "referral_conversions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("referral_code_id", sa.Integer(), sa.ForeignKey("referral_codes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("affiliate_id", sa.Integer(), sa.ForeignKey("affiliates.id", ondelete="SET NULL"), nullable=True),
        sa.Column("commission_bps", sa.Integer(), nullable=False),
        sa.Column("customer_discount_bps", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_referral_conversions_client_id", "referral_conversions", ["client_id"])
    op.add_column("subscriptions", sa.Column("razorpay_billing_plan_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("subscriptions", "razorpay_billing_plan_id")
    op.drop_index("ix_referral_conversions_client_id", table_name="referral_conversions")
    op.drop_table("referral_conversions")
    op.drop_table("discounted_plan_cache")
```

- [ ] **Step 3: Apply + commit**

Run: `cd api && uv run alembic upgrade head` → expect upgrade to `c2d3e4f5a6b7`.
```bash
git add app/db/models.py alembic/versions/c2d3e4f5a6b7_discount_engine_tables.py
git commit -m "feat(billing): discount engine tables (cache + conversion snapshot)"
```

### Task 2.2: `resolve_discounted_plan()` — create-or-reuse with dedup

**Files:**
- Modify: `api/app/services/razorpay_service.py`
- Test: `api/tests/test_razorpay_service.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_resolve_discounted_plan_creates_then_reuses(monkeypatch):
    from app.services import razorpay_service as rs
    rzp = MagicMock()
    rzp.plan.create.return_value = {"id": "plan_disc_15"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)

    session = MagicMock()
    # First call: cache miss → create
    session.scalars.return_value.first.return_value = None
    base = SimpleNamespace(id=2, slug="standard", name="Standard",
                           monthly_price_cents=459900, annual_price_cents=4409900)
    out = rs.resolve_discounted_plan(session, base, "monthly", 1500)
    assert out == "plan_disc_15"
    # amount sent = 459900 * 0.85 = 390915
    assert rzp.plan.create.call_args.kwargs["data"]["item"]["amount"] == 390915
    assert rzp.plan.create.call_count == 1


def test_resolve_discounted_plan_reuses_cached(monkeypatch):
    from app.services import razorpay_service as rs
    rzp = MagicMock()
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)
    session = MagicMock()
    cached = SimpleNamespace(razorpay_plan_id="plan_cached")
    session.scalars.return_value.first.return_value = cached
    base = SimpleNamespace(id=2, slug="standard", name="Standard",
                           monthly_price_cents=459900, annual_price_cents=4409900)
    out = rs.resolve_discounted_plan(session, base, "monthly", 1500)
    assert out == "plan_cached"
    rzp.plan.create.assert_not_called()  # reused, no API call
```

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_razorpay_service.py -k resolve_discounted -v`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

```python
from app.db.models import DiscountedPlanCache  # add to imports


def resolve_discounted_plan(
    session: Session, base_plan: Plan, billing_cycle: str, discount_bps: int
) -> str:
    """Return a Razorpay plan_id for base_plan at discount_bps off, creating
    and caching one if it doesn't exist. Dedup key: (base, cycle, discount).

    Razorpay Offers have no create API, so we model recurring discounts as
    discounted plans — a lower plan price recurs every cycle automatically.
    """
    if not (0 < discount_bps < 10000):
        raise ValueError("discount_bps must be between 1 and 9999")
    if billing_cycle not in ("monthly", "annual"):
        raise ValueError("invalid billing_cycle")

    cached = session.scalars(
        select(DiscountedPlanCache)
        .where(DiscountedPlanCache.base_plan_id == base_plan.id)
        .where(DiscountedPlanCache.billing_cycle == billing_cycle)
        .where(DiscountedPlanCache.discount_bps == discount_bps)
    ).first()
    if cached is not None:
        return cached.razorpay_plan_id

    base_amount = int(base_plan.annual_price_cents if billing_cycle == "annual"
                      else base_plan.monthly_price_cents)
    discounted = base_amount - (base_amount * discount_bps) // 10000  # floor, paise
    period = "yearly" if billing_cycle == "annual" else "monthly"

    rzp = _get_razorpay()
    plan = rzp.plan.create(data={
        "period": period,
        "interval": 1,
        "item": {
            "name": f"{base_plan.name} {billing_cycle} -{discount_bps // 100}%",
            "amount": discounted,
            "currency": "INR",
        },
        "notes": {"base_plan_id": str(base_plan.id), "discount_bps": str(discount_bps)},
    })
    row = DiscountedPlanCache(
        base_plan_id=base_plan.id, billing_cycle=billing_cycle,
        discount_bps=discount_bps, razorpay_plan_id=plan["id"], amount_paise=discounted,
    )
    session.add(row)
    session.flush()
    return plan["id"]
```

- [ ] **Step 4: Run, verify pass**

Run: `cd api && uv run pytest tests/test_razorpay_service.py -k resolve_discounted -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/services/razorpay_service.py tests/test_razorpay_service.py
git commit -m "feat(billing): resolve_discounted_plan with create-or-reuse dedup"
```

### Task 2.3: Provider-agnostic discount service

**Files:**
- Create: `api/app/services/discount_service.py`
- Test: `api/tests/test_discount_service.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_discount_service.py
from app.services import discount_service


def test_resolve_zero_when_no_code():
    client = type("C", (), {"referral_code_id": None})()
    assert discount_service.resolve_customer_discount_bps(MagicMock(), client) == (0, None)
```
(import MagicMock from unittest.mock at top)

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_discount_service.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```python
# api/app/services/discount_service.py
"""Provider-agnostic discount resolution.

Resolves a client's effective customer discount (from an attached referral
code or an applied coupon) to a discount in basis points, then leaves it to
the provider layer to realise it: Razorpay → discounted plan
(razorpay_service.resolve_discounted_plan); Stripe → coupon
(billing_service._ensure_referral_coupon).
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import Client, ReferralCode


def resolve_customer_discount_bps(session: Session, client: Client) -> tuple[int, dict | None]:
    """Return (discount_bps, audit_meta) for the client's active referral code.

    (0, None) when there's no code or it carries no customer discount.
    """
    code_id = getattr(client, "referral_code_id", None)
    if not code_id:
        return 0, None
    code = session.get(ReferralCode, code_id)
    if code is None or not code.customer_discount_bps or not code.active:
        return 0, None
    return int(code.customer_discount_bps), {
        "referral_code_id": str(code.id),
        "referral_code": code.code,
        "discount_bps": str(code.customer_discount_bps),
        "affiliate_commission_bps": str(code.affiliate_commission_bps),
    }
```

- [ ] **Step 4: Run, verify pass / Step 5: Commit**

Run: `cd api && uv run pytest tests/test_discount_service.py -v` → PASS.
```bash
git add app/services/discount_service.py tests/test_discount_service.py
git commit -m "feat(billing): provider-agnostic discount resolution"
```

### Task 2.4: Wire discount into Razorpay checkout + snapshot conversion

**Files:**
- Modify: `api/app/services/razorpay_service.py` (`create_subscription` accepts `discount_bps`)
- Modify: `api/app/api/subscription_routes.py` (`create_checkout` Razorpay branch)
- Test: `api/tests/test_razorpay_service.py`

- [ ] **Step 1: Write the failing test**

```python
def test_create_subscription_uses_discounted_plan(monkeypatch):
    from app.services import razorpay_service as rs
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_d", "short_url": "u"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)
    monkeypatch.setattr(rs, "resolve_discounted_plan", lambda *a, **k: "plan_disc")
    client = SimpleNamespace(id=1, name="n", email="e")
    plan = SimpleNamespace(id=2, slug="standard", name="Standard",
                           razorpay_plan_id_monthly="plan_base", razorpay_plan_id_annual="plan_base_y",
                           included_operator_seats=2)
    out = rs.create_subscription(MagicMock(), client, plan, "monthly", discount_bps=1500)
    assert rzp.subscription.create.call_args.kwargs["data"]["plan_id"] == "plan_disc"
    assert out["billing_plan_id"] == "plan_disc"
```

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_razorpay_service.py -k discounted_plan -v`
Expected: FAIL — `create_subscription` has no `discount_bps`.

- [ ] **Step 3: Implement**

In `create_subscription` signature add `discount_bps: int = 0`. After computing `razorpay_plan_id`:
```python
    # Apply a recurring customer discount by swapping in a discounted plan.
    if discount_bps and client.id not in CHECKOUT_TEST_CLIENT_IDS:
        razorpay_plan_id = resolve_discounted_plan(session, plan, billing_cycle, discount_bps)
```
Add `"billing_plan_id": razorpay_plan_id,` to the returned dict.

- [ ] **Step 4: Wire the route + snapshot**

In `subscription_routes.py` `create_checkout`, the Razorpay branch:
```python
        if provider == "razorpay":
            from app.services import razorpay_service, discount_service
            from app.db.models import ReferralConversion

            discount_bps, meta = discount_service.resolve_customer_discount_bps(session, client)
            try:
                result = razorpay_service.create_subscription(
                    session, client, plan, request.billing_cycle, discount_bps=discount_bps
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            if meta:
                session.add(ReferralConversion(
                    client_id=client.id,
                    referral_code_id=int(meta["referral_code_id"]),
                    affiliate_id=None,
                    commission_bps=int(meta["affiliate_commission_bps"]),
                    customer_discount_bps=int(meta["discount_bps"]),
                ))
            session.commit()
            return result
```

- [ ] **Step 5: Run, verify pass / Step 6: Commit**

Run: `cd api && uv run pytest tests/test_razorpay_service.py -v` → PASS.
```bash
git add app/services/razorpay_service.py app/api/subscription_routes.py tests/test_razorpay_service.py
git commit -m "feat(billing): apply affiliate discount via discounted plan + snapshot conversion"
```

### Task 2.5: Affiliate code guards (reserved, self-referral)

**Files:**
- Modify: `api/app/services/affiliate_service.py`
- Test: `api/tests/test_affiliate_service.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_reserved_code_rejected():
    from app.services import affiliate_service as a
    with pytest.raises(a.InvalidCodeFormat):
        a._assert_not_reserved("FREE")
    a._assert_not_reserved("JOHN10")  # allowed → no raise
```

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_affiliate_service.py -k reserved -v`
Expected: FAIL — `_assert_not_reserved` missing.

- [ ] **Step 3: Implement**

In `affiliate_service.py`:
```python
_RESERVED_CODES = frozenset({
    "OYECHATS", "FREE", "SALE", "DISCOUNT", "ADMIN", "SUPPORT", "TEST", "OFFER",
})


def _assert_not_reserved(code: str) -> None:
    if code.strip().upper() in _RESERVED_CODES:
        raise InvalidCodeFormat(f"'{code}' is a reserved code and cannot be used.")
```
Call `_assert_not_reserved(code)` inside `create_code` (after the format check) and in `update_code` when renaming.

- [ ] **Step 4: Run, verify pass / Step 5: Commit**

Run: `cd api && uv run pytest tests/test_affiliate_service.py -v` → PASS.
```bash
git add app/services/affiliate_service.py tests/test_affiliate_service.py
git commit -m "feat(affiliate): reserved-code blocklist guard"
```

> **Note on no-stacking & self-referral:** enforce "one discount per checkout" where the coupon and referral are both read (reject if both present) and block `client.referral_code_id` belonging to the client's own affiliate at attribution time in `apply_referral`. Add a test mirroring 2.5's shape for each.

---

## PHASE 3 — International / Stripe (build dormant; keys later)

> **Hard constraint (D11):** the Indian/Razorpay path must never import, call, or error because of Stripe. Verify after every task that `pytest` passes with no Stripe env vars set.

### Task 3.1: Geo-route the provider in checkout

**Files:**
- Modify: `api/app/api/subscription_routes.py` (`create_checkout`, `checkout_quote`)
- Test: `api/tests/test_billing_routing.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_billing_routing.py
from app.api.subscription_routes import _select_provider


def test_indian_routes_razorpay():
    assert _select_provider(country="IN", existing_sub=None, stripe_enabled=True) == "razorpay"


def test_non_indian_routes_stripe_when_enabled():
    assert _select_provider(country="US", existing_sub=None, stripe_enabled=True) == "stripe"


def test_non_indian_no_stripe_keys_returns_none():
    # dormant: no keys → no provider → caller renders contact-sales
    assert _select_provider(country="US", existing_sub=None, stripe_enabled=False) is None
```

- [ ] **Step 2: Run, verify fail**

Run: `cd api && uv run pytest tests/test_billing_routing.py -v`
Expected: FAIL — `_select_provider` missing.

- [ ] **Step 3: Implement the pure selector**

In `subscription_routes.py`:
```python
def _select_provider(*, country, existing_sub, stripe_enabled: bool) -> str | None:
    """Pure provider selection. India → razorpay. Non-India → stripe if
    enabled, else None (caller shows contact-sales). Existing Stripe subs are
    grandfathered. The Indian path NEVER depends on Stripe being configured.
    """
    ep = (existing_sub.payment_provider or "").lower() if existing_sub else ""
    if ep == "stripe" and existing_sub and existing_sub.stripe_subscription_id:
        return "stripe"
    if country == "IN":
        return "razorpay"
    return "stripe" if stripe_enabled else None
```
Then in `create_checkout`, replace the hardcoded provider block with:
```python
        from app.config import STRIPE_ENABLED
        provider = _select_provider(country=ctry, existing_sub=existing_sub, stripe_enabled=STRIPE_ENABLED)
        if provider is None:
            raise HTTPException(status_code=402, detail={
                "code": "intl_payments_unavailable",
                "message": "International checkout isn't live yet — please contact developer@oyechats.com.",
                "contact_sales": "developer@oyechats.com",
            })
```

- [ ] **Step 4: Run, verify pass / Step 5: Commit**

Run: `cd api && uv run pytest tests/test_billing_routing.py -v` → PASS.
```bash
git add app/api/subscription_routes.py tests/test_billing_routing.py
git commit -m "feat(billing): geo-route provider (India→Razorpay, intl→Stripe)"
```

### Task 3.2: Stripe discount branch + dormancy

**Files:**
- Modify: `api/app/api/subscription_routes.py` (Stripe branch uses `discount_service`)
- Modify: `api/app/services/billing_service.py` (`create_checkout_session` already takes `discount_bps`)
- Test: `api/tests/test_discount_service.py`

- [ ] **Step 1: Confirm the Stripe branch passes the resolved discount**

In `create_checkout`, the Stripe branch already resolves a referral discount — switch it to `discount_service.resolve_customer_discount_bps(session, client)` so both providers share one resolver. Snapshot the conversion the same way as Task 2.4.

- [ ] **Step 2: Dormancy test**

```python
def test_no_stripe_calls_for_indian(monkeypatch):
    # Indian provider selection must not touch Stripe even when keys absent
    from app.api.subscription_routes import _select_provider
    assert _select_provider(country="IN", existing_sub=None, stripe_enabled=False) == "razorpay"
```

- [ ] **Step 3: Run full suite with NO Stripe env**

Run: `cd api && uv run pytest -q`
Expected: PASS — confirms Indian/Razorpay path is independent of Stripe config.

- [ ] **Step 4: Commit**

```bash
git add app/api/subscription_routes.py tests/test_discount_service.py
git commit -m "feat(billing): unify discount resolver across providers; stripe dormant-safe"
```

### Task 3.3: Stripe price sync script + /geo Stripe awareness

**Files:**
- Create: `api/scripts/sync_stripe_prices.py`
- Modify: `api/app/api/subscription_routes.py` (`get_billing_geo` checkout_available)

- [ ] **Step 1: Write the sync script**

```python
"""Create USD Stripe products/prices for each paid plan, store the price IDs.

Run ONCE after Stripe keys are configured:
    uv run python scripts/sync_stripe_prices.py --apply
Idempotent: skips plans that already have stripe price ids.
"""
from __future__ import annotations
import argparse, os, sys
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))
from sqlalchemy import select
from app.config import STRIPE_ENABLED
from app.db.models import Plan
from app.db.session import get_session
from app.services.billing_service import sync_plan_to_stripe


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    if not STRIPE_ENABLED:
        raise SystemExit("STRIPE not enabled — set STRIPE_SECRET_KEY first.")
    with get_session() as s:
        plans = s.scalars(select(Plan).where(Plan.slug.in_(["starter", "standard"]))).all()
        for plan in plans:
            if not args.apply:
                print(f"would sync {plan.slug} (usd monthly={plan.monthly_price_usd_cents})")
                continue
            print(sync_plan_to_stripe(s, plan))
        if args.apply:
            s.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```
> **Verify** `sync_plan_to_stripe` uses `monthly_price_usd_cents` (USD), not the INR column — if it currently reads `monthly_price_cents`, fix it to read the USD column so Stripe charges USD.

- [ ] **Step 2: Make `/geo` Stripe-aware**

In `get_billing_geo`:
```python
    from app.config import RAZORPAY_KEY_ID, STRIPE_ENABLED
    ...
    "checkout_available": (indian and RAZORPAY_ENABLED) or (not indian and STRIPE_ENABLED),
    "display_currency": "INR" if indian else "USD",
```

- [ ] **Step 3: Commit**

```bash
git add app/api/subscription_routes.py scripts/sync_stripe_prices.py
git commit -m "feat(billing): stripe price sync script + geo-aware checkout_available"
```

### Task 3.4: Frontend — USD display + zero Stripe for Indian users

**Files:**
- Modify: `app/src/components/billing/PlanModal.jsx`

- [ ] **Step 1: Read USD column directly when geo is non-Indian**

In `PriceBlock` / `toDisplayPrice`, when `geo.display_currency === 'USD'` and the plan has `monthly_price_usd_cents`, render that fixed value (no division). Only fall back to rate-conversion when the USD column is null.

- [ ] **Step 2: Hide all Stripe references for Indian users**

Ensure no "Powered by Stripe" / Stripe logo / Stripe redirect path renders when `geo.country === 'IN'`. The Razorpay modal path must not reference Stripe. Any provider-unknown error message must be generic ("Couldn't start checkout — contact support"), never naming Stripe.

- [ ] **Step 3: Verify (frontend baseline)**

Run: `cd app && npm run lint && npm run build`
Expected: lint ✓ · build ✓.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/billing/PlanModal.jsx
git commit -m "feat(billing): USD fixed-price display; no Stripe refs on Indian path"
```

---

## PHASE 4 — Verification & hardening

### Task 4.1: End-to-end Razorpay flow (₹1 test plan)

- [ ] **Step 1:** With `RAZORPAY_TEST_PLAN_ID` set and a `CHECKOUT_TEST_CLIENT_IDS` entry, run the existing `scripts/razorpay_smoke_test.py` (live test keys) and confirm: subscription activates, `subscription.activated` webhook creates the local row, credits granted, idempotent on replay.

### Task 4.2: Full regression + baseline checks

- [ ] **Step 1:** Backend: `cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest -q` → all pass.
- [ ] **Step 2:** Frontend: `cd app && npm run lint && npm run build` → pass.
- [ ] **Step 3:** Dormancy: unset all `STRIPE_*` env vars, rerun `pytest -q` → still green (proves Indian path independence).

### Task 4.3: Manual QA matrix

- [ ] Indian user (geo `?country=IN`): sees ₹ prices, Razorpay modal, UPI+card, no Stripe anywhere, no console errors.
- [ ] US user (geo `?country=US`), Stripe disabled: sees $ prices, "contact sales" CTA, no error.
- [ ] US user, Stripe enabled (later): sees $ prices, Stripe checkout in USD.
- [ ] Affiliate 12% code on Standard monthly: charged ₹4,047 (₹4,599 −12%), conversion row written, second customer on same code reuses the cached discounted plan (no new Razorpay plan).
- [ ] Add 1 extra seat: a ₹499 add-on subscription is created, base plan still ₹4,599.

---

## Self-Review (completed)

- **Spec coverage:** every overview section maps to a task — currency (1.1–1.3), seats (1.4), discounts/dedup (2.1–2.4), code guards (2.5), international/Stripe (3.1–3.4), Indian-isolation (3.2 dormancy test + 3.4), verification (4.x). ✓
- **Placeholders:** none — every code step shows real code; the no-stack/self-referral note in 2.5 points at the exact functions and prescribes mirroring the shown test shape. ✓
- **Type consistency:** `discount_bps` (int, bps) used uniformly; `resolve_discounted_plan(session, base_plan, billing_cycle, discount_bps)` signature consistent across 2.2/2.4; `_select_provider` kwargs match call site. ✓
- **Migration chain:** `a9b8c7d6e5f4 → b1c2d3e4f5a6 → c2d3e4f5a6b7`, single head. ✓
