# Settings Redesign (Account + Workspace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the dashboard Settings page as a tabbed Account + Workspace surface (Profile, Security, Notifications, Appearance, Workspace, Feedback), backed by three new `get_current_client` endpoints, replacing the 1141-line grab-bag.

**Architecture:** Thin `Settings.jsx` shell (left tab rail + `?tab=` routing) delegating to focused tab components under `pages/settings/`. Browser-push state lifted into a `PushContext` shared by the banner and the Notifications tab. New FastAPI client-account endpoints in `client_routes.py`. Per-bot config is NOT touched here (it relocates to the Bot Settings editor in sub-project 2 — see migration note).

**Tech Stack:** FastAPI · SQLAlchemy · pytest (backend); React 19 · Vite · react-query · TailwindCSS (frontend). Backend verified with pytest+ruff; frontend with `npm run lint` + `npm run build` (the app has no JS unit-test runner).

**Spec:** `docs/superpowers/specs/2026-06-30-settings-redesign-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `api/app/api/client_routes.py` (modify) | + `PATCH /client/profile`, `POST /client/change-password`, `GET /client/api-key`, `POST /client/api-key/regenerate` |
| `api/tests/test_client_account.py` (create) | pytest for the 4 endpoints |
| `app/src/services/api.js` (modify) | + `updateClientProfile`, `changeClientPassword`, `getClientApiKey`, `regenerateClientApiKey` |
| `app/src/context/PushContext.jsx` (create) | provider wrapping `usePushNotifications`; `usePush()` hook |
| `app/src/layouts/AdminLayout.jsx` (modify) | consume `usePush()` from context instead of calling the hook directly |
| `app/src/pages/Settings.jsx` (rewrite) | thin tabbed shell |
| `app/src/pages/settings/ProfileTab.jsx` (create) | name/email/avatar view+edit |
| `app/src/pages/settings/SecurityTab.jsx` (create) | change password + sign out |
| `app/src/pages/settings/NotificationsTab.jsx` (create) | browser push toggle + status |
| `app/src/pages/settings/AppearanceTab.jsx` (create) | theme selector |
| `app/src/pages/settings/WorkspaceTab.jsx` (create) | Team/Billing links + API key card |
| `app/src/pages/settings/FeedbackTab.jsx` (create) | submit feedback + my-feedback list |

**Migration safety:** This plan does NOT delete the bot-config sections (Widget Behavior, Visitor Messages, Tone & Personality, Live Chat Queue). The rewritten `Settings.jsx` renders the new account/workspace tabs; bot-config relocation is sub-project 2. To avoid a gap, the rewrite keeps a temporary "Bot configuration moved" pointer (or leaves the legacy sections accessible) until sub-project 2 lands — see Task 11 note.

---

## Task 1: Backend — `PATCH /client/profile`

**Files:**
- Modify: `api/app/api/client_routes.py`
- Test: `api/tests/test_client_account.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_client_account.py
from app.core.security import verify_password


