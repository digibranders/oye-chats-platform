# Impersonation Redemption — turning an issued token into a real customer session

**Status:** Approved design · **Date:** 2026-08-05 · **Area:** Super-admin support tooling
**Repos touched:** `oye-chats-platform/api`, `oye-chats-platform/app`, `oyechats-admin`
**Depends on:** the existing issue + revoke endpoints (`superadmin_routes_v2.py:281`, `:323`) and
the `impersonation_tokens` table (`models.py:1810`) — both already shipped.

---

## 1. Problem & Goal

Impersonation is **half-built**. The super-admin side works: `/impersonate` mints a
`secrets.token_urlsafe(32)`, stores its sha256 in `impersonation_tokens`, writes a
`client.impersonate` audit row, shows a red banner, and can revoke server-side.

But **nothing redeems the token.** `ImpersonationToken` is referenced only by `models.py`
and `superadmin_routes_v2.py`; the string `impersonation` does not appear anywhere in
`oye-chats-platform/app` — not in `src/`, not in the built `dist/`. So the flow ends at:

```
redirect_url = "https://app.oyechats.com/?impersonation=<raw>"   # superadmin_routes_v2.py:319
```

…which opens the customer app, which ignores the query parameter entirely and renders
whatever session that browser already had (or the login screen). The banner, the 30-minute
expiry and the revoke endpoint are all real — they just guard a session that never begins.

**Goal:** make the token redeemable, so a super-admin genuinely sees the product as the
Account sees it, with expiry and revocation enforced on *every request*, and with a
blast radius small enough that a support session cannot cost the customer money.

## 2. Non-Goals (YAGNI)

- Session recording / replay of impersonated activity.
- Impersonating an **Operator** (only Account owners for now).
- Time extension or renewal — expired means mint a new token.
- Any change to how customers themselves authenticate.
- A super-admin UI listing currently-active impersonation sessions.

## 3. Key Constraints (these ground the whole design)

**3.1 There is no JWT. The only client credential is permanent.**

`get_current_client` (`auth.py:152`) resolves `X-API-Key` against `Client.api_key`, a
permanent UUID column. There is no expiry, no rotation-on-use, no session table.

> **Therefore the redemption endpoint must never return the Account's `api_key`.**
> Doing so would hand the admin a credential that outlives the 30-minute window, ignores
> `revoked_at`, and survives until someone manually rotates the key. Expiry and revoke
> would become decorative.

**3.2 The matched route is visible from inside a dependency.** Verified empirically on
this stack (`fastapi 0.135.3`, `starlette 0.52.1`): `request.scope["route"].endpoint` is
populated before dependencies resolve, and reads attributes set by a decorator.
`scope["endpoint"]` does **not** exist in this version — use `scope["route"].endpoint`.

**3.3 The customer app shares auth across tabs by design.** `authStorage.js` deliberately
moved auth to `localStorage` because `sessionStorage` broke second tabs. An impersonation
session must therefore **not** be written into that shared bundle, or it would stomp the
admin's own genuine session in unrelated tabs.

## 4. Architecture — the token *is* the session

The raw token is promoted from a one-shot handoff coupon to a first-class, expiring auth
credential carried on every request as `X-Impersonation-Token`.

```
┌ oyechats-admin ────────┐        ┌ api ──────────────────────────┐
│ POST /clients/{id}/    │───────▶│ mint raw + store sha256       │
│      impersonate       │        │ audit: client.impersonate     │
└────────────────────────┘        └───────────────────────────────┘
             │ window.open(APP_BASE_URL/?impersonation=<raw>)
             ▼
┌ oye-chats-platform/app ─────────────────────────────────────────┐
│ 1. read ?impersonation=<raw>                                    │
│ 2. history.replaceState → strip param IMMEDIATELY               │
│ 3. POST /auth/impersonation/redeem {token}                      │
│ 4. store in sessionStorage (tab-scoped)  ← never localStorage   │
│ 5. interceptor sends X-Impersonation-Token, NOT X-API-Key       │
└─────────────────────────────────────────────────────────────────┘
             │ every subsequent request
             ▼
┌ api / get_current_client ───────────────────────────────────────┐
│ sha256(header) → impersonation_tokens                           │
│   WHERE token_hash = ? AND revoked_at IS NULL AND expires_at>now│
│ → target Client, tagged _impersonator_id / _impersonation_id    │
│ → write guard (§6)                                              │
└─────────────────────────────────────────────────────────────────┘
```

Because validity is re-checked per request, **Exit in the super-admin banner kills an
in-flight session immediately** — the next request the impersonated tab makes 401s.

## 5. Auth Resolution

A third branch in `get_current_client`, mirrored in `get_current_client_strict`
(`auth.py:448`) and `get_current_client_or_operator` (`auth.py:277`):

