
## Superadmin client lifecycle levers (restore + verify)
**What:** Two superadmin endpoints and matching oyechats-admin buttons: clear `Client.deactivated_at` (restore a post-trial-deleted account) and set `Client.is_verified = true` (unblock a customer who cannot receive the OTP).
**Why:** The 2026-08-28 production incident (client 3, gaurav@fynix.digital) needed raw SQL because no restore path exists anywhere in the product, while three separate error messages tell customers "contact support to restore it". The new trial-ended email additionally promises reversibility. The admin console's Suspend button is also a no-op (no onClick) despite the backend endpoint existing at `superadmin_routes_v2.py:318` — wire it in the same pass.
**Pros:** Support stops being sent to a dead end; the product stops promising a capability that does not exist.
**Cons:** Superadmin-gated writes to auth-adjacent state; needs audit logging like the other v2 overrides.
**Context / start here:** `api/app/api/superadmin_routes_v2.py:318` (the suspend pattern to mirror), `oyechats-admin/src/app/(dashboard)/clients/[id]/page.tsx:167` (the dead Suspend button). Every write to `Client.deactivated_at` today: `worker/tasks.py:1515` (sets), nothing clears it. Also surface `deactivated_at` on both client screens — a deleted account currently renders as "Active".
**Depends on:** nothing; independent of the trial-model plan.
