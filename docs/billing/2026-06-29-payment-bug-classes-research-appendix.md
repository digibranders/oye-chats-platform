# Appendix — Payment Bug Classes: Internet Research & Fixes

Companion to `2026-06-29-payment-system-review-report.md`. This is the "what can go wrong, and the canonical fix" reference, researched against Razorpay/Stripe docs, OWASP, CPython/SQLAlchemy/PostgreSQL docs, and public disclosures (HackerOne, CVEs). Each item lists the bug, why it happens, the fix, and where OyeChats stands.

> **⚠️ Scope note (verified 2026-06-29):** the **Stripe path is not implemented** — there is no `api/app/services/billing_service.py`, and no Stripe webhook handlers exist. Razorpay is the only live provider. All **Stripe-specific** items below (Stripe dispute timing, `Idempotency-Key`, Stripe refund events) are therefore *forward-looking design guidance*, **not** gaps in shipped code. Where a row says "OyeChats: ✅/⚠️/❌", that verdict applies to the **Razorpay** path unless noted. See report finding **N4**.

---

## A. Webhook signature & verification

| # | Bug | Fix | OyeChats status |
|---|---|---|---|
| A1 | HMAC computed over **parsed/re-serialized** body, not raw bytes (key order/whitespace/Unicode changes the digest) | Verify over `await request.body()` raw bytes; parse only after | ✅ Raw bytes captured; ⚠️ `verify_webhook_signature` decodes to str before SDK (cosmetic for valid UTF-8 — see report L1) |
| A2 | Non-timing-safe `==` compare (timing oracle) | `hmac.compare_digest` | ✅ SDK uses `compare_digest` |
| A3 | Wrong secret — API `key_secret` vs **per-webhook** secret; test vs live; old secret needed during rotation | Separate `RAZORPAY_WEBHOOK_SECRET`; accept old secret while retries drain a rotation | ✅ Dedicated webhook secret, fail-closed if missing |
| A4 | Verification skipped / `except: pass` / only on some routes | Centralize; reject 400; act only after verify | ✅ Single inbound route verifies before dispatch |

**Razorpay specifics (confirmed):** header `X-Razorpay-Signature` = `HMAC_SHA256(raw_body, webhook_secret)`; checkout one-time = `HMAC_SHA256(order_id"|"payment_id, key_secret)`; subscription = `HMAC_SHA256(payment_id"|"subscription_id, key_secret)`. Sources: razorpay.com/docs/webhooks/validate-test/, /best-practices/, /faqs/; razorpay-python `utility.py`.

## B. Idempotency & replay (at-least-once delivery)

- Razorpay/Stripe are **at-least-once**; a >5s response or any non-2xx triggers retry for ~24h; events can arrive **out of order**; the same payment can fire multiple events. Dedupe on `x-razorpay-event-id` (Stripe `evt_…`) with a **DB UNIQUE constraint** + `INSERT … ON CONFLICT DO NOTHING` — never check-then-act in Python.
- Webhook signatures are **body-only (no timestamp/nonce)** → a captured payload is replayable forever; event-id dedup is the real replay defense.
- **OyeChats:** ✅ `processed_webhooks.event_id` PK + atomic `ON CONFLICT` + `rowcount`. ⚠️ first-cycle grant uses a 24h time-window heuristic instead of a period marker (report H4); ❌ returns 200 on processing error → lost-event class (report C1).
- Sources: razorpay.com/docs/webhooks/best-practices/, docs.stripe.com/webhooks, postgresql.org/docs/current/sql-insert.html.

## C. Payment verification & amount tampering

- The checkout signature only proves "a valid payment exists for this order/payment id" — it does **not** cover the amount or `notes`. Always (1) verify signature, (2) `payment.fetch`/`order.fetch` server-side, (3) assert `status == captured` (not just `authorized`), (4) assert `amount`/`currency` equal the **server-created order**.
- **Never trust client `amount`, `price`, `total`, or `notes` for authorization.** Recompute payable from DB; derive the gateway amount only from that; on webhook assert captured amount == expected.
- **OyeChats:** ✅ top-up credits bound to a server-matched pack (`_match_topup_pack`); amounts in paise server-side; Razorpay rejects non-INR. ⚠️ webhook doesn't re-assert captured amount == expected pack price (report H... defense-in-depth); ⚠️ USD quote vs INR charge — confirm quote == charge.
- Real-world: Razorpay HackerOne program; payment-bypass case studies (parameter tampering is the dominant class). Sources: razorpay.com/docs/payments/payment-gateway/.../best-practices/, owasp.org/www-community/attacks/Web_Parameter_Tampering.

## D. Race conditions / double-credit (TOCTOU)

