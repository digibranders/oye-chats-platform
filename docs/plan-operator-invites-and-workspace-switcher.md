# Plan — Operator Invites + Workspace Switcher (v1)

**Scope:** `platform/api/` + `platform/app/`
**Target:** solves the "one email, multiple roles" identity mess by shifting from separate Operator identities to invite-based membership + workspace switching.
**Realistic effort:** 3–4 days full implementation. This doc is the source of truth for the whole feature.

---

## 1. Core architectural decisions (locked)

### 1.1 Identity model
- The **Client row is the identity.** One person = one `clients` row = one email + password.
- The **Operator row is a *role*** that a Client holds in some workspace. It has no independent authentication anymore for invite-created rows.
- **A "workspace" is a Client's tenant** — the workspace owner's `client_id` IS the workspace ID. No separate `workspaces` table in v1.

### 1.2 Auth flow for invited operators
- Invited operators log in via `/auth/login` (client login) using their **Client credentials**. Never `/auth/operator-login`.
- Their auth token = their Client's `api_key` (a permanent uuid.hex — same pattern as today).
- Every admin/operator API call sends `X-Workspace-Id: <workspace_client_id>` header.
- The **auth resolver reads `X-Workspace-Id`** to determine whether the caller is acting as themselves (owner) or in a linked-operator role.

**Concrete auth resolution:**
```
X-API-Key: <caller_api_key>    (their Client's api_key)
X-Workspace-Id: <workspace_id> (which workspace context)

if workspace_id == caller.client_id:
    → type=client (acting as owner of their own workspace)
else:
    → look up Operator WHERE client_id=workspace_id AND linked_client_id=caller.id
    → if found and is_active → type=operator (acting as linked operator)
    → else → 403 workspace-not-accessible
```

### 1.3 Backward compatibility with existing operators
- Old operators (created with password + `operator_api_key`) keep working **completely untouched.**
- They log in via `/auth/operator-login`, use `X-Operator-Key`, see only their one workspace.
- No workspace switcher shown to them (only one workspace anyway).
- They can be manually "linked" to a Client identity later via a Settings action (v2 feature — out of scope now).
- Their `linked_client_id` column is NULL.

### 1.4 Multi-role reality
- A Client can hold **any number of Operator roles across workspaces** — that's exactly what the switcher exposes.
- A person invited to workspace B while owning workspace A gets a switcher with both entries.
- Ownership of one's own workspace ("scenario 2 escape hatch") is exposed via a **"+ Create your own workspace"** entry at the bottom of the switcher dropdown.

---

## 2. Data model changes

### 2.1 New table: `operator_invites`

```python
class OperatorInvite(Base):
    __tablename__ = "operator_invites"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Which workspace this invite is for (owner's client_id)
    client_id = Column(Integer, ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True)

    # Target email — lowercased at write, uniqueness enforced by partial index below
    email = Column(String, nullable=False, index=True)

    # Role + department the invitee will get on accept
    role = Column(String, nullable=False, default="operator", server_default="operator")
    department_id = Column(Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)

    # Cryptographic bearer token — SHA-256 hash stored, plaintext only in the email link
    token_hash = Column(String(64), unique=True, nullable=False, index=True)

    # Lifecycle
    status = Column(
        String,
        nullable=False,
        default="pending",
        server_default="pending",
    )  # pending | accepted | revoked | expired
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Audit — who sent it, when it resolved
    invited_by_client_id = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    invited_by_name = Column(String, nullable=True)  # snapshot at creation time
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    accepted_by_client_id = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by_client_id = Column(Integer, ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)

    # Delivery tracking
    sent_at = Column(DateTime(timezone=True), nullable=True)
    resend_count = Column(Integer, default=0, server_default="0", nullable=False)

    __table_args__ = (
        # Partial unique: at most one *pending* invite per (workspace, email).
        # Accepted / revoked / expired rows are kept for audit and don't conflict.
        Index(
            "ux_operator_invites_pending_unique",
            "client_id", "email",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )
```

### 2.2 `operators` table extension

```python
# NEW COLUMN — links a linked-identity operator to their underlying Client identity.
# NULL for legacy operators (created with own password) and for pending invites.
linked_client_id = Column(
    Integer,
    ForeignKey("clients.id", ondelete="CASCADE"),
    nullable=True,
    index=True,
)

# NEW COLUMN — snapshot of the invited email for audit + case-insensitive rebinding.
invited_email = Column(String, nullable=True)
```

