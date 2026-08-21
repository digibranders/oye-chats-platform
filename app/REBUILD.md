# OyeChats Console — rebuild plan

What is being built, in what order, and what must not be lost on the way.
Design language: [`DESIGN.md`](DESIGN.md). Mandate: [`CLAUDE.md`](CLAUDE.md).

---

## 1. Sequencing — vertical, not horizontal

The temptation is to build all of the design system, then all of the shell, then
all of the pages. That is how a rebuild dies at phase four: the app runs three
design systems for months, and the first end-to-end proof that the new one
actually works arrives after the expensive decisions are already sunk.

So each slice goes all the way down, and ships.

| Slice | Scope | Proves |
|---|---|---|
| **0 — Foundation** ✅ | Token layer · `src/ui/` primitives, overlays, layout, data, charts · guardrail tests · `/dev/ui` gallery · dead-code removal | The system compiles, renders, and is measured |
| **1 — Shell + Inbox** ✅ | App shell (ink rail, topbar, command palette, account menu) · router, guards, code splitting · the live-chat inbox end to end | The hardest surface, while the system is still cheap to change |
| **2 — Chatbot** ✅ | Agent scope: Overview · Knowledge · Experience · Deploy · Qualification · Behaviour | The core object, and every configuration pattern |
| **3 — Onboarding** ✅ | Setup rail, first run, contextual nudges. Launch Studio deleted | Activation |
| **4 — Home · Leads · Analytics** ✅ | Daily operations, with the date range the backend has always supported | The reporting surfaces |
| **5 — Billing · Usage · Settings** ✅ | Billing and usage as a top-level destination; one settings home | The money surfaces |
| **6 — Auth** ✅ | Login, register, verify, reset, OAuth callback | The last screens on the legacy palette |
| **7 — Sweep** ✅ | Delete the legacy bridge · a11y and performance pass · capability-ledger audit | That nothing was dropped |
| **8 — Super-admin** ✅ | A separate shell and URL space for ~110 endpoints with no UI today | Operations |

**Slice 1 is where the risk is.** The inbox is real-time, three-pane, stateful,
and the audit found it tearing down its own websocket on a tab switch. Building
it early is what tells us whether the system holds.

---

## 2. Information architecture

The complaint is that everything is buried. The fix is **scope**, not a deeper
tree: a rail that lists every agent's six destinations is O(N) in agent count,
and agent count is something we sell.

**Workspace scope** — flat, six destinations:

```
Home · Inbox · Leads · Analytics · Chatbots · Billing
                                              ⌄
                              Setup 3/6 · Help · Settings · Account
```

**Agent scope** — entering a chatbot swaps the rail:

```
← All chatbots
[ Acme Support ⌄ ]        ← searchable switcher, ⌘K-addressable
  Overview
  Knowledge
  Experience
  Deploy
  Qualification
  Behaviour
```

O(1) at any agent count, with up to three favourites pinned in the workspace
rail for fast switching. **The agent's name is in the topbar breadcrumb in both
scopes, always** — the audit found the Experience tab streaming replies from
whichever agent the shell switcher happened to hold rather than the one in the
URL, and an IA that never lets the current object go unnamed makes that class of
bug structurally harder.

### Consolidations

