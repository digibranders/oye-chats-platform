# OyeChats Feature — Affiliate / Referral Program

*This document is self-sufficient as a NotebookLM knowledge source on ONE OyeChats feature: the Affiliate/Referral Program. Evidence tags: [T1] = confirmed directly in running code, [T2] = confirmed in code comments/docstrings describing intended behavior, [VERIFY] = plausible but not independently confirmed in this pass.*

---

## 1. What This Feature Is

OyeChats runs a small, invite-only **affiliate/referral program**: a hand-picked group of partners get a personal referral code, share it, and when someone signs up through that code, the platform tracks the click, the signup, and (optionally) a revenue split — all inside the same admin dashboard the partner already uses. [T1, `api/app/services/affiliate_service.py`]

It is explicitly versioned as **v1**, and the code says so directly: *"v1 scope is intentionally limited to the referral-code mechanic — no commission %, no customer discount, no payouts. Those land in v2."* [T2, docstring, `affiliate_service.py` lines 9–11] — this framing note is itself important context: the code comment describes v1 as commission-free, but the same file's live logic (see §3) already implements commission splits and per-customer earnings math. Treat the "no commission" line as a stale comment, not current behavior — the working code is the source of truth, and it clearly computes and displays commission splits.

## 2. Who Cares & Why

This feature has a **different audience angle** than every other OyeChats feature doc in this set. It is not aimed at the core buyer persona (a CEO/CMO evaluating OyeChats to install on their site). It's aimed at:

- **Existing OyeChats customers or partners** who want to earn by referring other businesses to the platform.
- **The OyeChats super-admin/growth team**, who hand-pick and manage the (currently capped at 5) active affiliate seats. [T1, `MAX_ACTIVE_AFFILIATES = 5`, `affiliate_service.py` line 35]

Frame it as "how OyeChats grows through its own best customers," not as a core product capability a prospective buyer is choosing OyeChats *for*.

## 3. How It Actually Works

**Becoming an affiliate** — two paths, both admin-initiated (there is no public "become an affiliate" self-serve signup):
- **Existing OyeChats customer** → an `Affiliate` row is created instantly against their account. [T1, `invite_affiliate()`, lines 900–974]
- **Someone with no OyeChats account yet** → a magic-link email invite is sent with a 14-day-expiring, single-use token (`INVITE_TTL_DAYS = 14`); accepting it creates both a new Client account and the Affiliate record atomically. [T1, lines 48, 1033–1099]

**Referral codes** — each affiliate creates their own short codes (3–20 characters, letters/digits/`_`/`-`), up to a per-affiliate cap (default 10 active codes). [T1, `CODE_REGEX`, `DEFAULT_MAX_ACTIVE_CODES = 10`, lines 39, 43]

**Attribution (tracking)** — first-touch, race-safe:
- A visit to the marketing site with `?ref=CODE` logs a hashed click (IP and user-agent are SHA-256 hashed with a rotating daily salt — raw values are never stored). [T1, `record_click()`, lines 216–245]
- When that visitor signs up, `attribute_signup()` atomically claims the referral — first code wins, an affiliate cannot refer themselves, and the whole flow fails silently rather than blocking signup if anything about the referral is invalid. [T1, lines 263–351]

**Commission / reward structure** — configurable in basis points (bps), not a fixed platform-wide number:
- Each affiliate has a **pool** (`commission_bps`, set by a super-admin per affiliate — e.g. 25%). [T1, line 665]
- Each individual code then splits that pool between **what the affiliate keeps** (`affiliate_commission_bps`) and **what the referred customer gets as a discount** (`customer_discount_bps`) — the two must not exceed the affiliate's pool, and the customer-facing discount is separately hard-capped at 50% (`MAX_CUSTOMER_DISCOUNT_BPS = 5000`) so a code can never make a plan near-free. [T1, lines 57–63, 357–388]
- There is **no fixed commission percentage to cite** — it is per-affiliate and admin-configured. Do not state a specific number (e.g. "20% commission"); refer to it as "a percentage the OyeChats team sets per partner," not a fixed rate.