Add a partial unique index so a Client can't be linked-operator in the same workspace twice:
```python
Index(
    "ux_operators_linked_per_workspace",
    "client_id", "linked_client_id",
    unique=True,
    postgresql_where=text("linked_client_id IS NOT NULL"),
)
```

### 2.3 Alembic migration

- Autogenerate the migration
- Backfill: nothing needed (both new columns nullable; existing operators unaffected)
- Reversible: `op.drop_column` + `op.drop_table` in downgrade

---

## 3. Backend API surface

All routes live in a new `platform/api/app/api/invite_routes.py` and are registered in `main.py`.

### 3.1 Owner-facing (require workspace admin/owner)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/invites` | Create + send invite. Enforces seat count, dup-check, superadmin block, RBAC. |
| `GET` | `/invites` | List pending + recent invites for the workspace. |
| `POST` | `/invites/{id}/resend` | Resend email (bumps `resend_count`, rate-limited 3/hour/invite). |
| `DELETE` | `/invites/{id}` | Revoke a pending invite. Marks `status=revoked`, sets `revoked_at`. |

### 3.2 Public (no auth needed to *view* the airlock; auth needed to *accept*)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/invites/by-token/{token}` | Public metadata: workspace name, inviter name, invitee email, expiry, current status. Used by airlock page to render the correct state. |
| `POST` | `/invites/by-token/{token}/accept` | Auth required. Creates a linked Operator row on the workspace. Case-insensitive email match check. Cache invalidation on entitlements. |

### 3.3 Identity + workspace listing

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me/workspaces` | Returns all workspaces the caller can act in. Owner workspace + linked-operator workspaces. Includes role + workspace name + slug + last_active_at hints. |

### 3.4 Endpoints that need `X-Workspace-Id` awareness

Every endpoint currently reading `auth["client_id"]` from `get_current_client_or_operator` implicitly scopes to that workspace. After this change:
- If `X-Workspace-Id` header is present → resolver uses it to switch identity → `auth["client_id"]` becomes the workspace's owner's id
- If absent → default to caller's own client_id (legacy behavior)

**No downstream route changes.** All existing scoping via `auth["client_id"]` keeps working.

### 3.5 Modified endpoints

- `POST /operators/create` — **deprecated but kept alive** for backward compat (used by direct-add flow if the owner really wants to skip the invite dance). Frontend will hide it by default.
- Existing operator revoke endpoint (`DELETE /operators/{id}`) — **extended** to evict from active chats (see §6.2).

---

## 4. Auth resolver — the critical logic change

### 4.1 New `get_current_client_or_operator` behavior

The resolver stays at the same signature but gains an optional `X-Workspace-Id` header parse:

```python
def get_current_client_or_operator(
    api_key: str = Security(api_key_header),
    operator_key: str = Security(operator_key_header),
    legacy_agent_key: str = Security(legacy_agent_key_header),
    workspace_id: int | None = Security(workspace_id_header),
):
    # 1. Legacy operator key path — unchanged. Returns type=operator.
    if effective_operator_key := _resolve_operator_key(operator_key, legacy_agent_key):
        # ... existing logic ... returns {"type": "operator", ...}

    # 2. Client key path — NEW workspace resolution.
    if api_key:
        client = _resolve_client(api_key)
        if client is None:
            raise HTTPException(401, ...)
        _ensure_not_suspended(client)

        # No workspace_id header, or workspace_id == own → act as owner of own workspace.
        if workspace_id is None or workspace_id == client.id:
            return {"type": "client", "entity": client, "client_id": client.id, "operator_id": None}

        # workspace_id != own → look up linked-operator role in that workspace.
        operator = _resolve_linked_operator(client_id=client.id, workspace_id=workspace_id)
        if operator is None:
            raise HTTPException(403, detail="No operator role in this workspace.")
        if not operator.is_active:
            raise HTTPException(403, detail="Operator role is inactive.")

        # Owner suspension check — a suspended workspace locks out its operators too.
        owner = _resolve_client_by_id(workspace_id)
        _ensure_not_suspended(owner)

        # Present as operator so downstream role-escalation guards see the operator's role,
        # not the Client's implicit "unrestricted".
        return {
            "type": "operator",
            "entity": operator,
            "client_id": workspace_id,   # workspace is the operator's client_id
            "operator_id": operator.id,
        }

    raise HTTPException(401, ...)