| `/journey`, a top-level scratch item | a tab inside **Analytics** | It is analytics, and it shipped as an admitted "temporary extra". The pan/zoom canvas and expand modal came back in `JourneyDiagram.tsx`/`ZoomPanCanvas.tsx`, this time keyboard-reachable: every node is a real `<button>` with an `aria-label`, arrow keys pan, `+`/`-`/`0` zoom, and the canvas is a focusable `role="application"` region — see `ZoomPanCanvas.tsx`'s own docstring for why `application` over `region`/`img`. It ships as a view toggle next to the original accessible list (`JourneyFlow.tsx`, still the default view), not a replacement, so nothing that shipped in the interim regresses. The outcomes donut came back too, with a real screen-reader alternative (a visually-hidden data table) the original never had — its SVG was `aria-hidden="true"` with nothing behind it. `Journey` is back in the sidebar as a direct link to `/analytics/journey`, not a second standalone route, so the "mounts one hook three times, ~30 requests every 15s" problem this table's own note (below) describes does not return. |
| Workspace: 8 rail tabs, each opening its own second-level strip | **Settings**, one home with a secondary column | Three nav levels, none in the URL. Also merges the two settings homes |
| Billing buried inside that | **its own destination**, plus a credit meter in the rail footer | Running out of credits stops the chatbot answering customers. That is an outage, not a preference |
| Agent "Channels" (plural, one channel) | **Deploy** | A verb the user acts on |
| Agent "Advanced" (a Free-plan dead end) | **Behaviour**, with **Qualification** promoted out | Qualification is a revenue surface, not a technical one |
| Per-agent analytics: ~950 lines built, unrouted, its CTA linking to a redirect back to itself | folded into **Overview** and **Analytics** | The work exists; it just has no door |
| Nav says "Support", route says `/inbox`, page says "Support" | **Inbox**, everywhere | Three names for one place |

### Rules that follow from the audit

- Every tab lives in the URL. No tab row selects on arrow-key focus.
- Locked destinations are links, not buttons — middle-click, copy-link and
  `aria-current` all matter.
- An operator's rail is **Inbox · Leads** plus an account menu. Not "Settings":
  for an operator that word means their own profile, which is a different object
  at the same label. And Leads is plan-gated, so the operator path must be
  checked against a Free workspace — today it is guard → locked page → dead end.
- The inbox is workspace-scoped, so it needs a persistent agent filter.
- **Home is today's work**, not a metrics dashboard: the queue, alerts, failing
  crawls, setup. If it shows numbers it duplicates Analytics, and the audit
  already found three disagreeing definitions of agent health across the app.

---

## 3. Onboarding

Launch Studio is deleted. Three pieces replace it, all inside the shell.

1. **First run** — one focused moment: name the chatbot, give a website.
   Crawling starts in the background and the user lands **in the playground,
   talking to their bot while it trains** — not on a progress screen. The best
   moment in this product is the first answer, and it should arrive in under a
   minute.
2. **The setup rail** — a collapsible (never dismissible) checklist in the rail
   footer with a progress ring. Every step deep-links into the *real* product
   surface. **Completion is derived from server state and is monotonic**: once a
   step is satisfied the server stamps it, so deleting a document cannot
   un-complete "train" and cancelling a crawl cannot regress the checklist.
3. **Contextual nudges** — empty states that teach, and an install prompt until
   the widget is verified.

### What the old flow got wrong, and what replaces it

- **The final step hard-blocked on a widget ping with no skip.** Users who could
  not satisfy it never completed onboarding and carried a permanent "Resume
  setup" button. Verification now has an explicit "not yet / remind me", and
  accepts a staging domain.
- **The buyer is not the installer.** For an SMB the person who signs up often
  cannot edit the website. "Email the install steps to your developer" is a
  first-class path, alongside the platform guides.
- **The first crawl fails often** — SPAs, Cloudflare, auth walls. The failure is
  designed first: a credible message and one click to JS mode, sitemap, upload,
  or paste text. The old wizard could not train a JS-rendered site at all, while
  the real Knowledge page could.
- **No website is a legitimate start.** Upload-only and paste-text are supported
  first runs.
- **Day one is all zeros.** The "test your chatbot" step seeds a real
  conversation, so Inbox and Leads have something in them the first time they
  are opened.
- **It was never measured.** `studio_opened` was named in the API client and
  never emitted, so the one number that would have proved the wizard worked was
  not collected. The new flow emits `first_run_started/completed`,
  `first_train_succeeded`, `first_test_message`, `install_snippet_copied`,
  `install_verified`, `first_real_conversation`, `first_lead` — each with a
  target median.
- **The second user has no onboarding.** An invited operator gets their own
  short introduction to the inbox.

---

## 4. Engineering decisions