```python
if impersonation_token:
    token_hash = hashlib.sha256(impersonation_token.encode("utf-8")).hexdigest()
    record = session.execute(
        select(ImpersonationToken).where(
            ImpersonationToken.token_hash == token_hash,
            ImpersonationToken.revoked_at.is_(None),
            ImpersonationToken.expires_at > datetime.now(UTC),
        )
    ).scalars().first()
    if not record:
        raise HTTPException(401, "Impersonation session expired or revoked.")
    client = session.get(Client, record.target_id)
    ...
    client._impersonator_id = record.actor_id
    client._impersonation_token_id = record.id
    session.expunge(client)
    return client
```

Rules:

- **Precedence:** `X-Impersonation-Token` wins over `X-API-Key` when both are present.
  The frontend sends only one; the backend is explicit so the ambiguity has a defined answer.
- **Tagging:** attributes are set on the expunged instance, so downstream code and audit
  writers can distinguish "the customer did this" from "an admin did this as the customer".
- **Timing safety:** lookup is by hash equality on an indexed unique column
  (`ix_impersonation_tokens_token_hash`) — the raw token is never compared in Python.
- **Bot keys remain excluded**, exactly as today.

## 6. The Write Guard — default-deny, marked-allow

Approved scope is *read + safe writes*. Enforcement is **fail-closed**: with an
impersonation credential, any request whose method is not `GET`/`HEAD`/`OPTIONS` is
rejected **unless** the matched endpoint carries an explicit marker.

```python
def impersonation_writable(fn):
    """Permit this endpoint to be called by an impersonated super-admin session.

    MUST be applied BELOW the route decorator so the router registers the
    already-marked function:

        @router.post("/bots/{bot_id}/canned-responses")
        @impersonation_writable
        def create_canned_response(...): ...
    """
    fn.impersonation_writable = True
    return fn
```

The guard runs inside the auth dependency, reading `request.scope["route"].endpoint`.

**Why not the denylist:** a denylist fails *open* — a mutating route added later is
permitted until someone remembers to list it. Default-deny inverts that: a new route is
inert under impersonation until a human deliberately marks it. Same capability, opposite
failure mode.

### 6.1 Initial allowlist (marked writable)

| Surface | Rationale |
|---|---|
| AI Agent config edits (name, greeting, tone, appearance) | The most common "it looks wrong" report |
| Canned-response CRUD | Pure content, reversible |
| Conversation status / assignment changes | Reproduces Support triage bugs |
| Preview-mode test chat | Owner-preview replies skip deduction entirely (`chat_routes.py:386`, `:519`) — costs the Account nothing |
| Department edits (not invites) | Config only |

### 6.2 Denied by construction (unmarked)