```

### 4.2 Gotcha: `_prevent_role_escalation` guard

Currently treats `auth["type"] == "client"` as unrestricted (`operator_routes.py:51-52`). After this change, a linked operator authenticates via `X-API-Key` but the resolver returns `type=operator` — so the guard works correctly for them.

For legit owners acting in their own workspace, `type=client` still means unrestricted (they own it). ✅

### 4.3 Gotcha: `get_current_client` still needs to work

`get_current_client` (auth.py:64+) is used by non-operator-facing endpoints. It should keep its current behavior for `X-API-Key` — always resolve to the caller's OWN Client, not to a workspace context. Only `get_current_client_or_operator` gets the `X-Workspace-Id` fork.

### 4.4 Gotcha: `get_superadmin` uses `get_current_client_strict`

Which explicitly ignores `X-Operator-Key`. Add: it must also ignore `X-Workspace-Id` — a superadmin acting AS operator in some workspace is still the same superadmin. Superadmin routes always target the actor's true identity.

---

## 5. Frontend architecture

### 5.1 Workspace React context

New: `platform/app/src/context/WorkspaceContext.jsx`

```jsx
{
  currentWorkspaceId: number | null,     // owner's client_id of active workspace
  currentRole: 'owner' | 'operator',
  currentWorkspaceName: string,
  workspaces: Workspace[],               // populated from GET /me/workspaces
  switchWorkspace(workspaceId): Promise, // full switch flow
  refreshWorkspaces(): Promise,
}
```

Persisted to storage via `setAuthBundle` (so it lives in the same store as `admin_token` — localStorage if "Remember me" was on, sessionStorage otherwise).

### 5.2 API client changes

`platform/app/src/services/api.js` — the request interceptor gets a workspace-id branch:

```js
api.interceptors.request.use((config) => {
    const token = getAuthItem('admin_token');
    const authType = getAuthItem('auth_type');
    const workspaceId = getAuthItem('current_workspace_id');

    if (token) {
        if (authType === 'operator') {
            config.headers['X-Operator-Key'] = token;
        } else {
            config.headers['X-API-Key'] = token;
            // Only client auth sends workspace-id; legacy operators use X-Operator-Key
            // which already implies the workspace.
            if (workspaceId) config.headers['X-Workspace-Id'] = workspaceId;
        }
        // Cancellation token — see 5.3
        if (config.__workspaceAbortSignal) config.signal = config.__workspaceAbortSignal;
    }
    return config;
});
```

### 5.3 AbortController on workspace switch

**New pattern** (does not exist anywhere in the codebase today).

`WorkspaceContext` maintains a rolling AbortController:
```jsx
const abortRef = useRef(new AbortController());

const switchWorkspace = async (workspaceId) => {
    // Cancel every in-flight request for the previous workspace.
    abortRef.current.abort();
    abortRef.current = new AbortController();

    // Update persistent state.
    setAuthItem('current_workspace_id', workspaceId);
    setCurrentWorkspaceId(workspaceId);

    // Close current WS, re-open under new workspace context.
    liveChatWS.reconnect();

    // Kick off fresh data fetches.
    refreshCurrentWorkspaceData();
};
```

API client automatically attaches `abortRef.current.signal` to every request (via context provider wrapping `api`). Requests that fire during the switch get canceled cleanly; downstream code needs to handle `axios.isCancel(err)` and simply not update state.

### 5.4 Workspace switcher UI

`platform/app/src/layouts/WorkspacePill.jsx` — new component in the top-left of `TopBar`.

**Pill (collapsed):**
```
[🏢 Acme Support ▾]   Operator
```

**Dropdown (expanded):**
```
CURRENT
  ● Acme Support           Operator · 3 waiting

YOUR WORKSPACES
  ○ Company A              Owner · 12 bots