| Concern | Decision | Why |
|---|---|---|
| Design system | One `src/ui/`. A feature may not define a primitive | Three parallel libraries is the disease, not a symptom |
| Behaviour primitives | **Base UI** (`@base-ui/react`), migrating off Radix | Radix is maintained but will never ship a Combobox — which is why the app reached for `cmdk`, unreleased for 17 months. Base UI ships Combobox, Autocomplete, NumberField, Drawer, Toolbar, Meter and OTP field, has 5 runtime deps against Radix's 19 packages, is built by several of the engineers who built Radix, and became shadcn's default in July 2026. The Radix surface is 11 files — this only gets more expensive |
| Server state | **TanStack Query** | The largest hole in the stack. `/auth/me` is fetched from ten places with no cache; the journey page mounts one hook three times and fires ~30 requests every 15 seconds |
| Table | **TanStack Table v9** | Tree-shakable and opt-in; one file imports it today, so the upgrade is hours |
| Virtualization | **TanStack Virtual** for tables, **react-virtuoso** for the transcript | Scroll anchoring on a streaming, reverse-paginated, variable-height message list is the hardest UI problem in this product; Virtuoso solves it declaratively |
| Dates | **`@daypicker/react`** in a Base UI popover, presets first | 90% of range selection is "last 7 / 30 / 90 days"; the calendar is the escape hatch |
| Charts | **Recharts**, upgraded and lazy-loaded | Best React fit, ships ARIA on series; we are a major version behind |
| Forms | **React Hook Form + Zod** | Uncontrolled, so a 40-field agent config does not re-render per keystroke; Zod mirrors the Pydantic contracts |
| Toasts | **sonner**, kept | Zero dependencies, finished rather than stalled |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-sanitize` | Transcript content is visitor- and LLM-authored. Sanitizing is not optional |
| Rich text editor | **None** | Operators need a fast textarea, `/shortcuts` and Enter-to-send |
| Drag and drop | **None** | WCAG 2.2 SC 2.5.7 requires a pointer alternative anyway; Move up / Move down ships in an afternoon |
| Types | Every `.jsx` becomes `.tsx`; `services/api.js` (3,435 lines behind a 636-line hand-written `.d.ts`) splits into typed domain modules | The sidecar can silently diverge from the implementation, and does |
| Bundle | Route-level splitting, with a budget | One 2.12 MB chunk today. An SMB owner on a mid-tier connection downloads the billing page to read the inbox |

**Also, regardless of the above:** drop the eight unused Radix packages and the
duplicate crop library, move `framer-motion` to `motion` and cut it from 22 files
to the handful that need it, and upgrade `lucide-react` to v1.

### Accessibility items to design in, not retrofit

- **2.4.11 Focus Not Obscured** — sticky table heads and toolbars must not cover
  the focus ring.
- **2.5.7 Dragging Movements** — see above.
- **2.5.8 Target Size (24×24)** — the biggest risk in a dense table: a 14px glyph
  still needs a 24px hit area.
- **3.3.7 / 3.3.8** — signup and chatbot creation.

---

## 5. Capability ledger — nothing may be dropped

Backend capability the UI does not expose today. Each item is a build item with
an owner surface, not a nice-to-have. A slice is not finished until its ledger
entries are closed.

### Blocking bugs
| # | What | Owner |
|---|---|---|
| B1 ✅ | Business hours edit `bots[0]` only — agents 2..N can never have hours | Agent ▸ Experience |
| B2 ✅ | Free workspaces fire `/leads`, take the 403, and land on a generic error instead of an upgrade path | Leads |
| B3 ✅ | A linked **admin** seat is misclassified as an operator on every reload and redirected to `/inbox`, destroying the deep link | Shell |
| B4 ✅ | `?session=` is emitted by the incoming-chat banner and never read; `?tab=` only works on a cold mount | Inbox |
| B5 ✅ | The inbox unmounts its panel on tab switch, closing the operator socket and losing every transcript, unread count and typing state | Inbox |
| B6 ✅ | The Experience preview streams from the shell switcher, not the URL agent | Agent ▸ Experience |

### Found during the rebuild, and fixed

| # | What | Where |
|---|---|---|
| B7 ✅ | `export const httpClient = api` sat above the `axios.create` that defines `api` — a temporal dead zone reference that threw on module evaluation and took down every screen in the app | `services/api.js`. Closed: the export now sits after `axios.create`. |
| B8 ✅ | A checkbox with a visible label had no accessible name outside a `Field`; `Progress` labelled the Track rather than the element carrying `role="progressbar"`; every `CodeBlock` copy button was named "Copy" | `src/ui`. Closed: verified in `Progress.tsx` — `role="progressbar"` sits on the element it belongs to, with a comment naming the earlier defect. |
| B9 ✅ | `normalize_domain_input` strips a leading `www.` before storing but `extract_hostname` does not strip it from the browser's `Origin`, so an allow-list of `acme.com` blocks the customer's own `www.acme.com` homepage | backend · surfaced on Deploy. Closed: fixed at the comparison, not at extraction — `is_origin_allowed` now admits an entry's `www.` host explicitly, so a stored `acme.com` matches an incoming `www.acme.com` Origin. |
| B10 ✅ | `widget_installed_at` is stamped once and never refreshed, and the origin the widget was seen on is read and discarded — so there is no "last seen", only a first-seen date | backend · surfaced on Deploy. Closed: `widget_last_seen_at` / `widget_last_origin` now ship on `BotResponse` (≤2 writes/bot/hour) and Deploy renders both — the origin explicitly as a browser-reported diagnostic, and an empty reading explicitly as "not recorded", never as an outage |

### Orphan endpoints
`GET/PUT /operators/me/notification-preferences` (per-event push + quiet hours)
→ Settings ▸ Notifications (`notificationPreferences.ts`) · `GET
/ingest/status/{job_id}` (upload progress) → Knowledge (`knowledge-api.ts`).
Both verified against the running code, both closed.

`PATCH /operators/session/{id}/qualification` (operator BANT override) got a
client function and a control in `LeadQualification.tsx`, and the control came
back out on review: a plain 0–max dropdown let an operator raise a score as
easily as correct one, which is not the capability the endpoint was reasoned
into existing for (a false-positive extraction the auto-scorer can only ever
raise, never lower, with no other way back). `development` never surfaced this
endpoint as a control either — it existed there behind zero client function,
which is the state the frontend UI is back in now (the `overrideLeadQualification`
wrapper in `services/api.js` is unused, kept rather than deleted in case a
narrower control — one that can only ever lower a score — replaces this one).
Re-opened, not closed.

### Dead client functions — closed
`getVisitorsData` → a real, routed **Visitors** tab on Analytics
(`VisitorsTab.tsx`), one of five — Overview, Conversations, Journey, Visitors,
Feedback — all real paths under `/analytics/*` · `previewBrandTone` /
`takeoverBotSession` → Agent ▸ Experience (`experience-api.ts`) and Workspace ▸
Team (`MembersPage.tsx`) · `removeSelfAsOperator` → `MembersPage.tsx` · `acceptAffiliateInvite`
→ `AffiliateInvite.tsx`, which closes the line directly in its own comment.

### Unsurfaced capability

**Closed, verified against code.** Analytics date range — `?days=` is now
threaded as `range` through every one of the five Analytics tabs, not just
fetched and dropped · knowledge-gap window — `KnowledgeGapsCard` takes a
7d/30d/90d/All control and passes it to the endpoint · Visitors list — see
above · demo share/open funnel → `AgentActionsMenu.tsx` / `overview-data.ts` ·
bot-scoped credit history — Usage renders "Credit history for {bot name}" per
pool, not only the workspace total · `knowledge_characters` quota →
`KnowledgePage.tsx` · `api_access` / `online_support` plan flags →
`ApiKeysPage.tsx` / `ContactSection.tsx` · branding text/URL editor →
`BrandingSection.tsx` · notification-centre unread filter — the All/Unread tabs
on the notification panel · per-conversation rating and resolution → wired
through `liveChatProtocol.ts` / `visitorProfile.ts` / `inboxQueries.ts` ·
meeting bookings → `MeetingsPanel.tsx` · dunning state → `DunningBanner.tsx`
(customer side) and a full `DunningTab.tsx` (super-admin) · per-invoice GST
breakdown → `InvoicesSection.tsx` · plan overage rate and trial days →
`billingModel.ts` / `planPricing.ts` and the super-admin catalogue.

**Still open**, unchanged from before this pass: server-side lead filtering
and pagination (200-row client cap today) · live credit costs from
`/credits/balance` (hard-coded in the UI while super-admins can override
them) · crawl limits (nothing in `KnowledgePage`/`Deploy` surfaces them) ·
operator profile edit · seed-question re-editing · per-lead visitor journey
(distinct from the aggregate Journey tab) · **live-chat audit trail** (written
on every transition, read by nothing) · queue analytics · chat-history
pagination in the lead transcript · `max_bots` / `extra_bot_seats`.

**The product-feedback launcher was found missing, and fixed, in this pass.**
Not a backend-capability gap — `getMyFeedback`, `submitPlatformFeedback` and
`uploadFeedbackAttachment` were already live in `services/api.js`, untouched by
the rebuild — but the right-edge "Feedback" tab and its dialog never got a
`src/ui`-based home the way search and notifications did, and this ledger
never named it. It does now, so the next read of this file does not have to
rediscover it: `FeedbackLauncher.tsx`, mounted in `AppShell`.

**Closed since the API caught up.** Five entries left that list because the
backend stopped blocking them, and each now has exactly one owner surface:
*email suppression list* → Leads ▸ Unsubscribes (read + append; there is
deliberately no delete, and the panel says why) · *follow-up pause* → Agent ▸
Behaviour ▸ Lead follow-up emails · *agent pause* → the chatbot's actions menu,
with `agentHealth` carrying a `paused` state to every surface that reads it ·
*visitor disconnect timeout* → Settings ▸ Team ▸ Routing · *operator deactivate
vs delete* → Settings ▸ Team ▸ People. What remains genuinely unreachable is
**routing strategy** and **`operator_disconnect_timeout`**, and neither is a
missing endpoint: both columns are inert, so they stay named on Behaviour under
"Not configurable yet" rather than being given a control that would save and
change nothing.

### Super-admin ✅
The console exists: `src/superadmin/`, mounted at `/platform`, with its own
shell, its own HTTP layer (`client.ts` — roughly a hundred endpoints had no
client function of any kind), shared list/record plumbing, and seven sections:
command centre, customers, records, revenue, billing operations, catalogue and
configuration. Every endpoint listed below is now reachable.

What the console could *not* build, because the API blocks it, is recorded on
the screen that would have owned it rather than omitted — a super-admin needs to
know a control is missing, not wonder why they cannot find it.

Originally: roughly 110 endpoints with **no UI at all**: command centre and health,
customers and impersonation, plans/pricing/coupons/promotions, billing ops
(refunds, GSTR export, dunning, reconciliation), webhook replay, model config
and LLM cost, the data browsers, and growth reporting. Slice 8, in its own shell
— a super-admin is not a workspace member, and retrofitting that into a shell
which assumed one persona is how you end up with two shells anyway.

---

## 6. How we will know it worked

Correctness is the floor, not the goal. The audit's 235 defects all close, the
ledger is fully assigned, contrast is computed rather than eyeballed, and lint,
typecheck, build and tests stay green.

But 235 closed defects is a 7. The rest is experience, and it gets measured too:

- **Time to first real answer** for a new customer, median.
- **A keyboard-only path through the inbox** — accept, reply, transfer, resolve,
  without a mouse.
- **Interaction latency in the inbox** under a realistic conversation load.
- **Initial JS budget**, and a per-route budget for the inbox.
- **Activation funnel** — the events in §3, each with a target median, because
  the previous onboarding shipped without the one metric that would have told
  anyone whether it worked.