def test_update_profile_changes_name_and_email(client, make_client_auth):
    headers = make_client_auth(email="old@example.com", name="Old")
    res = client.patch("/client/profile", json={"name": "New", "email": "new@example.com"}, headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "New"
    assert body["email"] == "new@example.com"


def test_update_profile_rejects_duplicate_email(client, make_client_auth, make_client):
    make_client(email="taken@example.com")
    headers = make_client_auth(email="me@example.com")
    res = client.patch("/client/profile", json={"email": "taken@example.com"}, headers=headers)
    assert res.status_code == 400
```

> Use the existing test fixtures in `api/tests/conftest.py`. If `make_client_auth` / `make_client` helpers don't exist, mirror the auth-header pattern used by other client-route tests (read `test_document_routes.py` for the established fixture style) before writing this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q`
Expected: FAIL (404 / route not found).

- [ ] **Step 3: Write the endpoint**

```python
# api/app/api/client_routes.py
from pydantic import BaseModel, field_validator

class ClientProfilePatch(BaseModel):
    name: str | None = None
    email: str | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        if v is not None and not v.strip():
            raise ValueError("Name cannot be empty.")
        return v.strip() if v else v

@router.patch("/profile")
def update_client_profile(body: ClientProfilePatch, client: Client = Depends(get_current_client)):
    """Update the authenticated client's name and/or email."""
    with get_session() as session:
        row = session.get(Client, client.id)
        if body.email and body.email.lower() != (row.email or "").lower():
            existing = session.execute(
                select(Client).where(Client.email == body.email, Client.id != row.id)
            ).scalars().first()
            if existing:
                raise HTTPException(status_code=400, detail="A client with this email already exists.")
            row.email = body.email
        if body.name:
            row.name = body.name
        session.commit()
        session.refresh(row)
        return {"id": row.id, "name": row.name, "email": row.email}
```

> Confirm `router` prefix is `/client` and that `get_current_client`, `Client`, `get_session`, `select`, `HTTPException` are already imported in `client_routes.py` (they are used elsewhere in the file); add any missing import.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/client_routes.py api/tests/test_client_account.py
git commit -m "feat(api): client profile update endpoint"
```

---

## Task 2: Backend — `POST /client/change-password`

**Files:**
- Modify: `api/app/api/client_routes.py`
- Test: `api/tests/test_client_account.py`

- [ ] **Step 1: Write the failing test**

```python
def test_change_password_success(client, make_client_auth):
    headers = make_client_auth(email="pw@example.com", password="OldPass1")
    res = client.post("/client/change-password",
                      json={"current_password": "OldPass1", "new_password": "NewPass2"}, headers=headers)
    assert res.status_code == 200

def test_change_password_wrong_current(client, make_client_auth):
    headers = make_client_auth(email="pw2@example.com", password="OldPass1")
    res = client.post("/client/change-password",
                      json={"current_password": "WRONG", "new_password": "NewPass2"}, headers=headers)
    assert res.status_code == 400

def test_change_password_weak(client, make_client_auth):
    headers = make_client_auth(email="pw3@example.com", password="OldPass1")
    res = client.post("/client/change-password",
                      json={"current_password": "OldPass1", "new_password": "short"}, headers=headers)
    assert res.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q`
Expected: FAIL on the new tests.

- [ ] **Step 3: Write the endpoint**

```python
from app.core.security import get_password_hash, verify_password

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _strong(cls, v):
        if len(v) < 8 or not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError("Password must be at least 8 characters and include a letter and a number.")
        return v

@router.post("/change-password")
def change_client_password(body: ChangePasswordRequest, client: Client = Depends(get_current_client)):
    """Change the authenticated client's password (verifies the current one)."""
    with get_session() as session:
        row = session.get(Client, client.id)
        if not verify_password(body.current_password, row.hashed_password):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
        row.hashed_password = get_password_hash(body.new_password)
        session.commit()
        return {"ok": True}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/client_routes.py api/tests/test_client_account.py
git commit -m "feat(api): client change-password endpoint"
```

---

## Task 3: Backend — client API key view + regenerate

**Files:**
- Modify: `api/app/api/client_routes.py`
- Test: `api/tests/test_client_account.py`

- [ ] **Step 1: Write the failing test**

```python
def test_get_api_key_is_masked(client, make_client_auth):
    headers = make_client_auth(email="k@example.com")
    res = client.get("/client/api-key", headers=headers)
    assert res.status_code == 200
    assert res.json()["api_key_masked"].startswith("••")

def test_regenerate_api_key_returns_full_once_and_changes(client, make_client_auth):
    headers = make_client_auth(email="k2@example.com")
    before = client.get("/client/api-key", headers=headers).json()["api_key_masked"]
    res = client.post("/client/api-key/regenerate", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert len(body["api_key"]) >= 16
    assert body["api_key_masked"] != before
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q`
Expected: FAIL.

- [ ] **Step 3: Write the endpoints**

```python
import uuid

def _mask_key(key: str | None) -> str:
    return ("••••••" + key[-4:]) if key else "—"

@router.get("/api-key")
def get_client_api_key(client: Client = Depends(get_current_client)):
    return {"api_key_masked": _mask_key(client.api_key)}

@router.post("/api-key/regenerate")
def regenerate_client_api_key(client: Client = Depends(get_current_client)):
    """Rotate the client's API key. Returns the full new key ONCE for copy."""
    with get_session() as session:
        row = session.get(Client, client.id)
        new_key = str(uuid.uuid4().hex)
        row.api_key = new_key
        session.commit()
        return {"ok": True, "api_key": new_key, "api_key_masked": _mask_key(new_key)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q`
Expected: PASS.

- [ ] **Step 5: Ruff + commit**

```bash
cd api && .venv/bin/ruff check app/api/client_routes.py && .venv/bin/ruff format app/api/client_routes.py
git add api/app/api/client_routes.py api/tests/test_client_account.py
git commit -m "feat(api): client API key view + regenerate"
```

---

## Task 4: Frontend — API client functions

**Files:**
- Modify: `app/src/services/api.js`

- [ ] **Step 1: Add functions (follow the existing `export const ...` + `buildApiError` pattern in the file)**

```javascript
export const updateClientProfile = async (patch) => {
  try { return (await api.patch('/client/profile', patch)).data; }
  catch (e) { throw buildApiError(e, 'Failed to update profile'); }
};
export const changeClientPassword = async (current_password, new_password) => {
  try { return (await api.post('/client/change-password', { current_password, new_password })).data; }
  catch (e) { throw buildApiError(e, 'Failed to change password'); }
};
export const getClientApiKey = async () => {
  try { return (await api.get('/client/api-key')).data; }
  catch (e) { throw buildApiError(e, 'Failed to load API key'); }
};
export const regenerateClientApiKey = async () => {
  try { return (await api.post('/client/api-key/regenerate')).data; }
  catch (e) { throw buildApiError(e, 'Failed to regenerate API key'); }
};
```

- [ ] **Step 2: Lint**

Run: `cd app && npx eslint src/services/api.js`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/src/services/api.js
git commit -m "feat(app): client account API helpers"
```

---

## Task 5: Frontend — `PushContext` provider

**Files:**
- Create: `app/src/context/PushContext.jsx`
- Modify: `app/src/layouts/AdminLayout.jsx` (use the provider + `usePush()`), `app/src/App.jsx` if the provider must wrap the protected tree.

- [ ] **Step 1: Create the provider**

```jsx
// app/src/context/PushContext.jsx
import { createContext, useContext } from 'react';
import usePushNotifications from '../hooks/usePushNotifications';

const PushContext = createContext(null);

export function PushProvider({ children }) {
  const push = usePushNotifications();
  return <PushContext.Provider value={push}>{children}</PushContext.Provider>;
}

export function usePush() {
  const ctx = useContext(PushContext);
  if (ctx === null) throw new Error('usePush must be used within <PushProvider>');
  return ctx;
}
```

- [ ] **Step 2: Wrap the authenticated tree.** In `AdminLayout.jsx`, replace `const push = usePushNotifications();` with `const push = usePush();`, and ensure `<PushProvider>` wraps the layout (add it around the `AdminLayout` content / protected routes in `AdminLayout.jsx` or `App.jsx`). The `PushPermissionBanner` continues to receive `push` from the layout.

- [ ] **Step 3: Lint + build**

Run: `cd app && npx eslint src/context/PushContext.jsx src/layouts/AdminLayout.jsx && npm run build`
Expected: clean, build ✓.

- [ ] **Step 4: Commit**

```bash
git add app/src/context/PushContext.jsx app/src/layouts/AdminLayout.jsx app/src/App.jsx
git commit -m "feat(app): lift push-notification state into PushContext"
```

---

## Task 6: Frontend — Settings shell (tab rail + routing)

**Files:**
- Rewrite: `app/src/pages/Settings.jsx`
- Create: the 6 tab files as empty stubs returning `null` first (so the shell imports resolve), filled in Tasks 7–12.

- [ ] **Step 1: Create stub tab files** — each: `export default function XTab() { return null; }` at `app/src/pages/settings/{Profile,Security,Notifications,Appearance,Workspace,Feedback}Tab.jsx`.

- [ ] **Step 2: Write the shell**

```jsx
// app/src/pages/Settings.jsx
import { useSearchParams } from 'react-router-dom';
import { User, Shield, Bell, Palette, Briefcase, MessageSquare } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import ProfileTab from './settings/ProfileTab';
import SecurityTab from './settings/SecurityTab';
import NotificationsTab from './settings/NotificationsTab';
import AppearanceTab from './settings/AppearanceTab';
import WorkspaceTab from './settings/WorkspaceTab';
import FeedbackTab from './settings/FeedbackTab';

const TABS = [
  { id: 'profile', label: 'Profile', icon: User, Component: ProfileTab },
  { id: 'security', label: 'Security', icon: Shield, Component: SecurityTab },
  { id: 'notifications', label: 'Notifications', icon: Bell, Component: NotificationsTab },
  { id: 'appearance', label: 'Appearance', icon: Palette, Component: AppearanceTab },
  { id: 'workspace', label: 'Workspace', icon: Briefcase, Component: WorkspaceTab },
  { id: 'feedback', label: 'Feedback & Support', icon: MessageSquare, Component: FeedbackTab },
];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const active = TABS.find((t) => t.id === params.get('tab')) || TABS[0];
  const Active = active.Component;
  return (
    <div>
      <PageHeader title="Settings" subtitle="Account & workspace preferences" />
      <div className="flex flex-col md:flex-row gap-6">
        <nav className="md:w-56 shrink-0 flex md:flex-col gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const on = t.id === active.id;
            return (
              <button key={t.id} type="button" onClick={() => setParams({ tab: t.id })}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-left transition ${on ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300' : 'text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800/60'}`}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 min-w-0"><Active /></div>
      </div>
    </div>
  );
}
```

> Match the actual Tailwind tokens used in the app (`surface-*`, `primary-*`) — verify against an existing page (e.g. `Integrations.jsx`) and adjust class names to the real palette.

- [ ] **Step 3: Lint + build**

Run: `cd app && npm run build`
Expected: build ✓ (tabs render empty).

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/Settings.jsx app/src/pages/settings/
git commit -m "feat(app): tabbed Settings shell with ?tab routing"
```