Billing, subscription, credits and payment routes · API-key rotation · Account or AI Agent
deletion · Operator invites (would send email over the customer's name) · outbound
messages to real Leads · everything not yet marked.

## 7. Redeem Endpoint

`POST /auth/impersonation/redeem` — unauthenticated (the token *is* the authentication).

```jsonc
// request
{ "token": "<raw>" }

// 200
{
  "client_id": 42,
  "name": "Acme Corp",
  "email": "owner@acme.com",
  "expires_at": "2026-08-05T12:30:00Z",
  "actor_email": "admin@oyechats.com",   // who is watching — shown in the banner
  "is_impersonation": true
}
// 401 — expired, revoked, or unknown token
```

Deliberately **not** returned: `api_key`, and any other credential.

The call does **not** burn the token — it is a bearer credential for its remaining life,
and the tab may reload. It is rate-limited via the existing `app/core/rate_limit.py`
helper (an unauthenticated endpoint that validates a secret must not be brute-forceable)
and writes a `client.impersonate_redeem` audit row.

## 8. Frontend — customer app (`oye-chats-platform/app`)

**Bootstrap** (`main.jsx`, before the auth/expiry guard):

1. Read `?impersonation=` from the URL.
2. `history.replaceState` it away **before any network call** — kills the leak into
   browser history, `Referer` headers and any access log downstream.
3. `POST /auth/impersonation/redeem`.
4. On success write `impersonation_token` + profile to **`sessionStorage`** (tab-scoped:
   closing the tab ends the session, and it cannot collide with the shared `localStorage`
   auth bundle described in §3.3). On failure, render "This impersonation link has expired
   or been revoked" and stop — do not fall through to the login screen.

**Request interceptor** (`api.js:118`): when an impersonation token is present, send
`X-Impersonation-Token` and **suppress** `X-API-Key`, `X-Workspace-Id` and `X-Acting-Role`.

**Response interceptor:** a 401 while impersonating clears only the sessionStorage keys
and shows "Impersonation session ended". It must **not** enter `clearAuthStorage()`, which
would wipe the admin's real credentials in every other tab.

**Banner:** persistent red bar — *"Viewing **Acme Corp** as super-admin admin@oyechats.com ·
safe actions only · expires 12:30"* — plus Exit, which clears sessionStorage and closes
the tab. Visually distinct from the customer's own banners.

## 9. Audit

- `client.impersonate_redeem` on redemption (actor, target, token id, IP).
- Every **permitted write** under impersonation writes an audit row carrying
  `_impersonator_id`, so the trail answers "who actually did this" rather than
  attributing an admin's edit to the customer.
- Rejected writes are logged at WARN with actor, target and route — a spike means the
  allowlist is wrong, or someone is probing.

## 10. Security Notes

- **Query-string exposure.** The raw token still arrives in a URL. Mitigated by immediate
  `replaceState`, the 30-minute ceiling, per-request revocation checks, and single-hop use.
  A POST-based cross-origin handoff would remove it entirely but needs a form-post bridge;
  judged not worth the complexity at this expiry length. Revisit if expiry ever grows.
- **`APP_BASE_URL`.** `https://app.oyechats.com` is hardcoded at
  `superadmin_routes_v2.py:319`, so impersonation can never work against localhost or
  staging. Becomes `os.getenv("APP_BASE_URL", "https://app.oyechats.com")`, following the
  existing convention — this codebase has no `Settings` class; `app/core/` reads env vars
  inline (see `middleware.py:105`, `rate_limit.py:21`). Default preserves today's behaviour.
- **No privilege escalation.** Impersonating an Account whose `is_superadmin` is true is
  rejected at mint time (the `/impersonate` page already filters these out; the backend
  will now enforce it rather than trusting the UI filter).

## 11. Open Decisions

Both are implemented at the **safe** default below; flipping either is a one-line change.

| # | Decision | Default shipped | Flip if |
|---|---|---|---|
| D-1 | Train / recrawl under impersonation | **Denied** — it spends the Account's credits | You want to reproduce training failures directly, accepting the credit cost |
| D-2 | Impersonating suspended / deactivated Accounts | **Allowed** — `_ensure_client_authenticatable` is bypassed on this path, because debugging *why* an Account is suspended is a real support need and the write guard caps the damage | You'd rather suspended Accounts be entirely sealed |

## 12. Test Plan (TDD — written before implementation)

**Redeem** — valid token; expired; revoked; unknown; malformed/empty; response never
contains `api_key`.

**Auth resolution** — token resolves to the target Account; revoking mid-session 401s the
very next request; expiry boundary; `X-Impersonation-Token` beats `X-API-Key`; a bot key
still cannot resolve to a Client.

**Write guard** — unmarked `POST` → 403; marked `POST` → 200; `GET` always allowed;
**regression guard:** a newly-registered unmarked mutating route is denied by default
(this is the test that keeps the fail-closed property true over time).

**Audit** — `impersonate_redeem` row on redemption; a permitted write carries the
impersonator id.

**Frontend** — lint + build on both apps, plus browser verification of the full loop:
mint in super-admin → land in customer app → banner shows the right Account and admin →
a denied action surfaces a clear message → Exit revokes → the tab's next request 401s.

## 13. Files Touched

| File | Change |
|---|---|
| `api/app/api/auth.py` | impersonation resolution branch; `impersonation_writable`; write guard |
| `api/app/api/auth_routes.py` | `POST /auth/impersonation/redeem` |
| `api/app/api/bot_routes.py`, `canned_response_routes.py`, `lead_routes.py`, `chat_routes.py`, `operator_routes.py` | apply the `@impersonation_writable` marker to the §6.1 endpoints |
| `api/app/api/superadmin_routes_v2.py` | `APP_BASE_URL`; reject superadmin targets at mint |
| `app/src/main.jsx` | bootstrap: read → strip → redeem → store |
| `app/src/services/api.js` | header swap; impersonation-aware 401 handling |
| `app/src/utils/authStorage.js` | tab-scoped impersonation keys, excluded from the shared bundle |
| `app/src/components/ImpersonationBanner.jsx` | new — customer-side banner |

`oyechats-admin` needs **no change**: both call sites already open the server-returned
`redirect_url` verbatim (`impersonate/page.tsx:31`, `clients/[id]/page.tsx:101`), so
pointing `APP_BASE_URL` at localhost or staging works without touching the frontend.

## 14. Rollout

Additive and reversible: no migration (the table already exists), no change to customer
auth. Shipping the backend before the frontend leaves the current state unchanged (a
token nothing redeems). The kill switch is an `IMPERSONATION_ENABLED` flag defaulting on —
flipping it off disables redemption while leaving mint/revoke intact.