- Read-modify-write on a balance under PostgreSQL default **Read Committed** loses updates; `SELECT` takes no lock. Fixes (layer them): **UNIQUE constraint** per payment (idempotency), atomic `UPDATE … SET balance = balance + :x` (not Python add), `SELECT … FOR UPDATE` / `with_for_update()` for read-decide-write, optimistic `version_id_col`, or Serializable + 40001 retry.
- Callback **and** webhook crediting the same payment is a classic double-credit; both must hit one shared idempotency guard keyed on payment id.
- **OyeChats:** ✅ per-client/bot PG advisory lock around ledger writes; ✅ append-only signed-delta ledger. ❌ subscription/trial mutation endpoints have **no row lock** — the *decision* to grant can run twice (report H1).
- Sources: owasp.org/www-community/pages/vulnerabilities/race_conditions, cwe.mitre.org/data/definitions/367.html, docs.sqlalchemy.org/en/20/orm/queryguide/query.html (with_for_update), postgresql.org/docs/current/transaction-iso.html.

## E. Money handling

- **Store/transmit integer minor units (paise/cents); never float.** `0.1+0.2≠0.3`; floats accrue error. SQLAlchemy `BigInteger` (minor units) or `Numeric(asdecimal=True)` — never `Float`/`double precision` for money (PostgreSQL explicitly recommends `numeric`).
- Minor-unit **scale is per-currency** (INR/USD=2, JPY=0, KWD/BHD/OMR=3) — hardcoded `*100` is wrong for JPY. Currency is part of the amount; never do cross-currency arithmetic.
- Splitting/proration must conserve the total — use the **largest-remainder method** (floor each share, distribute the remainder), not independent rounding.
- **OyeChats:** ✅ integer paise in core paths. ⚠️ affiliate split truncates each leg independently → doesn't reconcile (report M1); ⚠️ `format_amount` float equality + Western grouping for INR (report M2); ⚠️ hardcoded FX 94.67 fallback (report M3).
- Sources: razorpay.com/docs/api/orders/create/, docs.stripe.com/currencies, docs.python.org/3/library/decimal.html, postgresql.org/docs/current/datatype-numeric.html, en.wikipedia.org/wiki/Largest_remainder_method.

## F. Refunds, chargebacks & disputes

- Granting on capture but **never reversing** on refund/dispute = free credits. Handle Razorpay `refund.processed` + `payment.dispute.created/.lost/.won`; Stripe refund events + `charge.dispute.created/.closed/.funds_withdrawn/.funds_reinstated`.
- **Timing differs:** Stripe debits at `dispute.created`; Razorpay deducts on `dispute.lost`. Claw on *created*, finalize on *outcome*.
- Reverse **per refund object's own amount**, not the cumulative `amount_refunded` (else partials double-count); dedupe by refund/dispute id.
- Negative balance after credits already spent represents **real debt** — don't clamp to zero; gate spend separately. Run **daily settlement reconciliation** to self-heal missed reversals; store `source_ref` + `related_payment_id`.
- **OyeChats:** ⚠️ refund handler exists but `clawback_refund` picks the **wrong grant** and writes to the **wrong ledger scope** (report C2); ❌ **no dispute/chargeback handler** (`payment.dispute.*` is not in the dispatch table — report H6); ❌ **no `refund.failed` reversal** — credits are clawed on `refund.created` and never restored if the refund fails (report N1); ⚠️ `refund.created`/`refund.processed` carry distinct event-ids, so an intervening grant can cause a **double-clawback** (report N2); ❌ no settlement reconciliation backstop.
- Sources: razorpay.com/docs/webhooks/payloads/refunds/, /disputes/, razorpay.com/docs/payments/disputes/, docs.stripe.com/disputes/how-disputes-work, sdk.finance/blog/what-is-a-double-entry-ledger-in-fintech/.

## G. Order/payout creation idempotency

- A timed-out `orders.create` retried → duplicate orders. Razorpay's native idempotency (`X-Payout-Idempotency`, mandatory since 2025-03-15, 4–36 char v4 UUID, same body required) covers **payouts only** — for orders use a stable `receipt` + DB UNIQUE.
- Stripe `Idempotency-Key`: client-generated v4 UUID, caches success **and** failure, rejects param mismatch, prunes ~24h. Pattern: UNIQUE-scoped key + atomic claim (in_progress→completed) + stored-response replay + body-hash 409.
- Double-click is real — disable button + generate the key once per attempt; but client mitigations are not sufficient, enforce server-side.
- **OyeChats:** order receipts are timestamped (`topup_c{id}_{ts}`) — not a stable idempotency key, but top-up double-grant is contained by the Invoice `razorpay_payment_id` unique + event-id dedup. Consider an idempotency key on order creation if double-submit becomes an issue.
- Sources: docs.stripe.com/api/idempotent_requests, stripe.com/blog/idempotency, razorpay.com/docs/api/x/payout-idempotency/, brandur.org/idempotency-keys, github.com/fastapi/fastapi/discussions/3555.

