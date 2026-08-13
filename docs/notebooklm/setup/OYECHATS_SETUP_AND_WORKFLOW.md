# OyeChats — Setup & Ongoing Workflow: The Connective Journey

*Self-sufficient NotebookLM knowledge source on how a business actually sets up OyeChats and runs it day-to-day. This is not a feature-depth document — it's the connective tissue across features: the path a real business owner walks, from first login through Launch Studio into daily operator life. Where a step's substance is a full feature in its own right, this document points to the sibling feature doc instead of re-explaining it.*

Evidence tags used throughout: **[T1]** = confirmed directly in code, **[T2]** = confirmed in product docs, **[T3]** = marketing positioning/claim, **[VERIFY]** = could not confirm, flagged rather than guessed.

---

## 1. What This Doc Covers

This document answers one question: *what does it actually feel like to start using OyeChats, and what does living with it look like afterward?* It covers:
- The guided onboarding wizard ("Launch Studio") step by step, in the **actual shipped order** — verified directly against the live step configuration, not a planning document.
- The moment setup stops being setup and starts being proof ("first value").
- What an operator does once the agent is live — the daily loop.
- The dashboard's intended navigation shape, with an honest flag on what's confirmed shipped vs. still directional.
- A brief pointer to team/operator invites (a full feature in its own right, covered elsewhere).
- One full, human, first-day scenario tying the whole flow together.

It deliberately does **not** re-explain what each feature does at depth — knowledge training, widget branding, lead qualification, live chat handoff, analytics, and billing each have their own sibling documents in this package. This doc is the map between them, not a replacement for any of them.

---

## 2. The Setup Journey (Launch Studio)

OyeChats calls its onboarding wizard **Launch Studio**. It is a one-time, gated flow: a new customer completes it once, then is redirected to the regular dashboard and never sees it again **[T1]**.

### 2.1 The step-order mismatch — read this first

`app/CLAUDE.md` (the active build mandate governing the dashboard) describes an **8-step aspirational plan**:
> `1 Connect Website → 2 Analyze Website → 3 Train AI → 4 Review Knowledge → 5 Test AI → 6 Customize Widget → 7 Deploy → 8 Verify Installation`

The **actual shipped code**, verified directly against `app/src/features/launch-studio/steps.config.ts`, defines a different, **7-step** sequence. The file's own inline comment explains the discrepancy:
> *"Launch Studio - 7-step onboarding. Step merges vs. previous 9-step build: Welcome + Plan Selection → 'welcome' (choose plan before building) · Connect Website + Knowledge → 'train' (one URL-to-trained surface)."*