---

## Task 7: ProfileTab

**Files:** `app/src/pages/settings/ProfileTab.jsx`

- [ ] **Step 1: Implement.** Responsibilities: fetch `/auth/me` (existing `getClientProfile`/`getMe` in `api.js` — use whichever exists, around line 549), show avatar/name/email/joined; inline-edit name + email saved via `updateClientProfile`; success/error via `ToastContext` (`useToast()`); loading skeleton; disable Save while pending. Use react-query `useQuery(['me'])` + `useMutation`. Follow form/input styling from the current `Settings.jsx` Account section.
- [ ] **Step 2:** `cd app && npm run build` → ✓.
- [ ] **Step 3:** `git add app/src/pages/settings/ProfileTab.jsx && git commit -m "feat(app): Settings ProfileTab"`

---

## Task 8: SecurityTab

**Files:** `app/src/pages/settings/SecurityTab.jsx`

- [ ] **Step 1: Implement.** Change-password form (current, new, confirm) with the same client-side validation as the spec (≥8, letter+number, match). For operators call existing `operatorChangePassword`; for clients call `changeClientPassword`. Determine account type via `getAuthItem('auth_type')` (used elsewhere). Add a "Sign out" button that clears auth (reuse the existing logout util/`AuthContext`) and navigates to `/login`. Toast on result.
- [ ] **Step 2:** `cd app && npm run build` → ✓.
- [ ] **Step 3:** `git commit -m "feat(app): Settings SecurityTab"`

