# Affiliate Program — v1 (Referral Code Only)

**Status:** Planned · **Owner:** TBD · **Target:** ~4 working days

This document is the implementation plan for v1 of the OyeChats affiliate program. **v1 is intentionally money-free** — it ships the referral-code mechanic, attribution, and analytics dashboards. The commission / discount / payout layer is deferred to v2, after we have real usage data from v1 to set commission rates against.

---

## 1. Goals

- Let a super admin invite up to 5 hand-picked affiliates.
- Let each affiliate create up to 10 active referral codes via a self-serve dashboard.
- Capture `?ref=CODE` from any oyechats.com URL → cookie → first-touch attribution at signup.
- Track clicks per code, signups per code, and click→signup conversion.
- Give the affiliate a dashboard for their own codes; give super admin a roll-up view of all affiliates.

## 2. Non-goals (deferred to v2)

| Deferred | Why deferred |
|---|---|
| Per-code commission % / customer discount % | Need real signup data first to pick sensible defaults |
| Discount applied at Razorpay/Stripe checkout | No money in v1 |
| `affiliate_commissions` ledger | No money in v1 |
| `affiliate_payouts` flow + KYC + TDS | No money in v1 |
| Refund / chargeback handling | No money in v1 |
| Multi-currency (INR + USD) accrual | No money in v1 |

When v2 lands, the v1 schema extends additively — `referral_codes` gets `customer_discount_bps` + `affiliate_commission_bps` columns (defaulting to 0), and two new tables (`affiliate_commissions`, `affiliate_payouts`) are added. **No data migration required.**

---

## 3. Architecture Summary

```
┌────────────────┐                       ┌─────────────────┐
│ Landing site   │  ?ref=CODE →          │ Backend API     │
│ oyechats.com   ├──── validate ────────►│ FastAPI         │
│ (Next.js)      │  ◄──── 200/404 ───────┤                 │
│                │  set oye_ref cookie   │ - validate      │
└────────┬───────┘                       │ - record click  │
         │ user clicks "Sign up"         │ - attribute     │
         ▼                               │ - dashboards    │
┌────────────────┐                       │                 │
│ Admin app      │  signup w/ cookie ───►│                 │
│ app.oyechats   │                       │                 │
│ (React)        │  /affiliate ─────────►│                 │
│                │  /superadmin/aff... ─►│                 │
└────────────────┘                       └────────┬────────┘
                                                  │
                                                  ▼
                                         ┌─────────────────┐
                                         │ PostgreSQL      │
                                         │ - affiliates    │
                                         │ - referral_codes│
                                         │ - referral_clicks│
                                         │ - clients (+2 cols)│
                                         └─────────────────┘
```

Three new tables, two new columns on `clients`. No webhook integration, no ARQ jobs, no Razorpay/Stripe changes.

---

## 4. Data Model

### 4.1 New tables

```sql
-- Enable case-insensitive text once; safe if already enabled.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── affiliates ────────────────────────────────────────────────
-- Soft membership flag tied to a Client. Invite-only, capped at 5.
CREATE TABLE affiliates (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL UNIQUE REFERENCES clients(id) ON DELETE RESTRICT,
    invited_by      BIGINT REFERENCES clients(id),
    max_active_codes INTEGER NOT NULL DEFAULT 10,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at  TIMESTAMPTZ,
    CONSTRAINT chk_max_active_codes_positive CHECK (max_active_codes > 0)
);
CREATE INDEX idx_affiliates_active ON affiliates(client_id) WHERE deactivated_at IS NULL;

-- ── referral_codes ────────────────────────────────────────────
-- The codes themselves. Code names are globally unique and case-insensitive.
CREATE TABLE referral_codes (
    id              BIGSERIAL PRIMARY KEY,
    affiliate_id    BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    code            CITEXT NOT NULL UNIQUE,
    label           TEXT,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at  TIMESTAMPTZ,
    CONSTRAINT chk_code_format CHECK (code ~ '^[A-Za-z0-9_-]{3,20}$')
);
CREATE INDEX idx_codes_active_per_affiliate
    ON referral_codes(affiliate_id) WHERE active = true;

-- ── referral_clicks ───────────────────────────────────────────
-- Append-only click log. IP and UA are hashed; we never store the raw values.
CREATE TABLE referral_clicks (
    id              BIGSERIAL PRIMARY KEY,
    code_id         BIGINT NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
    ip_hash         TEXT,            -- sha256(ip + daily_salt), 64 hex chars
    ua_hash         TEXT,            -- sha256(user_agent), 64 hex chars
    referrer        TEXT,            -- HTTP Referer header (trimmed to 500)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clicks_code_time ON referral_clicks(code_id, created_at DESC);
```