So there have been at least **three** different conceptual versions of this flow over time (a 9-step build, the mandate's 8-step aspiration, and the current 7-step shipped reality) — none of them identical. **[VERIFY]** This document describes the 7-step shipped reality below, because it is the only version directly confirmed against running code. Do not present the mandate's 8-step list as what a customer experiences today.

### 2.2 The 7 real steps, in order

Each step's React component and route key are confirmed directly from `steps.config.ts` and the corresponding file under `app/src/features/launch-studio/steps/`.

| # | Step key | Screen label | What happens |
|---|---|---|---|
| 1 | `welcome` | **Welcome** | A calm orientation screen ("In a few guided steps you'll create an AI Chatbot trained on your content and put it live on your site") that **doubles as plan selection** — the customer picks a plan (including Free) before building anything, via the same `PlansPanel`/checkout surface used in Workspace → Billing. Continuing is gated on an explicit plan choice. **[T1]**, `WelcomePlanStep.tsx` |
| 2 | `create` | **Create Agent** | The customer names their AI agent. This single action calls `createBot()` and creates a real bot record with a unique `bot_key` immediately — not a draft. A returning user with an existing bot can rename it here instead of creating a second one; naming is never locked. **[T1]**, `CreateAgentStep.tsx` |
| 3 | `train` | **Setup & Train** | The merged "Connect Website + Knowledge" step (see comment above). One continuous, state-driven surface: enter a website URL (or upload PDF/DOCX/TXT as a fallback) → the system discovers pages and shows a page count + credit-cost estimate before committing → customer confirms (with a slider to cap page count if the site exceeds their credit balance) → a live "Teaching your AI" progress view streams page-by-page while the crawl and embedding pipeline runs → once training finishes, a "What your AI learned" review lists every trained source, expandable to individual pages, with inline options to add another site or more documents. Full training mechanics (crawl provider, chunking, embedding) belong to the Chatbot/RAG feature doc — this step is the *experience* around that pipeline, not the pipeline itself. **[T1]**, `TrainStep.tsx` |
| 4 | `test` | **Test Agent** | The **aha moment** — see Section 3 below. **[T1]**, `TestStep.tsx` |
| 5 | `customize` | **Customize Widget** | Brand color, message-bubble color, and launcher avatar (photo upload / animated orb / mascot), with live-preview sync. **Fully covered in `docs/notebooklm/features/OYECHATS_FEATURE_WIDGET_BRANDING.md`, including the automatic brand-color and favicon-avatar extraction that runs during crawl — this document does not repeat that depth.** **[T1]**, `CustomizeStep.tsx` |
| 6 | `deploy` | **Deploy** | Customer picks their website platform first (WordPress, Shopify, Webflow, Next.js, plain HTML, and others reused from the platform-integration config), then gets platform-specific install steps with a copyable snippet scoped to their real `bot_key`. A distinct "Copy prompt for AI coding agent" button generates a structured installation briefing the customer can paste into Cursor, Claude, or Copilot so an AI assistant does the install for them. **[T1]**, `DeployStep.tsx` |
| 7 | `verify` | **Verification** | Before onboarding can complete, the app actively polls the bot record for `widget_installed_at` (every 3 seconds, up to ~30 seconds) to confirm the snippet is genuinely live and answering on the customer's real site. This is a deliberately distinct, enforced step — the code comment explicitly notes the legacy flow merged this into Deploy and let people finish unverified, and the current build does not. "Go to dashboard" only unlocks once installation is detected. **[T1]**, `VerifyStep.tsx` |

**Two files exist but are not wired into the shipped flow:** `ConnectStep.tsx`, `KnowledgeStep.tsx`, and `PlanStep.tsx` all still exist in the same directory, but `LaunchStudio.tsx`'s `STEP_COMPONENTS` map only references `WelcomePlanStep`, `CreateAgentStep`, `TrainStep`, `TestStep`, `CustomizeStep`, `DeployStep`, and `VerifyStep`. **[T1]**, confirmed by direct inspection of the map in `LaunchStudio.tsx`. The unwired files appear to be an earlier, unmerged version of the same steps (pre-dating the "Connect Website + Knowledge → train" and "Welcome + Plan Selection → welcome" merges) — treat them as dead code for the purposes of describing the current product, not as an alternate path a customer could hit.

**Automatic vs. requires customer input:**
- *Automatic:* page discovery/crawling once a URL is submitted, chunking and embedding, streamed answers during Test, live-install polling in Verify.
- *Requires the customer:* naming the agent, providing a URL or documents, confirming crawl/training cost, asking test questions, customization choices, picking a platform and pasting the snippet, and publishing the page with the snippet on their own live site.

---

## 3. First Value Moment

The **Test Agent** step (step 4, `test`) is the flow's engineered "aha" — the point where the abstraction of "we trained your AI" becomes a concrete, believable, working answer.

Mechanically **[T1]**, `TestStep.tsx` + `seed_questions_service.py`:
- The step fetches up to 3 **pre-verified seed questions** for the specific bot via `getSeedQuestions()`, backed by `api/app/services/seed_questions_service.py`. This is a two-stage pipeline, not a guess: an LLM *generates* candidate questions from the bot's auto-extracted company context, then each candidate is *verified* by running the actual retrieval pipeline the live bot uses — but with a **tighter** relevance cut than normal chat (`0.60` cosine distance vs. the `0.78` live-chat default) — and only survives if it returns at least one strongly on-topic chunk. The explicit design intent, quoted directly from the service's own docstring: *"a seeded question must NEVER produce a weak or 'I don't know' answer — a bad first answer damages trust more than no sample."*
- If a bot has zero indexed content, or nothing survives verification, the pipeline returns an empty list — the UI is designed to fall back gracefully to generic fallback prompts ("What do you offer?", "How much does it cost?", "How do I get started?") rather than error.
- The customer clicks a suggested question (or types their own) and watches a **real, streamed answer** come back in a live widget preview panel, generated from the content that was *just* crawled minutes earlier.

**Why this matters:** this is the single moment in the whole journey where the customer stops taking OyeChats' claim on faith and sees their own website's knowledge talking back to them. It is explicitly engineered to never embarrass itself on the first try.

**A related but separate guardrail — preview quota [T1], `api/app/services/preview_quota.py`:** owner-preview chats (used throughout Launch Studio and the dashboard's own bot-preview surfaces) skip normal per-message credit deduction so a bot owner can test freely. To prevent that free path being abused as unlimited real LLM usage, a per-bot daily cap (`PREVIEW_DAILY_LIMIT`) is enforced — Redis-backed in production, with an in-process fallback for local dev, and fails *open* (allows the request) only during a genuine Redis outage. This is a technical guardrail explaining why "test freely" doesn't mean "test infinitely."

---

## 4. Day-to-Day Operator Workflow

Once Launch Studio completes, the customer (and any invited teammates) lives in the regular admin dashboard — Launch Studio is never revisited **[T1]**.

The intended daily rhythm, synthesized from `app/CLAUDE.md`'s stated design philosophy ("reduce friction, make every workflow obvious, give every page a single responsibility") and cross-referenced against root `CLAUDE.md`'s end-to-end flow:

1. **Home** — a daily operational overview: is the agent healthy, how many conversations happened, recent leads, usage against plan, recommended next actions. The question it answers: *"Is my AI healthy?"* **[T2]**
2. **AI Agents** — per-agent configuration and health, with (per the mandate) exactly six tabs: **Overview · Knowledge · Experience · Channels · Analytics · Advanced**. An operator checking in on a specific agent lands here, not in a generic settings page. **[T2]**
3. **Inbox** — the live-chat operator console: conversations the AI has escalated to a human sit in a queue, an operator picks one up (or is auto-routed one) with full context already loaded, and takes over from the AI mid-conversation. Full handoff mechanics (routing strategies, multi-device notification, the audited state machine) live in the Live Chat Handoff feature doc — this document only places Inbox in the daily loop. **[T2]**
4. **Leads** — the daily review surface for captured, qualified, and enriched visitor records that conversations produced. Full qualification/enrichment mechanics live in their own feature docs. **[T2]**
5. **Analytics** — how the agent is performing and what visitors did before/during/after chatting; the reporting layer on top of the operational tools above. **[T2]**
6. **Workspace** — the deliberately-separated administrative area: team members, billing, usage, security, API keys, integrations, workspace settings. Per the mandate, agent-level configuration is never placed here. **[T2]**

**A realistic daily loop, synthesized (not a quoted product description):** an operator opens Home to sanity-check overnight activity → glances at Inbox to see if anything needs a human right now → checks Leads for anything worth a follow-up call → periodically reviews Analytics to see if the agent's answers are landing → occasionally visits Workspace for billing/usage or to invite a teammate. **[VERIFY]** — this loop is a reasonable synthesis of the six areas' stated purposes, not a documented "daily workflow" narrative found verbatim in any single source.

---

## 5. Dashboard Navigation / IA

**⚠️ [VERIFY] — this is a known, unresolved conflict already documented in `docs/notebooklm/marketing/OYECHATS_SOURCE_OF_TRUTH.md`, stated here plainly rather than re-resolved:**

- `docs/oyechats-technical-story.md` describes one sidebar: **Home, Chatbots, Support, Leads, Journey, Analytics, Workspace, Settings** (plus Launch Studio).
- `app/CLAUDE.md` — the literal, currently-active build mandate for everything under `app/` — specifies a *different*, single sidebar:

```
🏠 Home        🤖 AI Agents        💬 Inbox        👥 Leads        📊 Analytics        ⚙ Workspace
```

with an explicit instruction: *"Nothing else. No Build. No standalone Settings. No duplicated navigation."* The mandate also explicitly forbids reusing the existing navigation as a UX reference — the old IA is a technical reference only, not a target.

**This document treats `app/CLAUDE.md`'s six-item IA as the target/intended structure** — it is the governing mandate for ongoing work — but does **not** assert it is fully, pixel-confirmed live in production today. No live screenshot or route-file audit was performed as part of this document's research pass. **Any depiction of exact on-screen sidebar labels must be verified against the actually-deployed dashboard first.**

Per the mandate, each of the four major areas answers exactly one question:

| Page | Question it answers |
|---|---|
| Home | "Is my AI healthy?" |
| AI Agents → Overview | "Is my AI healthy?" (per-agent) |
| AI Agents → Knowledge | "What does my AI know?" |
| AI Agents → Experience | "What will visitors see?" |
| AI Agents → Channels | "Where is my AI connected?" |
| AI Agents → Analytics | "How is my AI performing?" |
| AI Agents → Advanced | "How do I configure technical behaviour?" |

---

## 6. Team Onboarding Workflow

OyeChats supports multi-person workspaces; this is a full feature covered in depth in `docs/notebooklm/features/OYECHATS_FEATURE_TEAM_OPERATORS.md` — this section is a pointer, not a re-explanation.

The relevant connective facts for this journey **[T1]**:
- The workspace owner (or an operator with the **admin** role) sends an invite; the invited person joins as an **operator**.
- Invited operators are **bot-scoped** — access is tied to specific agents, not blanket workspace access.
- Once inside, an operator's effective role is one of **owner**, **admin**, or **operator**.

This typically happens *after* the initial Launch Studio journey (usually from Workspace → Members), when the solo founder who ran onboarding is ready to bring a support or sales teammate into the live-chat Inbox loop. See the Team & Operators feature doc for invite-flow mechanics, role permissions, and the legacy-operator edge case.

---

## 7. A Real Scenario Walkthrough

**Priya runs a 12-person D2C skincare brand with a WordPress site.** She's tired of answering the same five questions in her inbox every day — shipping times, ingredient lists, return policy.

She signs up for OyeChats and lands directly in **Launch Studio**.

1. **Welcome** — she reads the one-line pitch, then picks the Free plan to try it first before committing to spend.
2. **Create Agent** — she names it "Priya's Skincare Assistant." A real bot record is created instantly.
3. **Setup & Train** — she pastes her site URL. OyeChats discovers 34 pages and estimates the credit cost. She confirms, and watches a live progress bar as pages stream in — "Teaching your AI" — she doesn't even wait for it to finish before the screen tells her she can continue as soon as the first page lands. A minute later, the review view shows her 34 trained pages, organized by source, and she notices her shipping and returns pages are both in there.
4. **Test Agent** — this is the moment. Three suggested questions appear, generated from her own site and pre-verified so they won't embarrass the product: "What ingredients do you use?", "How long does shipping take?", "What's your return policy?" She taps the shipping one. A real, streamed answer comes back — accurate, in the platform's default voice — pulled from her own FAQ page. She didn't write a single line of scripted response. This is the moment she decides the product is real.
5. **Customize Widget** — the brand-color extraction already picked up her site's signature blush pink as a recommended swatch (see the Widget Branding feature doc); she confirms it and uploads her logo as the launcher avatar.
6. **Deploy** — she picks WordPress from the platform list, copies a short snippet scoped to her actual bot key, and pastes it into her theme's footer.
7. **Verification** — OyeChats polls her live site every few seconds. Within moments, `widget_installed_at` is detected, and "Go to dashboard" unlocks. She's live.

**Day two:** Priya opens the dashboard. Home shows three overnight conversations and one new lead. She clicks into Inbox and sees one conversation flagged for a human — a visitor asking about a bulk wholesale order, which the AI correctly routed for a human touch. She picks it up, already has the visitor's prior messages in front of her, and closes the sale herself. Later that week she invites her one support hire as an operator, scoped to that same bot, so the two of them share the Inbox queue going forward.

---

## 8. Evidence & Open [VERIFY] Items

**Confirmed directly in code [T1] (highest confidence):**
- The 7-step shipped Launch Studio order and every step's mechanics, from `steps.config.ts` and each step's `.tsx` file.
- `ConnectStep.tsx`, `KnowledgeStep.tsx`, `PlanStep.tsx` exist but are not wired into `LaunchStudio.tsx`'s `STEP_COMPONENTS` map — dead/unused for the current product.
- Seed-question generation + verification pipeline and its intentional "never show a weak first answer" design goal (`seed_questions_service.py`).
- Preview-chat daily quota mechanism and its fail-open behavior during Redis outages (`preview_quota.py`).
- Activation event stream + TTVLW ("time to verified live widget") metric exists as a super-admin funnel view (`activation_routes.py`) — confirms the platform itself measures onboarding speed internally, though this metric is not customer-facing.
- Team invite roles (`operator`, `admin`) and bot-scoped operator access, per root `CLAUDE.md`'s `Operator` model.

**Open [VERIFY] items — do not present as settled fact without further checking:**
1. **The 8-step vs. 7-step mismatch** (Section 2.1) — `app/CLAUDE.md`'s mandate describes 8 aspirational steps; shipped code has 7. This document follows the shipped code as ground truth, per the source-hierarchy rule that working code outranks a planning document, but flags the mismatch explicitly rather than silently picking a winner.
2. **Dashboard IA** (Section 5) — whether the six-item `app/CLAUDE.md` sidebar (Home/AI Agents/Inbox/Leads/Analytics/Workspace) is fully shipped in production, versus the older eight-item IA described in `docs/oyechats-technical-story.md`. This is the same unresolved conflict already logged in `OYECHATS_SOURCE_OF_TRUTH.md`'s Conflict Log — repeated here because it's directly load-bearing for this document's Section 5, not independently re-resolved.
3. **The "realistic daily loop" narrative in Section 4** is a synthesis built from the six areas' individually-documented purposes, not a verbatim documented workflow — reasonable, but not a quoted source.
4. **Priya scenario in Section 7** is an illustrative composite for narrative purposes, built entirely from confirmed mechanics above — it is not a real customer case study, and must never be presented as one (no named customer or testimonial exists in any inspected source, per the Source of Truth doc's Business Outcome Claims table).

**Do-not-invent reminders, consistent with the rest of this package:**
- Do not claim the 8-step plan is what a customer experiences today.
- Do not depict onboarding as skippable, or Verification as optional — the code gates "Go to dashboard" behind a genuinely detected live install.
- Do not depict specific sidebar labels as confirmed on-screen fact without a fresh screenshot check.
- Do not turn the Priya scenario into a claimed real testimonial.