---

## Task 9: NotificationsTab

**Files:** `app/src/pages/settings/NotificationsTab.jsx`

- [ ] **Step 1: Implement.** Consume `usePush()`. Render a toggle: when off/default → button calls `push.request()`; when granted+subscribed → "Enabled" with a "Turn off" calling `push.disable()`; when `permission === 'denied'` → show the same lock-icon recovery copy as `PushPermissionBanner` (no re-prompt possible). Show a status pill (Enabled / Off / Blocked). If `!push.supported` show an unsupported-browser note.
- [ ] **Step 2:** `cd app && npm run build` → ✓.
- [ ] **Step 3:** `git commit -m "feat(app): Settings NotificationsTab (browser push controls)"`

---

## Task 10: AppearanceTab

**Files:** `app/src/pages/settings/AppearanceTab.jsx`

- [ ] **Step 1: Implement.** Move the existing Theme section (system/light/dark cards) from the old `Settings.jsx` verbatim, including the theme context/hook it used. No backend.
- [ ] **Step 2:** `cd app && npm run build` → ✓.
- [ ] **Step 3:** `git commit -m "feat(app): Settings AppearanceTab (theme)"`

---

## Task 11: WorkspaceTab

**Files:** `app/src/pages/settings/WorkspaceTab.jsx`