### 4.2 Columns on `clients`

```sql
ALTER TABLE clients
    ADD COLUMN referral_code_id BIGINT REFERENCES referral_codes(id),
    ADD COLUMN referral_attributed_at TIMESTAMPTZ;

-- Partial index — only the rows that actually have a referral
CREATE INDEX idx_clients_referral_code
    ON clients(referral_code_id) WHERE referral_code_id IS NOT NULL;
```

Both columns are `NULL`-able with no default → the migration is instant on a populated `clients` table (no rewrite).

### 4.3 SQLAlchemy models (location: `api/app/db/models.py`)

```python
from sqlalchemy.dialects.postgresql import CITEXT

class Affiliate(Base):
    __tablename__ = "affiliates"
    id = Column(BigInteger, primary_key=True)
    client_id = Column(BigInteger, ForeignKey("clients.id"), nullable=False, unique=True)
    invited_by = Column(BigInteger, ForeignKey("clients.id"))
    max_active_codes = Column(Integer, nullable=False, default=10)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    deactivated_at = Column(DateTime(timezone=True))

    client = relationship("Client", foreign_keys=[client_id], backref="affiliate")
    codes = relationship("ReferralCode", back_populates="affiliate")

class ReferralCode(Base):
    __tablename__ = "referral_codes"
    id = Column(BigInteger, primary_key=True)
    affiliate_id = Column(BigInteger, ForeignKey("affiliates.id"), nullable=False)
    code = Column(CITEXT, nullable=False, unique=True)
    label = Column(Text)
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    deactivated_at = Column(DateTime(timezone=True))

    affiliate = relationship("Affiliate", back_populates="codes")

class ReferralClick(Base):
    __tablename__ = "referral_clicks"
    id = Column(BigInteger, primary_key=True)
    code_id = Column(BigInteger, ForeignKey("referral_codes.id"), nullable=False)
    ip_hash = Column(Text)
    ua_hash = Column(Text)
    referrer = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
```

Add to existing `Client` model:

```python
class Client(Base):
    # ... existing fields ...
    referral_code_id = Column(BigInteger, ForeignKey("referral_codes.id"))
    referral_attributed_at = Column(DateTime(timezone=True))
```

---

## 5. API Surface

All routes mounted under `/api`. New file: `api/app/api/affiliate_routes.py`.

### 5.1 Public (no auth) — for landing site

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/affiliates/validate?code={code}` | Check a code is valid+active. Rate-limited 60/min/IP. Returns `{valid: bool, label?: string}`. |
| `POST` | `/api/affiliates/click` | Record a click. Body: `{code, referrer?}`. Hashes IP+UA server-side. Rate-limited 120/min/IP. Always returns 204. |

### 5.2 Affiliate (auth: `get_current_client` + `is_affiliate`) — self-service

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/affiliate/me` | Returns `{max_active_codes, created_at}` for the logged-in affiliate. |
| `GET` | `/api/affiliate/codes` | List my codes with click/signup counts. |
| `POST` | `/api/affiliate/codes` | Create a code. Body: `{code, label?}`. Enforces ≤ max_active_codes, format regex, global uniqueness. |
| `PATCH` | `/api/affiliate/codes/{id}` | Update label or deactivate. Cannot rename `code` after creation. |
| `GET` | `/api/affiliate/stats?from=&to=` | Aggregate metrics for date range. |

### 5.3 Super admin (auth: `get_current_client_strict` + `is_superadmin`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/superadmin/affiliates` | List all affiliates with totals. |
| `POST` | `/api/superadmin/affiliates` | Invite. Body: `{client_id OR email, max_active_codes?}`. Caps total active affiliates at 5. |
| `GET` | `/api/superadmin/affiliates/{id}` | Detail: affiliate + their codes + click/signup totals. |
| `PATCH` | `/api/superadmin/affiliates/{id}` | Override `max_active_codes`, deactivate. |

### 5.4 Signup integration

Modify existing `POST /register` (and any other client-creation paths) to accept an optional `referral_code` field. The attribution happens in a single atomic UPDATE — see §6.