**Payouts** — [VERIFY]: no payout/payment-execution code was found in this pass (`affiliate_service.py`, `affiliate_routes.py`). The system calculates *earned* amounts (see §4) in the currency the referred customer is actually billed in (INR, via Razorpay — OyeChats' single payment rail), but how/whether that money is actually paid out to the affiliate was not confirmed in code.

## 4. What It Looks Like

The affiliate-facing surface is a page inside the Admin Dashboard — `Workspace ▸ Affiliate` — described in its own source comment as: *"One job: answer 'How are my referral codes performing, and how do I share them?'"* [T1, `app/src/features/affiliate/AffiliatePage.tsx` lines 1–10]

Confirmed UI elements:
- A **header showing the affiliate's commission pool** and four headline stat counters (from `get_affiliate_stats`: total clicks, total signups, active codes, conversion %). [T1, `AffiliatePage.tsx` lines 89–99; `affiliate_service.py` lines 853–879]
- A **table of the affiliate's referral codes**, each with a one-click **"Copy link"** button (uses the browser clipboard API, with a self-resetting "Copied" confirmation state). [T1, `CopyLinkButton`, lines 51–85]
- **Inline activate/deactivate toggle** per code, respecting the active-code cap. [T1, lines 101–115]
- A **"Create code" modal** and an **"Edit code" modal** for managing individual codes and their splits. [T1, imports lines 34–35]
- A **"Referrals" modal** per code, showing the masked list of who signed up through it (email shown as `s***@***.com` on the affiliate's own view — full email is only visible to the super-admin). [T1, `_mask_email()`, `affiliate_service.py` lines 698–706]
- Uses the shared OyeChats design system components (`Card`, `MetricCard`, `DataTable`, `StatusBadge`, etc.) — same "Voltage Paper" visual language as the rest of the admin dashboard, not a bespoke look. [T1, imports lines 18–30]
- Email templates exist for the two affiliate lifecycle moments: a welcome email (instant-affiliate path) and an invite email (magic-link path). [T1, `api/emails/gallery/affiliate-welcome.html`, `affiliate-invite.html`]

## 5. A Real Scenario Walkthrough

1. The OyeChats team decides to invite a happy customer to the affiliate program. A super-admin sends an invite from the super-admin console; since this person already has an OyeChats account, an `Affiliate` row is created instantly and they receive a welcome email pointing them to `/affiliate`.
2. They open **Workspace ▸ Affiliate**, see their commission pool (e.g. a percentage the OyeChats team set for them), and create a referral code — say `SARAH20` — choosing how the pool splits between what they earn and what a referred customer saves.
3. They copy the share link (the referral base URL plus `?ref=SARAH20`) and post it somewhere their audience will see it.
4. A visitor clicks the link, lands on the OyeChats marketing site — a hashed, privacy-preserving click is logged against `SARAH20`.
5. That visitor signs up for OyeChats. The signup is atomically attributed to `SARAH20` — first-touch, race-safe, and silent-fail if anything about the referral was invalid (signup itself is never blocked by a referral problem).
6. Back in the affiliate's dashboard, the code's row now shows one more click and one more signup, and the conversion percentage updates. Opening the "Referrals" modal on that code shows the new signup (masked email) and, once that customer has an active paid subscription, the affiliate's per-customer earnings distribution.

## 6. Capabilities vs Limits

**Confirmed capabilities:**
- Invite-only enrollment, capped at 5 simultaneously active affiliates platform-wide. [T1, line 35]
- Per-affiliate configurable commission pool; per-code configurable split between affiliate earnings and customer discount.
- Race-safe, first-touch, privacy-preserving (hashed IP/UA) click and signup attribution.
- Self-referral blocked at the service layer.
- Renaming a code breaks its old share link immediately, but does not lose historical attribution (codes are referenced by internal ID, not string). [T1, lines 470–478]
- Deactivating an affiliate cascades to deactivate all their active codes, but never deletes historical referral data. [T1, lines 1285–1290]
- Hard-deleting an affiliate is supported (super-admin only) and is explicitly irreversible for historical attribution on referred clients. [T1, lines 1357–1391]

**Explicit limits:**
- **No public self-serve enrollment.** You cannot "become an affiliate" by signing up; it is admin/invite-driven only. [T1, no such route found]
- **No fixed, universal commission percentage** — it varies per affiliate and is admin-set. [VERIFY if a specific number is needed for any script — do not invent one]
- **No confirmed automated payout mechanism** in the code reviewed. [VERIFY]
- Only 5 active affiliate seats exist platform-wide at time of writing — this is a small, curated program, not a mass-market affiliate network. [T1, line 35]

## 7. Evidence & Open [VERIFY] Items

| Claim | Status | Source |
|---|---|---|
| v1 program is invite-only, capped at 5 active affiliates | [T1] | `affiliate_service.py:35` |
| Per-code split between affiliate commission and customer discount, capped at pool and at 50% customer discount | [T1] | `affiliate_service.py:57–63, 357–388` |
| First-touch, race-safe, hashed-privacy click/signup attribution | [T1] | `affiliate_service.py:216–351` |
| Affiliate dashboard UI (stats, code table, copy-link, modals) | [T1] | `app/src/features/affiliate/AffiliatePage.tsx` |
| Payout/payment execution mechanism to affiliates | **[VERIFY]** | Not found in `affiliate_service.py` or `affiliate_routes.py` in this pass |
| "v1 has no commission" docstring vs. live commission-split code | **Resolved as stale comment** | Docstring (`affiliate_service.py:9–11`) contradicts the working `_validate_split`/`create_code` logic in the same file — the code, not the comment, is treated as authoritative here |
| Public/self-serve affiliate signup | **Confirmed absent** | No such route found in `affiliate_routes.py` in this pass |