## H. Authorization / IDOR (BOLA) — OWASP API #1

- Every query loading a billing object (order/invoice/subscription/payment) must filter by the **authenticated owner**, not just the object id. Prefer `WHERE id=:id AND client_id=:caller`; return 404 (not 403) to non-owners to avoid enumeration. Treat any `user_id`/`client_id` in the request as untrusted — derive the subject from the auth token. Centralize as a dependency; add negative authz tests to CI.
- Real disclosures: Shopify billing-doc IDOR, NordVPN payments IDOR, Starbucks fund-transfer IDOR, Hostinger order-renewal IDOR, McDonald's McHire 64M sequential-id IDOR.
- **OyeChats:** responses are client-scoped (`get_current_client*` + re-read by `client.id`). Hardening: assert `notes.client_id == caller` before reconcile (report L2); audit state-changing routes (`cancel`, change-plan, seats) for ownership + locking.
- Sources: owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/, owasp.org/Top10/2021/A01_2021-Broken_Access_Control/.

## I. Coupon / discount / affiliate abuse — OWASP business logic

- Classes: stacking (>100% off), negative totals (discount > price), reuse beyond `max_redemptions`/no per-user cap, **TOCTOU race** on single-use codes, percentage rounding, client-supplied discount, expired-coupon-still-accepted, self-referral fraud.
- Fixes: enforce stacking policy + dedupe; clamp `discount ≤ subtotal` and `payable ≥ 0` (route free orders off the gateway); `UNIQUE(code,user)` + atomic `UPDATE … WHERE remaining>0 AND valid_until>=now()`; `Decimal`/paise with one rounding point; recompute server-side; validate expiry vs server-UTC at apply **and** capture; correlate self-referral on email/IP.
- Real disclosures: alf.io CVE-2024-45300 (promo race), Stripe #1717650 (over-redemption), Instacart #157996, Dropbox #59179, Reverb #759247, Magento #35162 (negative total), Adobe ACSD-54966 (reuse after failed order).
- **OyeChats:** ❌ **no `max_redemptions`/expiry/usage cap** on referral codes (confirmed — `ReferralCode` has no such columns); ⚠️ the data layer permits a 100% pool→customer allocation, **but** `resolve_discounted_plan` rejects exactly `bps ≥ 10000` with `ValueError` (`razorpay_service.py:418`) → no ₹0 plan is minted (HTTP 400 instead). The real defect is the **missing minimum-price floor**: at `bps = 9999` (~99.99%) price collapses to a few paise (report C3, corrected). ⚠️ self-referral guard is shallow — blocks same-`client_id` only, defeated by a second account (report C3). Discounts are modeled as discounted Razorpay plans (`resolve_discounted_plan`) with integer-paise math — good — but need a `discounted_paise >= MIN_PLAN_PAISE` floor.
- Sources: owasp WSTG-BUSL-01/05, owasp.org/www-community/attacks/Web_Parameter_Tampering, datadome.co/learning-center/coupon-glittering-explained/.

## J. Time / timezone / datetime

- Use **aware UTC** everywhere (`datetime.now(UTC)`); `utcnow()` is deprecated (3.12) / removed (3.14) and returns naive. Parse Razorpay Unix epochs with `fromtimestamp(ts, tz=UTC)` (naive parse shifts by server offset and crashes aware-vs-naive comparisons with `TypeError`).
- "Add a month" must be calendar math (`relativedelta(months=1)` / `add_months`), not `timedelta(days=30)` (Jan 31 → Mar 2 bug). Compute period boundaries/expiry in UTC; coupon/trial expiry at local midnight is a DST/off-by-one hazard (set ~04:00–05:00).
- **OyeChats:** ✅ uses `datetime.now(UTC)` and `add_months` calendar math and parses Razorpay timestamps with `tz=UTC`. ⚠️ `add_months` copies wall-clock tzinfo across DST for generic zones (latent; IST has no DST — report M5).
- Sources: docs.python.org/3/library/datetime.html, dateutil.readthedocs.io/en/stable/relativedelta.html, getlago.com/blog/time-zone-nightmares.

---

### Net assessment
OyeChats already implements the **hardest-to-retrofit** defenses correctly (signature verification, event-id idempotency with the right atomic pattern, an event-sourced ledger with advisory locks, integer paise, aware-UTC time math, **and outbound-webhook SSRF re-validation at send time** — the L4 concern was withdrawn on verification). The gaps are concentrated in **reversal correctness** (refund scope C2, missing dispute handler H6, no `refund.failed` re-grant N1, double-clawback N2), **webhook failure handling** (C1), **mutation-path locking & per-bot routing** (H1, N3), and **coupon/discount limits** (C3) — all addressable without architectural change. One structural caveat: the **Stripe "fallback" is unbuilt** (N4), so the platform is effectively single-provider today. See the main report for severities and fixes.
