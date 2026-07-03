# Multi-Currency Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement **Phase 1** task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Phase 2 is design-locked, not step-locked** — see the note at its head before starting it.

> **Rev 3 (2026-07-03) — model changed by CTO decision.** The product model is now **geo-split, not universal-USD**: Indian buyers see **INR everywhere and pay INR**; international buyers see **USD everywhere and pay USD** against a **separate USD plan set with independent pricing**. This *supersedes* the earlier "show $ to everyone, charge INR" approach and **eliminates the disclosure hack** from Rev 2 — display currency now equals charge currency for every buyer, which is the root-cause fix. Locked decisions: (1) **INR-flip ships first, USD rail follows**; (2) **Razorpay International Payments is already activated** on the merchant account, so the USD rail is gated only on internal work + CA sign-off, not underwriting; (3) **billing country is confirmed at checkout** and that confirmed country — not raw IP geo — is the routing key (FEMA-safe). Every Razorpay claim is cited in [Sources](#sources).

**Goal:** Give each buyer one coherent currency end-to-end — Indians in INR, international customers in USD — with the currency they *see* always equal to the currency they are *charged* and *invoiced* in.

**Architecture:** Buyer **billing country (confirmed at checkout)** is the single routing key across three layers — **display**, **charge**, **invoice**. `country == "IN"` → INR display + INR charge (UPI/card) + INR GST invoice (all shipping today). `country != "IN"` → USD display + USD charge (international card) + zero-rated USD export invoice. Phase 1 makes the Indian path fully coherent (flip display to INR, confirm country at checkout) with **no external dependency**. Phase 2 adds the international USD rail on the *same* Razorpay Subscriptions product (separate USD plans, card-only), behind a feature flag.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`api/`), React 19 + Vite (`app/`), Razorpay (INR live; International Payments activated for Phase 2), WeasyPrint invoice PDFs, pytest + ESLint.

---

## Razorpay fact-check — what is actually true

Every Razorpay claim in this plan was verified against official docs. Summary — **read before Phase 2**.

### ✅ Confirmed correct

