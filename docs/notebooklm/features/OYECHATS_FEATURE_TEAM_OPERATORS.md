# OyeChats Feature — Team & Operator Management

*This document is a self-contained NotebookLM knowledge source on ONE OyeChats feature: inviting teammates, managing roles and departments, tracking presence, and multi-device notification alerts. Evidence tags: [T1] = confirmed directly in backend/frontend code, [T2] = confirmed in code comments/docstrings describing intended behavior, [VERIFY] = plausible but not independently confirmed in this pass.*

---

## 1. What This Feature Is

Team & Operator Management is how a business adds its own people to OyeChats so they can take over conversations the AI hands off. A business owner invites a teammate by email; the teammate accepts and becomes an **Operator** — a scoped-access team member who can see and answer live chats, but who does not get the full account-owner's keys to the workspace. [T1: `api/app/api/invite_routes.py`, `api/app/api/operator_routes.py`]

It covers four connected pieces:
1. **Invites** — owner/admin sends an email invite; the invitee accepts and becomes an Operator. [T1: `invite_routes.py`]
2. **Roles** — `owner`, `admin`, `operator`, each with a strict privilege hierarchy. [T1: `operator_routes.py` `_ROLE_RANK`]
3. **Departments** — groups of Operators (e.g. "Sales", "Support") with their own business hours, used to route live chats. [T1: `operator_routes.py` Department endpoints]
4. **Presence & notifications** — who's online right now, and how an Operator gets pinged (in-app bell + Web Push to their phone/desktop) when a visitor needs a human. [T1: `operator_presence_service.py`, `notification_service.py`, `push_service.py`]

## 2. Who Cares & Why

- **The business owner** — wants their support/sales team actually working inside OyeChats without handing every teammate the master account login.
- **A team lead / admin** — wants to organize the team into departments (Sales vs. Support), each with its own hours, so handoffs route to the right group.
- **An individual Operator (teammate)** — wants to know the moment a visitor needs them, wherever they are — not just while staring at the dashboard tab.

## 3. How It Actually Works

**Invite flow** [T1: `invite_routes.py`]
- Owner/admin sends an invite: target email, which AI Agent (bot) the Operator will handle, a role (`operator` or `admin` — an invite can never grant `owner`), and optionally a department.
- The system generates a single-use, 256-bit token and emails an accept link via Brevo (`send_operator_invite_email`). Rate-limited to 15 invites/hour and 10 resends/hour per workspace.
- The invite has a lifecycle: `pending → accepted | revoked | expired`. Invites auto-expire after 7 days; the owner can revoke a pending invite or resend it (which rotates the token). [T1]
- The invitee opens an "airlock" page (unauthenticated-safe preview showing workspace name, inviter, role, status), signs up or logs in as themselves, then accepts — this creates their Operator record scoped to that one workspace and bot. [T1]
- A legacy password-only Operator account (not linked to a full Client identity) cannot itself send invites — only an owner or a linked-identity admin can. [T1: comment in `invite_routes.py`, "legacy_operator_cannot_invite"]
- The workspace **owner can also add themselves as an Operator** ("self-operator") to personally take live chats, without a separate invite — this consumes one operator seat just like an invited teammate, matching how Slack/Intercom/Notion count the owner as one of the seats. [T1: `SelfOperatorRequest`/`add_self_as_operator`, explicit code comment citing this rationale]

**Roles & scoped access** [T1: `operator_routes.py`]
- Three roles, ranked `operator < admin < owner`.
- An Operator can never assign a role higher than their own (no self-escalation) — enforced server-side (`_prevent_role_escalation`), not just hidden in the UI.
- Only a true workspace owner (or an operator whose own role is `owner`) can promote someone else to `owner`.
- An Operator can only edit their **own** name/email — an admin editing someone else's row cannot silently change that person's identity fields, only their role/department/bot assignment/limits.
- **One-to-one Operator↔Bot binding**: each Operator is scoped to exactly one AI Agent (bot). They only see and can accept chats for that bot — a workspace running multiple bots keeps its teams cleanly separated. [T1]

