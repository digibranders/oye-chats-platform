# App-Wide Currency Implementation Plan

> ## ⚠️ Written before the 26 Aug 2026 switch to GST-EXCLUSIVE pricing
>
> This plan is dated 2026-07-07 and is left unedited. It solves currency, not tax, and that half of
> it still stands. What it cannot know is that **the price columns it reads are now base prices**.
> `monthly_price_cents`, `annual_price_cents`, `extra_seat_price_cents` and the top-up pack amounts
> are all exclusive of GST. A domestic customer is debited base + GST; an international customer is
> an export and pays the listed USD price.
>
> So picking the right column and formatting it is no longer sufficient. Any surface that tells a
> customer what they will pay must render the **gross**, which the API now returns alongside the base:
> `gross_minor` / `gross_display` on `GET /subscriptions/checkout/quote`,
> `gross_extra_seat_price_cents` on `POST /subscriptions/seats`, `gross_price_cents` on the branding
> add-on routes, and `gross_inr` per pack on `GET /credits/packs`. `GET /subscriptions/geo`, which
> this plan already makes the single currency source, also returns `tax_rate_bps`, so the disclosure
> copy never has to hardcode a second 18%.
>
> Current source of truth: `api/app/core/tax.py`, and the billing endpoints in
> [`api-reference.md`](../../api-reference.md#billing-and-pricing-routes).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. **Phase A is fully specified; Phases B–D are design-locked** — expand at kickoff.

**Goal:** Make the customer's currency a single account-level concept so **every** price in the admin app (billing page, top-ups, seats, overview, invoices, plan modal) renders in the currency they are actually charged — INR for India, USD elsewhere — instead of hardcoding `$`.

**Architecture:** Currency is derived from the account's **billing country** (`Client.billing_country`), set at onboarding and editable in Billing. The frontend gets it from one place — a new **`CurrencyContext`** fed by `GET /subscriptions/geo` (which already returns the correct `display_currency`) — and exposes `useCurrency() → { currency, country, isInr, format }`. Every money-rendering component reads from it; no component hardcodes `$` or defaults to `'usd'`. Phase A is **frontend-only** (no backend change, so it ships and verifies without the API running). Later phases move country capture into onboarding, restructure the Billing "details" section into its own tab, and fold currency into the account bootstrap endpoint.

**Tech Stack:** React 19 + Vite (`app/`), existing `formatMoney` (`app/src/lib/currency.js`), React context pattern (mirrors `ThemeContext`/`CrawlContext`). Verify with `npm run lint` + `npm run build` (the `app/` project has no unit-test runner — lint+build+manual smoke is the gate).

---

## Problem (from screenshots)

The "Choose a plan" modal correctly shows ₹ for an Indian user, but the **Billing page, top-up modal, operator seats, and overview all show `$`**. Root cause: there is **no global currency source**. `Billing.jsx` header literally states *"All prices are stored in USD cents"* and `fmtCurrency()` defaults to `'usd'`; it reads `*_usd_cents` columns unconditionally. My earlier fix only taught one component (`PlanModal`) to read `/geo`. This plan introduces the missing primitive so the whole app agrees.

## File Structure

- **Create** `app/src/context/CurrencyContext.jsx` — provider + `useCurrency()` hook; fetches `/geo` once, exposes `{ country, currency, isInr, loading, format, setCountry }`.
- **Modify** `app/src/lib/currency.js` — add `pickAmount({ inrMinor, usdMinor }, currency)` (choose the column for the active currency).
- **Modify** `app/src/App.jsx` — wrap the **authenticated** admin tree with `<CurrencyProvider>` (`/geo` needs auth).
- **Modify** `app/src/pages/Billing.jsx` — replace all `fmtCurrency`/`*_usd_cents`/`$` with `useCurrency().format` + `pickAmount`.
- **Modify** `app/src/components/billing/PlanModal.jsx` — migrate its local geo to `useCurrency()` (removes the duplicate `/geo` fetch and the local country state; the picker writes through the context).
- **Modify** `app/src/components/billing/InvoicesCard.jsx`, `app/src/components/billing/AddSeatConfirmModal.jsx`, `app/src/pages/Subscription.jsx` — same sweep.

---

# PHASE A — Global currency context + sweep (frontend-only, ships now)

**Definition of done:** For an Indian account, the Billing page, top-up modal, seats, overview, invoices, and plan modal all render **₹** (from the INR columns); for a non-IN account they render **$**. No component hardcodes `$` or defaults `formatMoney` to `'usd'`. `npm run lint` (0 new errors) + `npm run build` clean.

**Branch:** `development`.

**Gate commands:** `cd app && npm run lint && npm run build`.

---

### Task A1: Add the `pickAmount` currency helper

**Files:** Modify `app/src/lib/currency.js`

- [ ] **Step 1: Add the helper** (append to `currency.js`):

```js
/**
 * Choose the minor-unit amount for the active currency from an entity that
 * carries BOTH an INR column and a USD column (plans, packs, seats).
 *
 * @param {{inrMinor?: number|null, usdMinor?: number|null}} amounts
 * @param {string} currency - 'inr' | 'usd' (case-insensitive)
 * @returns {number} the amount in the active currency's minor units (0 if absent)
 */
export function pickAmount({ inrMinor, usdMinor }, currency) {
  const isInr = String(currency || '').toLowerCase() === 'inr';
  return Number((isInr ? inrMinor : usdMinor) ?? 0);
}
```

- [ ] **Step 2: Lint** — `cd app && npm run lint` → no new errors.
- [ ] **Step 3: Commit** — `git add app/src/lib/currency.js && git commit -m "feat(billing): add pickAmount currency-column selector"`.

---

### Task A2: Create `CurrencyContext`

**Files:** Create `app/src/context/CurrencyContext.jsx`

- [ ] **Step 1: Write the provider + hook** (mirrors `ThemeContext.jsx` conventions):

```jsx
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getBillingGeo } from '../services/api';
import { formatMoney } from '../lib/currency';

const CurrencyContext = createContext(null);

/**
 * Single source of truth for the account's display currency across the admin
 * app. Currency follows the account's billing country (IN → INR, else USD);
 * the display currency equals the charge currency, so every price the user
 * sees matches what Razorpay debits. Fed by GET /subscriptions/geo, which
 * already derives display_currency from the confirmed billing country.
 *
 * Must wrap the AUTHENTICATED tree — /geo requires client auth.
 */
export function CurrencyProvider({ children }) {
  const [country, setCountry] = useState(null);
  const [currency, setCurrency] = useState('usd'); // lowercase → matches formatMoney
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getBillingGeo()
      .then((geo) => {
        if (!alive) return;
        setCountry(geo?.country ?? null);
        setCurrency((geo?.display_currency || 'USD').toLowerCase());
      })
      .catch(() => { /* keep the USD default on failure — never block the UI */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const value = useMemo(
    () => ({
      country,
      currency, // 'inr' | 'usd'
      isInr: currency === 'inr',
      loading,
      format: (minor) => formatMoney(minor, currency),
      // Optimistic local override (checkout / billing-settings picker); the
      // server persists billing_country separately and /geo re-confirms on next load.
      setCountry: (next) => {
        const c = (next || '').toUpperCase() || null;
        setCountry(c);
        setCurrency(c === 'IN' ? 'inr' : 'usd');
      },
    }),
    [country, currency, loading],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider');
  return ctx;
}
```

- [ ] **Step 2: Wire the provider into the authenticated tree** in `app/src/App.jsx`. Import it (`import { CurrencyProvider } from './context/CurrencyContext';`) and wrap the same authenticated admin subtree that `CrawlProvider` wraps (place `<CurrencyProvider>` immediately outside `<CrawlProvider>` so all billing screens are inside it).

- [ ] **Step 3: Lint + build** — `cd app && npm run lint && npm run build` → clean.
- [ ] **Step 4: Commit** — `git add app/src/context/CurrencyContext.jsx app/src/App.jsx && git commit -m "feat(billing): global CurrencyContext fed by /geo"`.

---

### Task A3: Sweep `Billing.jsx` (the main offender)

Replace the USD-hardcoded rendering with `useCurrency()`. Every plan/seat/topup/credit amount must (a) pick the INR-or-USD column via `pickAmount` and (b) format via `format()`.

**Files:** Modify `app/src/pages/Billing.jsx`

- [ ] **Step 1: Consume the hook.** Near the top of the `Billing` component (and any sub-component that renders money — `TopupsTab`, the overview cards, the plan/seat rows), add `const { currency, format } = useCurrency();` (import `useCurrency` + `pickAmount`). Delete the `fmtCurrency(x, currency='usd')` helper (line ~75) and the module comment claiming "All prices are stored in USD cents" (line ~51).

- [ ] **Step 2: Convert each price site.** For every amount, pick the column then format:

```jsx
// plan monthly price
const planMinor = pickAmount(
  { inrMinor: cycle === 'annual' ? plan?.annual_price_cents : plan?.monthly_price_cents,
    usdMinor: cycle === 'annual' ? plan?.annual_price_usd_cents : plan?.monthly_price_usd_cents },
  currency,
);
// render: {format(planMinor)} / {cycle === 'annual' ? 'year' : 'month'}

// seat price
const seatMinor = pickAmount(
  { inrMinor: plan?.extra_seat_price_cents, usdMinor: plan?.extra_seat_price_usd_cents },
  currency,
);
// render: Add seat ({format(seatMinor)}/mo)
```

Replace the `plan?.monthly_price_usd_cents > 0` gating conditions (lines ~988, ~1241) with a currency-agnostic check on the picked amount (`planMinor > 0`) so free-vs-paid detection is currency-independent. Top-up packs: render each pack's amount via `pickAmount({ inrMinor: pack.amount, usdMinor: pack.amount_usd }, currency)` + `format` (see Task D-note — packs must carry both; until then the INR `pack.amount` is authoritative since Razorpay charges INR).

- [ ] **Step 3: Lint + build** — `cd app && npm run lint && npm run build` → clean.
- [ ] **Step 4: Commit** — `git add app/src/pages/Billing.jsx && git commit -m "feat(billing): render Billing page in the account currency"`.

---

### Task A4: Sweep the remaining money components

**Files:** Modify `app/src/components/billing/PlanModal.jsx`, `app/src/components/billing/InvoicesCard.jsx`, `app/src/components/billing/AddSeatConfirmModal.jsx`, `app/src/pages/Subscription.jsx`

- [ ] **Step 1: `PlanModal.jsx`** — replace its local geo (`getBillingGeo` fetch + `geo`/`billingCountry` state) with `const { country, currency, isInr, format, setCountry } = useCurrency();`. Build the effective display from the context; the country `Select` calls `setCountry` (context) instead of local state, so changing it in the modal updates the whole app. Keep the checkout call passing `country` from the context.
- [ ] **Step 2: `InvoicesCard.jsx`, `AddSeatConfirmModal.jsx`, `Subscription.jsx`** — swap `formatMoney(x, 'usd')` / `fmtCurrency` for `useCurrency().format(pickAmount(...))`, picking the INR/USD column per amount.
- [ ] **Step 3: Guard against regressions** — `cd app && grep -rn "formatMoney([^,]*, *['\"]usd" src/ && echo "FOUND hardcoded-usd — fix" || echo "clean"`. Expect `clean`.
- [ ] **Step 4: Lint + build** — `cd app && npm run lint && npm run build` → clean.
- [ ] **Step 5: Commit** — `git add app/src/components/billing/*.jsx app/src/pages/Subscription.jsx && git commit -m "feat(billing): route remaining money surfaces through CurrencyContext"`.

---

### Task A5: Verification gate

- [ ] **Step 1:** `cd app && npm run lint` → 0 new errors.
- [ ] **Step 2:** `cd app && npm run build` → clean.
- [ ] **Step 3: Manual smoke (requires API running — do in the CLI once the venv is repaired):** log in as an Indian account → Billing shows **₹** on plan, seats, top-up packs, overview, invoices; switch billing country to US in the picker → the whole page flips to **$** live. Report `lint ✓ · build ✓ · smoke ✓`.

---

# PHASE B — Capture billing country at ONBOARDING  🔒 DESIGN-LOCKED

Set the country once, up front, so the app is correct on first load.

- [ ] **B1 — Onboarding country step.** Add a "Where are you billing from?" step to `app/src/components/OnboardingWizard.jsx`, reusing `COUNTRY_OPTIONS` + `Select`. Default from IP geo (`/geo` `country`), one-click confirm (not a hard gate). On submit, `PUT /subscriptions/billing-details { billing_country }` (endpoint exists) → persists `Client.billing_country`. **Acceptance:** a fresh account picks a country in onboarding; the whole app renders that currency immediately after, with no visit to the plan modal.
- [ ] **B2 — Modal picker writes through.** The `PlanModal` country `Select` (Phase A) already updates the context; also persist to the account (`PUT /billing-details`) so the choice sticks across sessions and surfaces. **Acceptance:** changing country at checkout is remembered on next login.

---

# PHASE C — Billing "details" → its own tab, expanded  🔒 DESIGN-LOCKED

Move the buried "Billing details" section into a first-class tab and make it the billing/tax home.

- [ ] **C1 — New tab.** Add `{ id: 'details', label: 'Billing details' }` to the Billing `TABS` (`Billing.jsx`); move the existing Legal name / GSTIN / Address / State / Country / Billing email block out of the "Plan & seats" tab into it.
- [ ] **C2 — Billing country + currency (canonical).** Put the country `Select` here as the canonical owner of `Client.billing_country`; show "You're billed in ₹ INR / $ USD" derived from it; changing it updates the context + persists.
- [ ] **C3 — Tax identity, conditional.** GSTIN field when country == IN; a VAT / Tax-ID field when export (non-IN). Validate per country.
- [ ] **C4 — Payment method.** Surface the saved card / UPI-mandate status with an "update payment method" action (Razorpay), so users manage it here rather than only at checkout.
- [ ] **C5 — Billing alerts + invoice delivery.** "Email me at X% credits remaining" toggle/threshold and a billing-email override for invoice delivery. **Acceptance for C1–C5:** the Billing Details tab shows country/currency, tax identity (country-correct), address block, payment method, and alert preferences; each persists and reflects across the app.

---

# PHASE D — Backend money coherence  🔒 DESIGN-LOCKED

- [ ] **D1 — `currency_for_country` helper** (`api/app/core/pricing.py`): `IN → "INR"` else `"USD"`; reuse in `/geo`, `checkout_quote`, and D2.
- [ ] **D2 — Fold currency into the bootstrap call.** Add `billing_country` + `display_currency` to `GET /auth/me/entitlements` (already called at app load) so `CurrencyContext` can source from it and drop the extra `/geo` round-trip. **Acceptance:** entitlements returns the account currency; `CurrencyProvider` reads it with no separate `/geo` call.
- [ ] **D3 — Top-up packs & seats carry both currencies.** Ensure `pricing_config.topup_packs` entries and the seat price expose an INR amount (`amount`) **and** a USD amount (`amount_usd`); the API returns both so the frontend `pickAmount` chooses. Today packs are INR-charged but only surface `$` — this makes display match the charge. **Acceptance:** top-up modal shows ₹ packs for IN, $ packs for non-IN, and the charged INR matches the ₹ shown.
- [ ] **D4 — Anti-regression gate.** Add an ESLint rule (or a CI grep) forbidding `formatMoney(x, 'usd')` and bare `$`-prefixed price literals in `app/src`, so new code can't reintroduce hardcoded USD.

---

## Risks & rollback

- **Phase A is additive + frontend-only.** Rollback = revert the commits; no schema/API change. The USD default in `CurrencyContext` means any `/geo` failure degrades to today's behaviour, never a blank price.
- **/geo is authenticated** — `CurrencyProvider` MUST wrap only the authenticated tree, or unauthenticated pages 401 on load. (Wired around the same subtree as `CrawlProvider`.)
- **INR is the charge currency for IN** — always display the INR columns for IN users (never `usd*rate`), so the number shown equals the Razorpay debit. `pickAmount` enforces this by reading the INR column directly.
- **Packs incoherence (pre-D3):** until D3, top-up packs may still only carry a `$` display amount. Phase A renders the INR `pack.amount` (the real charge) for IN users; if a pack lacks an INR amount, surface the charged INR, not a converted USD.
- **Don't break free-vs-paid detection** — replace `*_usd_cents > 0` gates with the currency-agnostic picked amount, or a free plan could misrender once currency flips.

## Self-review checklist

- **Spec coverage:** `$`-everywhere → Phase A (context + sweep of all 5 money files); country at onboarding → Phase B; Billing-details tab + additions → Phase C; backend coherence (entitlements + packs) → Phase D. ✅
- **Placeholder scan:** Phase A steps carry real code (`pickAmount`, `CurrencyContext`, provider wiring, exact sweep edits) + exact gate commands; B–D are design-locked with acceptance criteria. ✅
- **Type/name consistency:** `useCurrency`, `CurrencyProvider`, `pickAmount({inrMinor,usdMinor}, currency)`, `format`, `setCountry`, `currency` ('inr'|'usd') used identically across Tasks A1–A4; real symbols `getBillingGeo`, `formatMoney`, `Client.billing_country`, `OnboardingWizard.jsx`, `pricing_config.topup_packs`, `/auth/me/entitlements` verified in-repo. ✅