---

## 6. The One Tricky Code Path — Atomic First-Touch Attribution

The only race-sensitive code in v1. Goes in `api/app/services/affiliate_service.py`:

```python
def attribute_signup(session: Session, client_id: int, code: str) -> bool:
    """
    Attribute a freshly-created client to a referral code. First-touch wins:
    if the client already has a ``referral_code_id`` set, this is a no-op.

    Returns True if attribution was applied, False otherwise. All failures
    (invalid code, self-referral, already attributed) are silent — we never
    block signup over a referral problem.
    """
    if not code:
        return False

    code_row = session.execute(
        select(ReferralCode).where(
            ReferralCode.code == code,
            ReferralCode.active == True,
        )
    ).scalar_one_or_none()
    if not code_row:
        return False

    # Self-referral block — affiliate can't use their own code.
    affiliate = session.get(Affiliate, code_row.affiliate_id)
    if affiliate.client_id == client_id:
        logger.warning("self_referral_blocked", client_id=client_id, code=code)
        return False

    # Atomic first-touch: only set referral_code_id if currently NULL.
    # If two requests race, exactly one wins; the other is a no-op.
    result = session.execute(
        update(Client)
        .where(Client.id == client_id, Client.referral_code_id.is_(None))
        .values(
            referral_code_id=code_row.id,
            referral_attributed_at=func.now(),
        )
    )
    return result.rowcount == 1
```

`update().where(referral_code_id IS NULL)` is the entire race-condition fix. No `SELECT FOR UPDATE` needed because we never read-then-write — Postgres does the conditional write atomically.

---

## 7. Frontend Surfaces

### 7.1 Landing site — `oyechats-website/` (Next.js)

**New file:** `src/lib/referral.ts`