**Departments** [T1: `operator_routes.py` Department CRUD]
- A workspace's first Operator auto-creates a default "General" department if none exists yet.
- Each department can have its own **business hours** (JSONB schedule) — e.g. Sales open 9–6, Support open 24/7 in the *same* workspace — and live-chat routing/handoff availability is resolved per-department against these hours. [T1: `update_department`, `live_chat_availability_service`]
- Deleting a department doesn't delete its people — Operators are simply unassigned (moved to no department), never removed.

**Presence (who's online right now)** [T1: `operator_presence_service.py`]
- Redis-backed heartbeat: each connected Operator's dashboard sends a heartbeat roughly every 30 seconds; presence has a 60-second TTL, so missing two heartbeats drops them from "online."
- Falls back gracefully to Postgres `last_seen_at` if Redis is unavailable, so a Redis blip doesn't take live chat fully offline — this is explicitly documented in code as a deliberate degraded-mode design, not an oversight.
- Presence drives real product decisions, not just a UI dot: the live-chat routing/availability engine uses it to decide whether a visitor sees "an agent is available," gets queued, or falls back to the offline-message form.

**Notifications & multi-device alerts** [T1: `notification_service.py`, `push_service.py`, `notification_broadcaster.py`]
- Two channels: an in-app bell/banner (persisted, so an Operator who was on a different tab still sees the request when they switch back) and **Web Push** to phone/desktop.
- Push is categorized so Operators can opt out selectively, not all-or-nothing: `handoff_request` (includes escalations/expirations), `chat_transferred`, `offline_message`. [T1: `_EVENT_CATEGORY` in `push_service.py`]
- Operators can set **quiet hours** (a `HH:MM`–`HH:MM` window in their own timezone) during which push is suppressed. [T1: `QuietHoursModel`, `_in_quiet_hours`]
- The system is push-aware in its handoff logic itself: if no one is watching the dashboard live (no active WebSocket) but there IS at least one Web Push subscriber in the workspace, a visitor's handoff request is still queued and a push fired — rather than immediately dumping the visitor into an offline contact form. This "promote from offline-form to queued+push" logic is explicit in code, not incidental. [T1: `request_handoff`, `promoted_from_offline_form`]

## 4. What It Looks Like

- **Workspace → Members page** (`app/src/features/workspace/MembersPage.tsx`) — the live Admin 2.0 surface for this feature. Two tabs: **People** and **Departments**. [T1]
  - People tab: a roster table (avatar-with-initial, name, role badge, department, presence badge "Online"/"Offline" with a colored dot, active-chat count, last-seen date), plus a pending-invites section (email, role, status, resend/revoke actions), and an "Invite" call-to-action.
  - Role badges use tone-coding: `owner` = accent, `admin` = info, `operator` = neutral — consistent with the rest of the Admin 2.0 design system.
  - Departments tab: department cards/rows with name, description, and a business-hours editor per department.
  - Seat/quota UI: a `QuotaMeter` component and `LockedFeatureCard` are used on this page — meaning operator seats are plan-limited and the UI itself surfaces "you're at your limit, upgrade" states, not just the backend 403. [T1: imports in `MembersPage.tsx`]
- Notification preferences (push on/off, per-category opt-out, quiet hours) live under **Settings → Notifications** (`app/src/features/settings/NotificationsSection.tsx`). [T1: file exists; exact on-screen layout **[VERIFY]** — not read in this pass]

## 5. A Real Scenario Walkthrough

1. Priya, the owner of a mid-size D2C brand's OyeChats workspace, goes to **Workspace → Members → Invite**. She invites `rahul@brand.com` as an `operator` on her "Sales Agent" bot.
2. Rahul gets an email, clicks the accept link, lands on the airlock page showing "You've been invited to join [Brand]'s workspace as an Operator," signs up, and accepts. He's now a scoped Operator — he can see and answer live chats for the Sales bot only, nothing else in the workspace.
3. Priya creates two departments: "Sales" (9am–6pm) and "Support" (24/7), and assigns Rahul to Sales.
4. Rahul opens the dashboard on his laptop each morning — his presence heartbeat marks him "Online." He also has Web Push enabled on his phone, with quiet hours set 10pm–8am.
5. A website visitor asks a question the AI can't confidently answer and requests a human. Because it's during Sales' business hours and Rahul is online, the availability engine routes the handoff to him — he gets both an in-app bell alert and a push notification.
6. That evening, another visitor requests a handoff outside Sales hours. No Operator is online on the dashboard, but Rahul still has a push subscription — the system queues the visitor and fires a push (his quiet hours haven't started yet), rather than immediately showing the visitor an offline form.
7. Priya later reviews the Members page: sees Rahul's active-chat count, last-seen time, and can promote him to `admin` if she wants him managing invites too — but she personally remains the only one who can name a new `owner`.

## 6. Capabilities vs Limits

**Confirmed capabilities:**
- Email-based invite flow with expiry, resend, and revoke. [T1]
- Three-tier role hierarchy with server-enforced no-self-escalation. [T1]
- Departments with independent business-hours schedules. [T1]
- Redis-backed real-time presence with DB degraded-mode fallback. [T1]
- Two-channel notifications (in-app + Web Push) with category-level opt-out and quiet hours. [T1]
- Push-aware handoff routing (queues via push even with zero active dashboard viewers). [T1]
- Plan-gated operator seat limits, enforced per-bot (not workspace-wide), with a self-heal 409 guard against concurrent seat races. [T1]

**Known limits / not positioned:**
- Operators are **one-to-one bound to a single bot** — an Operator cannot be shared across multiple AI Agents in the same workspace; each bot needs its own Operator assignment. [T1] This is an architectural fact worth stating plainly rather than glossing over — don't imply "one team serves all your agents."
- Only `operator` and `admin` can be *invited*; `owner` is not an invitable role — there is exactly one path to owner-level access (being the account itself, or being promoted by an existing owner). [T1]
- Legacy password-only Operator accounts (not linked to a Client identity) cannot send invites themselves. [T1] — an edge case, not a marketing point, but relevant if depicting "any Operator can grow the team."
- Exact on-screen layout of the Notification Settings panel was not independently verified in this pass. [VERIFY]

## 7. Evidence & Open [VERIFY] Items

| Claim | Evidence | Tier |
|---|---|---|
| Invite lifecycle, rate limits, airlock flow | `api/app/api/invite_routes.py` (read in full) | T1 |
| Role hierarchy + no-self-escalation | `api/app/api/operator_routes.py` `_ROLE_RANK`, `_prevent_role_escalation` | T1 |
| Department CRUD + per-department business hours | `api/app/api/operator_routes.py` Department endpoints | T1 |
| Redis presence + DB fallback design | `api/app/services/operator_presence_service.py` (module docstring + code, read in full) | T1 |
| Push categories + quiet hours | `api/app/services/push_service.py` `_EVENT_CATEGORY`, `_in_quiet_hours`; `operator_routes.py` `PushPreferencesModel` | T1 |
| Push-aware handoff promotion logic | `api/app/api/operator_routes.py` `request_handoff`, `promoted_from_offline_form` | T1 |
| Self-operator seat-counting rationale | `api/app/api/invite_routes.py` `add_self_as_operator` docstring, explicit industry-comparison comment | T2 |
| Members page UI (People/Departments tabs, badges, quota meter) | `app/src/features/workspace/MembersPage.tsx` (partial read, first 150 lines) | T1 |
| Notification Settings panel exact layout | `app/src/features/settings/NotificationsSection.tsx` — file located, contents not read | VERIFY |
| One-to-one Operator↔Bot binding is a permanent design choice (not a v1 limitation slated to change) | Inferred from multiple code comments enforcing it consistently; no explicit "future: many-to-many" note found | T2 |