| Claim | Verdict | Source |
| --- | --- | --- |
| A Razorpay **Plan is single-currency** (`item.currency`) → USD billing needs a separate USD plan per tier | **Correct.** | [Create a Plan API](https://razorpay.com/docs/api/payments/subscriptions/create-plan/) |
| **International recurring is card-only**; UPI/eMandate are INR-only | **Correct** — Razorpay: UPI and eMandate are *"Only INR is supported."* | [Subscriptions FAQs](https://razorpay.com/docs/payments/subscriptions/faqs/) |
| Real USD recurring is possible (160+ currencies) once International Payments is on | **Correct.** | [International Payments](https://razorpay.com/docs/payments/international-payments/) |
| International Payments needs separate account activation | **Correct** — and per CTO, **this is already activated** on the Digibranders account, so Phase 2 is not blocked on underwriting. | [International Payments](https://razorpay.com/docs/payments/international-payments/) |
| Export invoice / LUT / zero-rating | **Correct** (GST law); `api/app/core/tax.py` already models `supply_kind == "export"` + LUT. | verified in-repo |

### ❌ Corrections carried from Rev 2 (still binding on Phase 2)

1. **Settlement is always INR on the card/subscription rail** — *"Razorpay Settlements occur in INR based on the conversion rate at the time of payment"* (processing-bank rate on the capture date). There is **no original-currency/EEFC settlement** on card mandates; that is a *separate* Razorpay product (International Bank Transfer / MoneySaver Export Account, for wire transfers). Do not design any Phase-2 flow that assumes USD held in a Razorpay balance. ([Currency Conversion](https://razorpay.com/docs/payments/international-payments/currency-conversion/), [International Bank Transfer](https://razorpay.com/docs/payments/international-payments/accept-international-payments-via-local-currency-bank-accounts/))
2. **One USD charge → three different INR figures** — settlement INR (Razorpay capture-date rate), invoice INR-equivalent (RBI/GAAP rate on date of supply, Rule 34), and FIRC/e-FIRA realization INR. P2-T5 tracks all three; never assert equality.
3. **FX economics** (business sign-off before Phase 2): foreign-card MDR ~3% + forex markup vs ~2% domestic; **no RBI e-mandate/chargeback protection on foreign-issued cards**; refund FX slippage.

---

## CTO framing — read this first

**The model (locked):**

| Layer | `country == "IN"` (confirmed) | `country != "IN"` (confirmed) |
| --- | --- | --- |
| Display | **₹ INR** everywhere | **$ USD** everywhere |
| Plans | INR plan set (existing) | **Separate USD plan set, independent pricing** (Phase 2) |
| Charge | INR — UPI/card (existing) | USD — international card (Phase 2) |
| Invoice | INR GST invoice (existing) | USD export invoice, zero-rated/LUT (Phase 2) |

**What is already true in the code (do NOT rebuild):**

- **The frontend is already geo-driven.** `PlanModal.jsx`'s `PriceBlock`/`toDisplayPrice` render whatever currency `GET /subscriptions/geo` returns as `display_currency`. Today that endpoint hardcodes `"USD"` for everyone (`subscription_routes.py:343`) — so **flipping Indian buyers to INR is a backend change to `/geo`, not a UI rewrite.** `display_price` already returns INR for `country == "IN"` (`core/pricing.py:41`).
- **Charge is already INR** for the domestic path — `razorpay_service.create_subscription` bills the INR plan; `create_topup_order` hard-rejects non-INR (`razorpay_service.py:156-158`).
- **Invoice is already INR + GST** with an INR-only finalize guard (`invoice_service.py:145`), and the export/LUT branch is already modelled in `core/tax.py`.
- **Billing-country capture already exists.** `Client.billing_country` / `Client.billing_state_code` are real columns, and the billing-profile endpoint (`subscription_routes.py:536-632`) already validates a 2-letter ISO country and enforces "GSTIN ⇒ country must be IN." The checkout gate reuses this.
- **Inclusive pricing is an enforced invariant** — `seller_profile_service.py:179` rejects `price_inclusive=false`.

**Why the disclosure hack is gone:** Rev 1/Rev 2 disclosed the rupee amount *underneath a USD sticker* because display and charge currency disagreed. Under the geo-split model they always agree, so there is nothing to disclose — the mismatch is designed out, not annotated.

**Scope decision (mine, as CTO):**

- **Phase 1 ships now.** Flip Indian buyers to INR + confirm billing country at checkout. Small, no external dependency, fully coherent Indian experience. Fully specified below as TDD.
- **Phase 2 (international USD rail) follows.** International Payments is activated, so it is gated only on: USD plans created in the Razorpay dashboard with independent USD pricing, LUT filed, and CA sign-off on export invoicing. Design-locked here.
- **Interim for international buyers (Phase 1 window):** because no USD plans exist yet, a confirmed non-IN buyer sees USD prices with checkout marked **`intl_usd_pending`** (Contact-sales CTA). Phase 2 replaces that with the live USD rail. *(Assumption — flagged; adjust if you want a different interim.)*

**Out of scope** (tracked separately — invoice-structure review): statutory seller fields on the PDF, line-item Qty/Rate columns, the `developer@` support email.

---

# PHASE 1 — Indian INR coherence + confirm-country gate

**Definition of done:** A confirmed Indian buyer sees ₹ everywhere (plan selector, billing page, top-ups) and the checkout quote/charge is INR — no USD anywhere in their flow. Billing country is confirmed before payment and persisted. A confirmed non-IN buyer sees $ with checkout flagged `intl_usd_pending` (Contact sales). No UI labels a credit balance or an INR charge as "USD." Full API suite green, `app/` lints and builds.

**Branch:** `development` (never `main`).

**Test runner (backend):** `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest <path> --no-cov`
**Lint (frontend):** `cd app && npm run lint` · **Build:** `cd app && npm run build`

---

### Task 1: `/subscriptions/geo` returns INR display for Indian buyers

The whole Indian display flip hinges on this one endpoint, because the frontend renders whatever `display_currency` it returns. Make it INR for `country == "IN"`, USD otherwise.

**Files:**

- Modify: `api/app/api/subscription_routes.py` (`get_billing_geo`, ~326-349)
- Test: `api/tests/test_subscription_routes_pricing.py`

- [ ] **Step 1: Write the failing test**

```python
def test_geo_returns_inr_for_indian_buyer(client, auth_headers, monkeypatch):
    monkeypatch.setattr("app.api.subscription_routes.resolve_country", lambda request: "IN")
    res = client.get("/subscriptions/geo", headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["display_currency"] == "INR"


def test_geo_returns_usd_for_foreign_buyer(client, auth_headers, monkeypatch):
    monkeypatch.setattr("app.api.subscription_routes.resolve_country", lambda request: "US")
    res = client.get("/subscriptions/geo", headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["display_currency"] == "USD"
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py::test_geo_returns_inr_for_indian_buyer -v --no-cov`
Expected: FAIL — `assert 'USD' == 'INR'`.

- [ ] **Step 3: Make `display_currency` country-aware**

In `get_billing_geo`, replace the hardcoded currency:

```python
    country = resolve_country(request)
    # Geo-split model: Indians see and pay INR; everyone else sees (and — once
    # the Phase-2 USD rail is live — pays) USD. Display currency == charge
    # currency by design, so there is no currency mismatch to disclose.
    display_currency = "INR" if country == "IN" else "USD"
    return {
        "country": country,
        "display_currency": display_currency,
        "display_rate": DISPLAY_USD_TO_INR,
        "razorpay_enabled": RAZORPAY_ENABLED,
        "razorpay_key_id": RAZORPAY_KEY_ID if RAZORPAY_ENABLED else None,
        "checkout_available": RAZORPAY_ENABLED,
        "contact_sales_email": "developer@oyechats.com",
    }
```

- [ ] **Step 4: Run both tests and confirm they pass**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py::test_geo_returns_inr_for_indian_buyer tests/test_subscription_routes_pricing.py::test_geo_returns_usd_for_foreign_buyer -v --no-cov`
Expected: both PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd api && uv run ruff check app/api/subscription_routes.py && uv run ruff format app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git add app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git commit -m "feat(billing): geo-split display currency — INR for Indian buyers"
```

---

### Task 2: `checkout_quote` reflects the confirmed-country charge currency

The quote must stop hardcoding USD + `["card","upi"]`. For a confirmed Indian buyer it returns INR + card/upi + `checkout_supported: true`. For a confirmed non-IN buyer (Phase-1 window) it returns USD display but `checkout_supported: false` with `reason: "intl_usd_pending"` and a contact-sales email — Phase 2 flips that branch to the live USD rail. The **confirmed `billing_country` query param overrides IP geo** (FEMA-safe).

**Files:**

- Modify: `api/app/api/subscription_routes.py` (`checkout_quote`, ~665-753)
- Test: `api/tests/test_subscription_routes_pricing.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_checkout_quote_inr_for_indian_buyer(client, auth_headers, seed_plan, monkeypatch):
    monkeypatch.setattr("app.api.subscription_routes.resolve_country", lambda request: "IN")
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     monthly_price_usd_cents=1900,
                     razorpay_plan_id_monthly="plan_test_starter")
    res = client.get(
        f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly",
        headers=auth_headers,
    )
    body = res.json()
    assert body["country"] == "IN"
    assert body["currency"] == "INR"
    assert body["amount_minor"] == 179900
    assert body["amount_display"] == "₹1,799"
    assert body["methods"] == ["card", "upi"]
    assert body["checkout_supported"] is True


def test_checkout_quote_usd_pending_for_foreign_buyer(client, auth_headers, seed_plan, monkeypatch):
    # IP says US, and the confirmed billing_country agrees.
    monkeypatch.setattr("app.api.subscription_routes.resolve_country", lambda request: "US")
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     monthly_price_usd_cents=1900,
                     razorpay_plan_id_monthly="plan_test_starter")
    res = client.get(
        f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=US",
        headers=auth_headers,
    )
    body = res.json()
    assert body["currency"] == "USD"
    assert body["amount_minor"] == 1900
    assert body["methods"] == []
    assert body["checkout_supported"] is False
    assert body["reason"] == "intl_usd_pending"


def test_checkout_quote_confirmed_country_overrides_ip(client, auth_headers, seed_plan, monkeypatch):
    # IP mis-detects as US, but the buyer confirms IN — INR must win (FEMA-safe).
    monkeypatch.setattr("app.api.subscription_routes.resolve_country", lambda request: "US")
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     razorpay_plan_id_monthly="plan_test_starter")
    res = client.get(
        f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly&billing_country=IN",
        headers=auth_headers,
    )
    body = res.json()
    assert body["currency"] == "INR"
    assert body["checkout_supported"] is True
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py::test_checkout_quote_inr_for_indian_buyer tests/test_subscription_routes_pricing.py::test_checkout_quote_usd_pending_for_foreign_buyer tests/test_subscription_routes_pricing.py::test_checkout_quote_confirmed_country_overrides_ip -v --no-cov`
Expected: FAIL — the handler returns `"USD"` and `methods` unconditionally.

- [ ] **Step 3: Add the `billing_country` param and route by confirmed country**

Change the signature and the currency-selection block. Replace lines ~666-711 (signature through the USD-hardcode) with:

```python
@router.get("/checkout/quote")
def checkout_quote(
    request: Request,
    plan_id: int,
    billing_cycle: str = "monthly",
    billing_country: str | None = None,
    client: Client = Depends(get_current_client),
):
    """Single source of truth for what the checkout button will charge.

    The confirmed ``billing_country`` (from the checkout country-confirmation
    step) overrides IP geo so an Indian resident mis-detected abroad is never
    routed to USD — and vice-versa (FEMA-safe).

    Domestic (IN): currency INR, card+upi, checkout_supported=True.
    Foreign (Phase-1 window): currency USD, no methods, checkout_supported=False
    with reason="intl_usd_pending" — the live USD rail lands in Phase 2.
    """
    if billing_cycle not in ("monthly", "annual"):
        raise HTTPException(status_code=400, detail="billing_cycle must be 'monthly' or 'annual'.")

    with get_session() as session:
        from app.services.plan_service import get_plan_by_id

        plan = get_plan_by_id(session, plan_id)
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found.")
        if not plan.is_active:
            raise HTTPException(status_code=400, detail="This plan is not available.")

        detected = resolve_country(request)
        confirmed = (billing_country or "").strip().upper() or None
        country = confirmed or detected
        is_domestic = country == "IN"

        if is_domestic:
            currency = "INR"
            amount_minor = _amount_for_cycle(plan, billing_cycle)
        else:
            currency = "USD"
            usd_minor = plan.annual_price_usd_cents if billing_cycle == "annual" else plan.monthly_price_usd_cents
            amount_minor = int(usd_minor or 0)
        amount_display = format_amount(amount_minor, currency)
```

Then update the three return branches. **Free plan** and **enterprise** branches keep `checkout_supported: False` but now carry the country-correct `currency`/`amount_minor`/`amount_display`. The **final (paid) branch** becomes country-aware:

```python
        # Free plan: render a quote but mark checkout as unsupported.
        if amount_minor == 0 and plan.slug != "enterprise":
            return {
                "country": country, "currency": currency, "amount_minor": 0,
                "amount_display": amount_display, "billing_cycle": billing_cycle,
                "provider": None, "methods": [], "checkout_supported": False,
                "contact_sales": None, "reason": "free_plan",
            }

        if plan.slug == "enterprise":
            return {
                "country": country, "currency": currency, "amount_minor": amount_minor,
                "amount_display": amount_display, "billing_cycle": billing_cycle,
                "provider": None, "methods": [], "checkout_supported": False,
                "contact_sales": "developer@oyechats.com", "reason": "enterprise",
            }

        if not is_domestic:
            # Phase-1 window: USD prices shown, but USD charging ships in Phase 2.
            return {
                "country": country, "currency": currency, "amount_minor": amount_minor,
                "amount_display": amount_display, "billing_cycle": billing_cycle,
                "provider": None, "methods": [], "checkout_supported": False,
                "contact_sales": "developer@oyechats.com", "reason": "intl_usd_pending",
            }

        return {
            "country": country, "currency": currency, "amount_minor": amount_minor,
            "amount_display": amount_display, "billing_cycle": billing_cycle,
            "provider": "razorpay", "methods": list(_RAZORPAY_METHODS_INR),
            "checkout_supported": True, "contact_sales": None,
        }
```

- [ ] **Step 4: Run the three tests and confirm they pass**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_subscription_routes_pricing.py -k "checkout_quote" -v --no-cov`
Expected: all PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd api && uv run ruff check app/api/subscription_routes.py && uv run ruff format app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git add app/api/subscription_routes.py tests/test_subscription_routes_pricing.py
git commit -m "feat(billing): checkout quote routes currency by confirmed billing country"
```

---

### Task 3: Confirm billing country at checkout + gate the charge

The confirmed country decides currency, plan set, and invoice type — so it must be captured and validated *before* the mandate is authorised, and persisted for the invoice. Phase 1 charges IN only; a confirmed non-IN country returns a structured `intl_usd_pending` so the UI shows Contact-sales instead of a broken payment.

**Files:**

- Modify: `api/app/api/subscription_routes.py` (`CheckoutRequest` ~642; `create_checkout` ~756)
- Modify: `app/src/components/billing/PlanModal.jsx` (country-confirm step before opening Razorpay)
- Test: `api/tests/test_checkout_country_gate.py` (new)

- [ ] **Step 1: Write the failing backend test**

```python
def test_checkout_rejects_foreign_country_in_phase1(client, auth_headers, seed_plan):
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     razorpay_plan_id_monthly="plan_test_starter")
    res = client.post(
        "/subscriptions/checkout",
        headers=auth_headers,
        json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["reason"] == "intl_usd_pending"


def test_checkout_persists_confirmed_country(client, auth_headers, seed_plan, db):
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     razorpay_plan_id_monthly="plan_test_starter")
    # IN checkout proceeds far enough to persist the confirmed country before
    # the Razorpay call (which the test's fake client stubs — reuse the existing
    # razorpay stub fixture already used by other checkout tests in this suite).
    client.post(
        "/subscriptions/checkout",
        headers=auth_headers,
        json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "IN"},
    )
    # Reload the client row; the confirmed country is now recorded.
    from app.db.models import Client
    row = db.query(Client).first()
    assert row.billing_country == "IN"
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_checkout_country_gate.py -v --no-cov`
Expected: FAIL — `CheckoutRequest` has no `billing_country`; 422/500.

- [ ] **Step 3: Add `billing_country` to `CheckoutRequest` and gate `create_checkout`**

Extend the model (~642):

```python
class CheckoutRequest(BaseModel):
    plan_id: int
    billing_cycle: str = "monthly"  # monthly|annual
    coupon_code: str | None = None
    billing_country: str = Field(..., min_length=2, max_length=2)  # confirmed at checkout
```

In `create_checkout`, right after the `billing_cycle` validation (~767), normalise + gate + persist:

```python
    confirmed_country = request.billing_country.strip().upper()
    if confirmed_country != "IN":
        # Phase 1 charges INR only. The USD rail (Phase 2) replaces this branch.
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "intl_usd_pending",
                "message": "USD billing for international customers is coming soon. Please contact sales.",
                "contact_sales": "developer@oyechats.com",
            },
        )
```

Then inside the `with get_session()` block, after the plan is loaded and validated, persist the confirmed country on the client so the invoice routes correctly (mirrors the billing-profile endpoint's GSTIN⇒IN rule — do not overwrite a country that a GSTIN has pinned):

```python
        # Record the confirmed billing country for invoice place-of-supply.
        # A GSTIN pins the country to IN; never let checkout flip that.
        if not client.gstin:
            client.billing_country = confirmed_country
```

- [ ] **Step 4: Run backend tests and confirm they pass**

Run: `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_checkout_country_gate.py -v --no-cov`
Expected: PASS.

- [ ] **Step 5: Add the country-confirm step in `PlanModal.jsx`**

Before the code that calls `createCheckoutSession(selected.id, billingCycle)` (~line 302), require a confirmed country and pass it. Default it from `geo.country`, but render a small confirm/select control so the buyer can correct a mis-detection (this is the "confirm country at checkout" decision):

```jsx
// billingCountry state defaults to the geo-detected country; the confirm
// control lets a traveller / VPN user correct it before paying.
const [billingCountry, setBillingCountry] = useState(null);
useEffect(() => { if (geo?.country) setBillingCountry(geo.country); }, [geo]);
```

Pass it through the checkout call, and surface the `intl_usd_pending` response as a Contact-sales notice rather than an error:

```jsx
const res = await createCheckoutSession(selected.id, billingCycle, billingCountry);
```

Update `createCheckoutSession` in the app's billing API client to send `billing_country`, and in the catch/branch, when the server returns `reason === 'intl_usd_pending'`, show the contact-sales message instead of `submitError`.

- [ ] **Step 6: Lint + build + commit**

```bash
cd api && uv run ruff check app/api/subscription_routes.py && uv run ruff format app/api/subscription_routes.py tests/test_checkout_country_gate.py
cd ../app && npm run lint && npm run build
cd .. && git add api/app/api/subscription_routes.py api/tests/test_checkout_country_gate.py app/src/components/billing/PlanModal.jsx app/src/*/*billing* 2>/dev/null; git add -A app/src
git commit -m "feat(billing): confirm billing country at checkout; gate USD to Phase 2"
```

---

### Task 4: Neutralise the USD-only labels (credits / top-ups)

Two labels are wrong for Indian buyers: a credit balance tagged "(USD)" (credits aren't a currency), and the top-ups footer that says "USD" while top-ups are hard-charged in INR. Make them currency-neutral / geo-aware. Do **not** flip `formatMoney`'s `'usd'` default — that's a scoped follow-up (Task 6-adjacent audit); a blind flip mislabels the genuine USD headline columns for foreign buyers.

**Files:**

- Modify: `app/src/pages/Billing.jsx` (credits "(USD)" ~1111; TopupsTab footer ~1207)

- [ ] **Step 1: Remove the "(USD)" from top-up credits**

In `BotCreditCard` (~1109-1113):

```jsx
        {bot.topup > 0 && (
          <div className="mt-2 text-[11px] text-surface-500 dark:text-surface-400">
            + {fmtNumber(bot.topup)} top-up credits
          </div>
        )}
```

- [ ] **Step 2: Make the TopupsTab footer geo-honest**

In `TopupsTab` (~1206-1208), replace the flat "USD." line. Credits are billed in the buyer's charge currency (INR today for domestic; USD for international once Phase 2 ships):

```jsx
      <p className="text-[11px] text-surface-500 dark:text-surface-400 text-center">
        We accept UPI, cards, and NetBanking via Razorpay.
      </p>
```

- [ ] **Step 3: Lint + build + commit**

```bash
cd app && npm run lint && npm run build
git add src/pages/Billing.jsx
git commit -m "fix(billing): drop misleading USD labels on credits/top-up footer"
```

---

### Task 5: Full Phase-1 verification gate

- [ ] **Step 1: Backend suite** — `cd api && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest --no-cov` → all PASS (baseline 1533 + new tests).
- [ ] **Step 2: Backend lint/format** — `cd api && uv run ruff check . && uv run ruff format --check .` → clean.
- [ ] **Step 3: Frontend lint + build** — `cd app && npm run lint && npm run build` → clean.
- [ ] **Step 4: Manual smoke.**
  - Indian buyer (geo IN): plan selector, price block, and checkout quote all show ₹; card/upi offered; no "$" anywhere in the flow.
  - Foreign buyer (geo US, confirm US): sees $ prices; checkout button shows "Contact sales / coming soon" (`intl_usd_pending`), no broken Razorpay modal.
  - Mis-detection: geo US but confirm IN → INR checkout proceeds.
  - Overview per-bot card: no "(USD)" on credits. Top-ups footer: no bare "USD."

Report as: `lint ✓ · build ✓ · pytest ✓`.

---

### Task 6: Plan ↔ Razorpay price-integrity check (ship-after; not a merge blocker)

Every rupee figure the UI now shows is read from `plan.monthly_price_cents`. If it drifts from the live Razorpay plan amount, the UI truthfully-but-wrongly quotes a number the mandate doesn't debit. This super-admin diagnostic makes drift observable. It touches the live Razorpay API, so ship Tasks 1–5 first, then land this.

**Files:** Modify `api/app/api/subscription_routes.py` (super-admin route); Test `api/tests/test_plan_price_reconciliation.py` (new; mock the Razorpay client — no live calls in tests).

- [ ] **Step 1: Failing test (mocked Razorpay plan fetch)**

```python
from unittest.mock import MagicMock

def test_plan_price_reconciliation_flags_drift(client, superadmin_headers, seed_plan, monkeypatch):
    plan = seed_plan(slug="starter", monthly_price_cents=179900,
                     razorpay_plan_id_monthly="plan_live_starter")
    fake_rzp = MagicMock()
    fake_rzp.plan.fetch.return_value = {"item": {"amount": 149900, "currency": "INR"}}
    monkeypatch.setattr("app.services.razorpay_service._get_razorpay", lambda: fake_rzp)

    res = client.get("/subscriptions/admin/plan-price-check", headers=superadmin_headers)
    assert res.status_code == 200
    row = {r["plan_id"]: r for r in res.json()["plans"]}[plan.id]
    assert row["monthly"]["local_minor"] == 179900
    assert row["monthly"]["razorpay_minor"] == 149900
    assert row["monthly"]["in_sync"] is False
```

- [ ] **Step 2: Run and confirm failure** — 404 (route undefined).

- [ ] **Step 3: Add the diagnostic route** (super-admin gated; never 500s — Razorpay errors return `in_sync: null` + error string). In Phase 2 extend it to also compare the USD plans:

```python
@router.get("/admin/plan-price-check")
def plan_price_check(client: Client = Depends(get_current_client_strict)):
    if not client.is_superadmin:
        raise HTTPException(status_code=403, detail="Super admin only.")
    from app.services.razorpay_service import _get_razorpay
    from app.services.plan_service import get_active_plans

    rzp = _get_razorpay()
    out = []
    with get_session() as session:
        for plan in get_active_plans(session):
            row = {"plan_id": plan.id, "slug": plan.slug}
            for cycle, local_minor, rzp_id in (
                ("monthly", plan.monthly_price_cents, plan.razorpay_plan_id_monthly),
                ("annual", plan.annual_price_cents, plan.razorpay_plan_id_annual),
            ):
                entry = {"local_minor": int(local_minor or 0), "razorpay_minor": None,
                         "in_sync": None, "error": None}
                if rzp_id:
                    try:
                        item = (rzp.plan.fetch(rzp_id) or {}).get("item", {})
                        entry["razorpay_minor"] = int(item.get("amount") or 0)
                        entry["in_sync"] = entry["razorpay_minor"] == entry["local_minor"]
                    except Exception as exc:  # diagnostic must not 500
                        entry["error"] = str(exc)
                row[cycle] = entry
            out.append(row)
    return {"plans": out}
```

- [ ] **Step 4: Run the test and confirm it passes.**
- [ ] **Step 5: Lint + commit** — `git commit -m "feat(billing): super-admin plan↔razorpay price-integrity check"`.

---

# PHASE 2 — International USD rail on the Razorpay Subscriptions product  🔒 GATED

> **Design-locked, not step-locked.** Architecture and task boundaries are fixed; per-task TDD is deferred to kickoff. Expand each task into TDD (writing-plans skill) when prerequisites clear.

### Prerequisites

1. ✅ **International Payments activated** on the Digibranders merchant account (confirmed by CTO). Verify in writing that **international recurring subscriptions (card mandates)** are enabled — not just one-time — and note the supported presentment currencies. ([International Payments](https://razorpay.com/docs/payments/international-payments/))
2. **USD plans created + priced.** Each paid tier gets a **USD Razorpay plan** (separate, single-currency) with an **independently set USD price** (not an FX conversion of INR — a real price decision). Set the USD price columns (`monthly_price_usd_cents` / `annual_price_usd_cents`) to the charged price, and store the USD Razorpay plan IDs (P2-T1).
3. **Settlement reality accepted** — USD card receipts settle to INR at Razorpay's capture-date rate; no original-currency settlement on this rail (correction #1). If USD-holding is ever required, that's the separate International Bank Transfer product — out of scope.
4. **FX economics signed off** (business) — foreign-card MDR/markup, no RBI chargeback protection on foreign cards, refund slippage, and the settlement-vs-invoice-vs-FIRC three-rate spread.
5. **GST/legal sign-off** — LUT filed (zero-rated export without IGST); SAC/export treatment; FIRC/e-FIRA capture process.
6. **UPI/eMandate off the table for foreign buyers** — international recurring is card-only (Razorpay: UPI/eMandate "Only INR is supported"). Product sign-off on card-only. ([Subscriptions FAQs](https://razorpay.com/docs/payments/subscriptions/faqs/))

### Architecture (locked)

Confirmed **billing country** (Task 3) is the routing key. The foreign path is a **currency variant of the existing Subscriptions flow** — it reuses `create_subscription`, webhooks, and idempotency; it only selects the USD plan and restricts methods to cards.

### Tasks (expand to TDD at kickoff)

- [ ] **P2-T1 — Dual Razorpay plans + independent USD pricing.** Alembic migration adds `razorpay_plan_id_monthly_usd` / `razorpay_plan_id_annual_usd` to `Plan` (today only the INR pair exists). Super-admin Plans UI captures the USD plan IDs **and** the independent USD prices. `create_subscription` selects INR vs USD plan id by confirmed country. Extend Task-6's price check to the USD plans. **Acceptance:** an IN buyer gets the INR plan/mandate; a US buyer gets the USD plan/mandate; neither can be charged in the wrong currency.
- [ ] **P2-T2 — International-card USD subscription + top-up.** Thread `currency` through `create_subscription` and `create_topup_order` (today it hard-rejects non-INR at `razorpay_service.py:156-158`); restrict foreign flows to **card** methods; handle International webhooks/settlement with the same idempotency as INR. Flip the `intl_usd_pending` branch in `checkout_quote` / `create_checkout` to the live USD rail. **Acceptance:** a foreign card completes a recurring USD subscription and a one-time USD top-up end-to-end in Razorpay test mode (international test cards + 3DS/AFA).
- [ ] **P2-T3 — Export-invoice branch.** Replace the INR-only finalize guard (`invoice_service.py:145`) with confirmed-country routing: IN → existing GST invoice; foreign → **export invoice** via the `core/tax.py` export path (zero-rated under LUT, place of supply "Outside India"). **Acceptance:** a foreign USD payment produces a finalized, numbered, zero-rated export invoice; INR unchanged.
- [ ] **P2-T4 — INR equivalent on the export PDF (Rule 34).** Snapshot the **RBI/GAAP reference rate on the date of supply** (a *different* rate from Razorpay settlement — correction #2) and render "INR equivalent @ rate on <date>." **Acceptance:** every foreign invoice shows the USD total, its INR equivalent, and the rate/date; the rate source is RBI/GAAP, not the settlement rate.
- [ ] **P2-T5 — FIRC/e-FIRA capture + three-rate reconciliation.** Persist FIRC/e-FIRA references against export invoices; extend `invoice_reports.py` to reconcile the three INR figures (settlement / invoice / realization) per export charge and flag invoices lacking realisation proof. **Acceptance:** the export report lists each invoice with all three INR figures (or an anomaly) + its realisation reference.
- [ ] **P2-T6 — Wire confirmed-country routing to the USD rail + FEMA note.** The confirm-country gate (Task 3) already exists; here it routes IN→INR rail, non-IN→USD rail across display, charge, and invoice. Record the product/legal position that an Indian resident is always charged INR (a USD sticker to an IN buyer would be display-only, which the geo-split model already prevents). **Acceptance:** display, charge, and invoice currency all agree with the confirmed country for every buyer.

### Phase 2 rollout

Ship behind `MULTICURRENCY_V2_ENABLED` (default off). Real activation gate = USD Razorpay plans configured + LUT on file — "config-is-the-switch," same as the seller profile. Land each task independently with its own review.

---

## Risks & rollback

- **Phase 1 is reversible.** `/geo` + `checkout_quote` changes are additive/branching; the label fixes are copy. Rollback = revert the commits. The one behaviour change users notice is Indians now see ₹ instead of $ — intended.
- **Display truthfulness depends on price parity.** The INR shown is `plan.monthly_price_cents`; Task 6 makes drift from the live Razorpay plan observable. Run it after any plan-price change (doubly important in Phase 2 — two plans per tier).
- **Do not flip `formatMoney`'s default currency.** Foreign buyers' USD headline columns depend on it; a global flip mislabels them. Pass explicit currency at each call site as a scoped follow-up.
- **Settlement is INR on the card rail.** No Phase-2 flow/report/forecast may assume USD held in Razorpay — it settles to INR at capture-date FX (correction #1).
- **Confirmed country ≠ IP geo.** Always route on the confirmed `billing_country`; IP is only the default. A GSTIN pins the country to IN — never let checkout override that.
- **Phase 2 is the same product, not a second rail — but doubles the surface.** Each foreign path needs its own test coverage, export-invoice branch, and CA sign-off. Do not merge P2 tasks; land them independently.

---

## Self-review checklist (completed by plan author)

- **Model correctness:** geo-split (IN→INR, non-IN→USD) makes display = charge = invoice currency per confirmed country; the Rev-2 disclosure hack is removed as unnecessary. ✅
- **Decision coverage:** (1) INR-flip first / USD follows → Phase 1 vs Phase 2 split; (2) International Payments activated → Prereq 1 marked done, Phase 2 unblocked on underwriting; (3) confirm country at checkout → Task 3 + the confirmed-country routing key throughout. ✅
- **Fact-check coverage:** every Razorpay claim cited; the settlement/three-rate/FX corrections carry into Phase 2 prerequisites and Risks. ✅
- **Placeholder scan:** Phase 1 has full code + exact commands; Phase 2 is design-locked with acceptance criteria. The one flagged assumption (non-IN interim = `intl_usd_pending`) is called out for the CTO. ✅
- **Type/name consistency:** `display_currency`, `billing_country`, `checkout_supported`, `reason: "intl_usd_pending"`, `resolve_country`, `_amount_for_cycle`, `format_amount`, `get_active_plans`, `_get_razorpay`, `Client.billing_country`, `Client.gstin`, `razorpay_plan_id_monthly/annual` all reference real in-repo symbols (verified). ✅

---

## Sources

- [International Payments Support from Razorpay](https://razorpay.com/docs/payments/international-payments/) — 160+ currencies, per-account activation.
- [Currency Conversion (International Payments)](https://razorpay.com/docs/payments/international-payments/currency-conversion/) — **settlement is INR at the capture-date bank rate.**
- [Subscriptions FAQs](https://razorpay.com/docs/payments/subscriptions/faqs/) — international cards enable recurring in supported currencies; **UPI and eMandate are "Only INR is supported."**
- [Create a Plan API](https://razorpay.com/docs/api/payments/subscriptions/create-plan/) — `item.currency` fixes a plan's currency (single-currency per plan).
- [International Bank Transfer (MoneySaver Export Account)](https://razorpay.com/docs/payments/international-payments/accept-international-payments-via-local-currency-bank-accounts/) — the *separate* product for original-currency settlement (wire transfers, not card mandates).
- [International Subscriptions from India: Complete Guide 2026](https://razorpay.com/blog/international-subscriptions-india/) — multi-currency processing with INR settlement.