- [ ] **Step 1: Implement.** Two link cards: Team → `/team`, Billing → `/billing` (use `Link` from react-router). API-key card: `useQuery(['client-api-key'], getClientApiKey)` shows masked key; "Regenerate" button → `confirm()` warning → `regenerateClientApiKey()` → show the returned full `api_key` once in a copy-to-clipboard reveal, then invalidate `['client-api-key']`. Toast on result.
- [ ] **Step 2 (migration pointer):** Add a small info card "Bot configuration (appearance, messages, behavior, live chat) has moved to **Bot Settings**" linking to `/chatbot?tab=appearance` — so users who looked for it in Settings are redirected. (Sub-project 2 finalizes the rename to "Bot Settings".)
- [ ] **Step 3:** `cd app && npm run build` → ✓.
- [ ] **Step 4:** `git commit -m "feat(app): Settings WorkspaceTab (team/billing links + API key)"`

---

## Task 12: FeedbackTab

**Files:** `app/src/pages/settings/FeedbackTab.jsx`

- [ ] **Step 1: Implement.** Submit form (message + category + optional attachment) → existing `submitPlatformFeedback`/`/client/feedback` helper (around line 729 in `api.js`); below it, "My feedback" list via `getMyFeedback`/`GET /client/feedback` (line 768) showing each item's category, message, **status** badge, and admin response when present (the resolution loop). react-query + toast.
- [ ] **Step 2:** `cd app && npm run build` → ✓.
- [ ] **Step 3:** `git commit -m "feat(app): Settings FeedbackTab (submit + my-feedback status)"`

---

## Task 13: Final wiring, cleanup, verification

**Files:** `app/src/pages/Settings.jsx`, old account sections.

- [ ] **Step 1:** Confirm all 6 tabs render real content; remove any now-dead imports/helpers in the old `Settings.jsx` that were replaced. Do NOT remove the bot-config sections' source if they're still the only home — instead the rewrite already excludes them and the WorkspaceTab pointer (Task 11) covers discoverability; sub-project 2 owns their relocation into the editor.
- [ ] **Step 2:** Full gate.

Run: `cd app && npx tsc --noEmit 2>/dev/null; npm run lint && npm run build`
Run: `cd api && PYTHONPATH=. .venv/bin/python -m pytest tests/test_client_account.py -q && .venv/bin/ruff check app/api/client_routes.py`
Expected: all green.

- [ ] **Step 3:** Manual smoke: deep-link each `/settings?tab=...`; test profile save, password change, push toggle (default/granted/denied), API-key regenerate reveal, feedback submit + status list.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(app): finalize tabbed Settings redesign (sub-project 1)"
```

---

## Self-Review notes (author)

- **Spec coverage:** Profile (T1,T7) · Security (T2,T8) · Notifications (T5,T9) · Appearance (T10) · Workspace incl. API key (T3,T11) · Feedback (T12) · backend endpoints (T1–T3) · PushContext (T5) · shell+routing (T6). All spec sections mapped.
- **No bot-config deletion** here (migration-safety honored; relocation = sub-project 2).
- **Frontend "tests":** the app has no JS unit runner, so frontend tasks verify via `npm run lint`/`build` + manual smoke (documented), while backend uses real pytest TDD.
- **Type/name consistency:** API helper names (`updateClientProfile`, `changeClientPassword`, `getClientApiKey`, `regenerateClientApiKey`) and endpoint paths match across tasks; `usePush()` used consistently.