──────────────────────────
+ Create your own workspace
+ Accept an invite (paste link)
```

Rendered inside `TopBar.jsx`, replacing the leading `<Breadcrumbs />` if the user has more than one workspace. Single-workspace users see the current workspace name as a static label (no dropdown affordance).

### 5.5 Role-aware sidebar

`Sidebar.jsx` currently branches on `localStorage.getItem('auth_type') === 'operator'` (via `getAuthState()`). After this change:
- Add `WorkspaceContext.currentRole` as the source of truth
- The role isn't a fixed identity property anymore — it's a property of the current workspace
- Sidebar re-renders instantly on workspace switch because it consumes the context

Also fix the direct-localStorage read at `Sidebar.jsx:384` (`company_name`) — replace with `WorkspaceContext.currentWorkspaceName`.

### 5.6 Airlock page (`/invite/{token}`)

Public route. States:

| State | Rendered UI |
|---|---|
| Loading | Skeleton |
| Invalid / expired / revoked | Error card with clear message + link to home |
| Not logged in, no OyeChats account | Signup form (email pre-filled, locked). After signup: auto-accept + redirect. |
| Not logged in, has account | Login form (email pre-filled). After login: auto-accept + redirect. |
| Logged in, email matches | Big "Accept invite" button + workspace details. Click → accept + redirect. |
| Logged in, email mismatches | "Signed in as X. This invite is for Y. Sign out to accept?" — no silent switch. |
| Accept in-flight | Spinner state |
| Accept succeeded | Redirect to `/support` in new workspace with a first-time toast |

### 5.7 Team page rework

`platform/app/src/pages/TeamManagement.jsx`:
- Replace "Create Operator" modal with **"Invite Operator"** modal (email + role + department, no password field)
- Add **Pending Invites** section above the operator table:
  - Email · Invited by · Sent · Expires · Actions [Resend] [Revoke]
- Keep the existing operator table for accepted operators (both legacy + linked)
- Show a small badge on legacy operators: "Legacy operator" — with a "Convert to invited" affordance in v2

### 5.8 Login landing logic

`Login.jsx` — after a successful client login, fetch `/me/workspaces`:
- Persist to workspace context
- If localStorage has a `current_workspace_id` and it's in the list → land there
- Else: find the user's owned workspace (their `client.id`) → land at `/`
- Else (invited-only, no owned workspace) → land at `/support` in their invited workspace

Direct-signup clients get `current_workspace_id = <their client_id>` set automatically.

### 5.9 Push payload workspace-awareness

Add `workspace_id` and `workspace_name` to every dispatch task's payload:
- `task_dispatch_handoff_push`
- `task_dispatch_offline_message_push`
- `task_dispatch_transfer_push`
- `task_handoff_escalation`

SW `notificationclick` handler:
1. Read `data.workspace_id`
2. Post `{type: "oyechats:push-navigate", workspace_id, target_path}` to the client
3. Client-side listener: switch workspace context to `workspace_id` FIRST, then navigate

Push notification title format: `"{workspace_name} — {payload title}"` so operators see workspace context on their lock screen.

---

## 6. Gotchas from the research pass — how each is addressed

| # | Gotcha | Address |
|---|---|---|
| 1 | `operators.email` has no DB unique constraint | Add partial unique index `(client_id, linked_client_id) WHERE linked_client_id IS NOT NULL`. Prevents duplicate linked-operator rows. Legacy operators are unaffected. |
| 2 | Client `email` unique index is bare (not case-insensitive at DB) | Enforce lowercase at all write paths (already true for login; extend to invite creation, invite accept). Add case-insensitive lookup helper. |
| 3 | Token is permanent `api_key`, not JWT | Workspace-id is a separate header, not encoded in the token. Consistent with existing pattern. |
| 4 | Operator login polymorphic across workspaces | Invited operators don't log in via `/auth/operator-login` at all — they use `/auth/login` as clients. The polymorphic operator login remains for legacy. |
| 5 | `Operator.client_id` CASCADE | "Revoke operator" ≠ delete client. We delete/deactivate the Operator row only. |
| 6 | No `linked_client_id` column | Add it (§2.2). |
| 7 | No `AbortController` pattern | Introduce it in WorkspaceContext (§5.3). |
| 8 | `getAuthItem` dual localStorage/sessionStorage | New `current_workspace_id` goes through `setAuthBundle` at login → same storage as `admin_token`. |
| 9 | Sidebar reads `localStorage.getItem('company_name')` directly | Replace with WorkspaceContext read. |
| 10 | `_prevent_role_escalation` treats client as unrestricted | Auth resolver returns `type=operator` for linked-op sessions → guard sees operator's role correctly. |
| 11 | `enforce_feature` + `get_entitlements` cache TTL 60s | On invite accept, explicitly invalidate the cache for the workspace's client_id. |
| 12 | `/auth/operator-login` filters `hashed_password IS NOT NULL` | Pending invite Operator rows have `hashed_password=NULL` and are hidden from operator-login. Correct behavior. |
| 13 | Login response has no `role`/`kind` field | Fetch `/me/workspaces` after login for the definitive picture; don't rely on login response. |
| 14 | `ChatSession` / `OfflineMessage` cascade SET NULL on operator delete | Legacy behavior fine. For pending invites (no chats), nothing to clean up. |

### 6.1 New gotcha not in research: seat count with pending invites

**Pending invites (not-yet-accepted) must NOT consume seats.** The Operator row for a pending invite:
- Doesn't exist yet — the row is only created on ACCEPT (v1 decision).
- The invite is just an `operator_invites` row.
- Zero seat impact until accepted.

**On accept:** create the Operator row → seat count check happens transactionally (with `FOR UPDATE` lock on subscription to prevent race).

### 6.2 New gotcha: revoke-operator-during-active-chat

When owner revokes an operator (either legacy or linked) who currently has a live chat:
1. Backend `DELETE /operators/{id}` (or `POST /operators/{id}/revoke` for linked ops):
   - Marks operator `is_active = False` first
   - Reads their assigned chat sessions
   - For each: calls `live_chat_service.close_chat(session_id, reason="operator_revoked")` — closes the chat gracefully
   - Notifies visitor via WS: `{type: "operator_left", message: "Reconnecting to next available agent..."}` then puts session back in `waiting`
   - Kicks their WS connection (calls `manager.disconnect_operator(op_id)`)
   - Writes ChatAuditLog entry: `event=operator_revoked, session_id=..., operator_id=..., initiator_id=<owner>`
2. Frontend: on receiving `operator_revoked` toast in their app, clear their assigned chats, show "your access has been revoked" screen if it's a linked operator.

---

## 7. Rollout order (mapped to tasks #16–43)

**Backend first — nothing user-facing breaks:**
1. Data model + Alembic migration (#18)
2. Auth resolver extension (#20) — critical, everything downstream depends on it
3. Invite endpoints + email service (#19, #21) + guardrails (#34–#37, #42, #43)
4. `/me/workspaces` endpoint (#26)
5. Revoke-with-eviction (#38)

**Frontend cutover — one integration at a time:**
6. WorkspaceContext + API client updates (#28, #27, #39)
7. Airlock page (#22)
8. Team page rework (#23)
9. Login landing + WS reconnect on switch (#33, #40)
10. Workspace pill + role-aware sidebar (#29, #30)
11. Create-your-own-workspace wizard (#31)
12. Push payload workspace-awareness (#32)

**Cross-cutting:**
13. Revoked-workspace 403 screen (#41)
14. Tests + lint + build (#25)

---

## 8. Test plan

### 8.1 Backend unit / integration

- Invite create — happy path, dup rejection, superadmin block, seat over-limit, RBAC (non-owner rejected), superadmin-target rejected
- Invite accept — happy path (new user), happy path (existing client), email mismatch, expired token, revoked token, already-accepted token
- Auth resolver — X-API-Key + X-Workspace-Id=own → client, X-Workspace-Id=other → linked-op, X-Workspace-Id=inaccessible → 403, legacy X-Operator-Key still works
- Revoke — with active chat → chat reassigned + visitor notified; without active chat → clean removal
- `/me/workspaces` — returns owner workspace + all linked-operator workspaces, sorted

### 8.2 Frontend E2E-like manual scenarios

- Direct signup client — nothing changes visually
- Invited user (new) — signup → auto-accept → land on operator UI
- Invited user (existing client) — login via airlock → accept → switcher shows both workspaces
- Workspace switch — sidebar re-renders, data re-fetches, WS reconnects, no stale data
- Push notification for workspace B while in workspace A — click → switches to B → routes to chat
- Deep link to inaccessible workspace — friendly 403 screen with switch-to-available CTA
- "Create your own workspace" wizard — completes and switcher updates

### 8.3 Guardrail tests

- Rate-limit invite creation (5/hour/client)
- Rate-limit resend (3/hour/invite)
- Case-insensitive email matching everywhere
- Invited email locked at accept — can't be changed

---

## 9. What's explicitly not built in v1

- Legacy operator → linked-identity automatic migration (manual "link my accounts" in Settings is v2)
- Multi-role granularity beyond owner/admin/operator (no viewer / analyst / etc.)
- Bulk invites
- Invite tracking dashboard (opens, clicks) — v2
- Workspace switching via keyboard shortcut (⌘K) — v2 nice-to-have
- Workspace-level billing switch UI (each workspace still bills to its owner)
- Ownership transfer flow

## 10. Ready-to-implement checkpoint

Every architectural decision above is locked. Every gotcha from the research pass has an addressed answer. The tasks (#16–43) are the atomic units of work.

**Implementation starts with data model + migration.**