```ts
const REF_PARAM = "ref";
const REF_COOKIE = "oye_ref";
const COOKIE_DAYS = 60;

export async function captureReferral() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const code = url.searchParams.get(REF_PARAM);
  if (!code) return;

  // Validate before setting the cookie — avoids polluting cookies with junk.
  const res = await fetch(`${API_BASE}/affiliates/validate?code=${encodeURIComponent(code)}`);
  if (!res.ok) return;
  const data = await res.json();
  if (!data.valid) return;

  // Set cookie scoped to .oyechats.com so admin app can read it.
  document.cookie = `${REF_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=${COOKIE_DAYS * 86400}; domain=.oyechats.com; SameSite=Lax; Secure`;

  // Fire-and-forget click record.
  fetch(`${API_BASE}/affiliates/click`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, referrer: document.referrer || null }),
  }).catch(() => {});
}
```

Call `captureReferral()` from the root layout's `useEffect`. The cookie persists across the subdomain hop to `app.oyechats.com/register`.

### 7.2 Admin app — `platform/app/`

**Affiliate dashboard** — new page `src/pages/AffiliateDashboard.jsx`, route `/affiliate`. Visible only when `client.is_affiliate === true` (add the flag to the existing `/client/settings` response).

Layout:

```
┌─────────────────────────────────────────────────────┐
│ Affiliate Program                                    │
│ 3 of 10 active codes                                 │
│                            [ + Create code ]         │
├─────────────────────────────────────────────────────┤
│ Code         Label              Clicks  Signups  Cv% │
│ ────────────────────────────────────────────────────│
│ PRIYA20      Twitter launch       247      18    7.3│
│ PRIYA-NL     Newsletter            89       4    4.5│
│ PRIYA-DEMO   Demo CTA              34      12   35.3│
└─────────────────────────────────────────────────────┘
```

`Create code` modal: `code` input (validate against `^[A-Za-z0-9_-]{3,20}$`), `label` input (optional), Save button.

**Super admin page** — new route under `/superadmin/affiliates` in the existing super-admin section. Same shape, but lists all affiliates and lets you invite/override/deactivate.

### 7.3 Signup capture — `platform/app/src/pages/Register.jsx` (or equivalent)

Read `oye_ref` cookie on mount, attach as `referral_code` field in the register POST body. Show a small "🎉 You're signing up via PRIYA20" badge above the form so the user knows attribution worked. Clear the cookie on successful signup (one-shot).

---

## 8. System Design Checklist (5 items)

The v1 minimum. Each has a one-line fix.

| # | Risk | Fix |
|---|---|---|
| 1 | Code namespace collision | `CITEXT UNIQUE` on `referral_codes.code` — DB rejects duplicates regardless of casing |
| 2 | Attribution race | Atomic `UPDATE WHERE referral_code_id IS NULL` (§6) |
| 3 | Self-referral | Application check on `affiliate.client_id == signup.client_id` (§6) |
| 4 | Code enumeration | SlowAPI `60/min/IP` on `/validate`, same response shape for valid+invalid |
| 5 | Click flood / DoS | SlowAPI `120/min/IP` on `/click`, fire-and-forget client-side (no UX blocking) |

That's the entire checklist for v1. The remaining 11 items from the earlier system-design discussion are money-layer concerns — they show up in v2.

---

## 9. Phased Build Order

### Phase 1 — Backend foundation (~1.5 days)

**Files to create/modify:**
- `api/alembic/versions/<hash>_add_affiliate_program.py` — migration
- `api/app/db/models.py` — `Affiliate`, `ReferralCode`, `ReferralClick`; add cols to `Client`
- `api/app/db/repository.py` — CRUD helpers
- `api/app/services/affiliate_service.py` — `attribute_signup`, `record_click`, `validate_code`
- `api/app/api/affiliate_routes.py` — public + affiliate routes
- `api/app/api/auth.py` — add `get_current_affiliate` dependency
- `api/app/main.py` — register the new router
- Modify existing register endpoint to call `attribute_signup` post-create.

**Acceptance:**
- Migration runs cleanly on a snapshot of production data.
- `curl /api/affiliates/validate?code=BOGUS` → 404; valid code → 200.
- A pytest end-to-end test signs up a client with a `referral_code` field and asserts `clients.referral_code_id` is set.
- A second pytest test signs up with a code, then tries to "re-attribute" with a different code — second call is a no-op.

### Phase 2 — Landing capture (~0.5 day)

**Files:**
- `oyechats-website/src/lib/referral.ts` — capture utility
- `oyechats-website/src/app/layout.tsx` — call `captureReferral()` on mount
- Optional: hero banner that renders "Save with this code" when a valid code is in the URL

**Acceptance:**
- Visiting `oyechats.com/?ref=PRIYA20` writes the cookie and records a click.
- Cookie persists when navigating to `app.oyechats.com/register`.

### Phase 3 — Affiliate dashboard (~1 day)

**Files:**
- `platform/app/src/pages/AffiliateDashboard.jsx` — main view
- `platform/app/src/components/affiliate/CreateCodeModal.jsx`
- `platform/app/src/services/api.js` — new endpoints
- `platform/app/src/App.jsx` — register `/affiliate` route
- `platform/app/src/components/Sidebar.jsx` (or equivalent) — conditional menu item

**Acceptance:**
- Affiliate logs in → sees `/affiliate` link → lands on dashboard.
- Creates a code via modal → appears in the table.
- Deactivates a code → row dims, no longer counts toward the 10-cap.
- Click + signup counts populate from real data.

### Phase 4 — Super admin (~0.5 day)

**Files:**
- `platform/app/src/pages/superadmin/AffiliateAdmin.jsx`
- `platform/app/src/App.jsx` — new route `/superadmin/affiliates`
- Wire into the existing super-admin nav

**Acceptance:**
- Super admin can invite up to 5 affiliates; 6th invite returns "limit reached".
- Per-affiliate detail shows their codes, total clicks, total signups.
- Deactivating an affiliate auto-deactivates their codes (existing signups keep their `referral_code_id` row reference).

### Phase 5 — QA + soft launch (~0.5 day)

End-to-end happy path:
1. Super admin invites `priya@example.com`.
2. Priya gets email → clicks invite → sets password → lands on `/affiliate`.
3. Priya creates `PRIYA20`.
4. From an incognito browser, visit `oyechats.com/?ref=PRIYA20`.
5. Cookie set, click recorded.
6. Sign up as `prospect@example.com`.
7. `clients.referral_code_id` for the new prospect = PRIYA20's id.
8. Priya refreshes `/affiliate` → sees Clicks=1, Signups=1, Conv%=100.
9. Super admin refreshes `/superadmin/affiliates` → sees Priya's aggregate.

Plus failure paths:
- Invalid code → no cookie set, no click recorded.
- Priya tries to use her own code → no attribution, but signup succeeds.
- 11th code creation → 400 with "active code limit reached".
- Code `AB` (too short) → 400 with format error.

---

## 10. Migration Safety

The migration touches a production table (`clients`). All operations must be **online-safe**:

```python
def upgrade():
    # 1. New extension — idempotent, instant.
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    # 2. New tables — instant, no data to lock.
    op.create_table("affiliates", ...)
    op.create_table("referral_codes", ...)
    op.create_table("referral_clicks", ...)

    # 3. Add nullable columns to clients — instant in PG 11+ (no rewrite).
    op.add_column("clients",
        sa.Column("referral_code_id", sa.BigInteger(), nullable=True))
    op.add_column("clients",
        sa.Column("referral_attributed_at", sa.DateTime(timezone=True), nullable=True))

    # 4. FK added separately, NOT VALID first, then validated.
    op.execute("""
        ALTER TABLE clients
        ADD CONSTRAINT fk_clients_referral_code
        FOREIGN KEY (referral_code_id) REFERENCES referral_codes(id)
        NOT VALID
    """)
    op.execute("ALTER TABLE clients VALIDATE CONSTRAINT fk_clients_referral_code")

    # 5. Index built without blocking writes.
    op.execute("CREATE INDEX CONCURRENTLY idx_clients_referral_code "
               "ON clients(referral_code_id) WHERE referral_code_id IS NOT NULL")
```

Rollback (`downgrade()`) drops in reverse order; ensure it actually works in dev before merging.

---

## 11. Testing Plan

**Unit (pytest):**
- `attribute_signup` happy path
- `attribute_signup` no-op when `referral_code_id` already set
- `attribute_signup` no-op when code is invalid / inactive / self-referral
- Code creation rejected past `max_active_codes`
- Code creation rejected on format violation
- Code creation rejected on duplicate (case-insensitive)
- Click insertion succeeds with hashed IP/UA

**Integration:**
- End-to-end signup with `?ref=` cookie → `clients.referral_code_id` set
- 5-affiliate cap enforced

**Manual QA checklist:** see Phase 5 above.

---

## 12. v2 Migration Path (preview)

When v2 (money layer) lands, the additive changes are:

```sql
ALTER TABLE affiliates
    ADD COLUMN max_commission_bps INTEGER NOT NULL DEFAULT 2500;  -- 25.00%

ALTER TABLE referral_codes
    ADD COLUMN customer_discount_bps INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN affiliate_commission_bps INTEGER NOT NULL DEFAULT 0;

CREATE TABLE affiliate_commissions ( ... );
CREATE TABLE affiliate_payouts ( ... );

ALTER TABLE subscriptions
    ADD COLUMN applied_discount_bps INTEGER NOT NULL DEFAULT 0;
```

Existing v1 codes default to `0/0` — they continue tracking but accrue no money. New codes created in v2 set splits via the slider UI. v1 attribution rows remain valid; no data backfill needed.

---

## 13. Decisions (locked in)

1. **Invite delivery** — Super admin enters an email → Brevo sends a magic-link → recipient clicks → sets password → lands on `/affiliate`. Mirrors the existing operator onboarding pattern. Supports inviting non-existing users.
2. **`is_affiliate` flag** — Derived, not stored. Add `affiliate` relationship to the `Client` model; `client.is_affiliate` becomes a `@property` that returns `True` when an active (non-deactivated) `affiliates` row exists. Single source of truth, no drift risk.
3. **Sidebar placement** — `/affiliate` shows as a conditional menu item in the existing customer-side sidebar. Affiliates see their normal nav (dashboard, leads, bots) plus the new `Affiliate` entry — because affiliates are likely paying customers too.
4. **`is_bot_manager` orthogonality** — `is_bot_manager` and affiliate status are independent. Being one does not imply the other.

---

## 14. Out of Scope (explicit)

To prevent scope creep during implementation, the following are **not v1**:

- Any commission / discount / payout logic
- Razorpay or Stripe touchpoints
- Cookie-less attribution (e.g. logged-in users)
- Email notifications on signup attribution
- Per-code custom landing pages or destination URLs
- Affiliate-to-affiliate referrals
- Multi-level (MLM) structures
- Bulk code import / CSV
- Webhook out to affiliate's own systems
- Per-affiliate custom branding

If any of these become must-haves mid-build, write a separate v1.5 doc — don't expand this one.
