# OyeChats — NotebookLM Knowledge Package

This folder is a purpose-built documentation package for uploading into Google NotebookLM. It is pure product knowledge — what OyeChats is, how it works, and how to set it up and run it — organized so each document (or small group of documents) is a complete, self-sufficient source on its own subject.

Every document uses a consistent evidence-tagging discipline so nothing generated from it states something the team can't stand behind:
- **[T1]** — confirmed directly in source code.
- **[T2]** — confirmed in first-party product/engineering documentation (root `CLAUDE.md`, `app/CLAUDE.md`, `docs/oyechats-technical-story.md`).
- **[T3]** — marketing positioning/framing, not a technical fact.
- **[MARKETING CLAIM — VERIFY IMPLEMENTATION]** — stated in marketing material, not independently re-verified against code.
- **[VERIFY]** — an open question, flagged explicitly rather than silently resolved.

The package was built by auditing the actual OyeChats codebase directly — not just filenames or prior docs — across `oye-chats-platform` (api/, app/, widget/).

---

## Folder Structure

```
docs/notebooklm/
├── README.md                              ← you are here (navigation, not a knowledge source itself)
├── marketing/                             ← business-language product story
│   ├── OYECHATS_MASTER_KNOWLEDGE.md       ← primary source, full product truth in business language
│   ├── OYECHATS_SOURCE_OF_TRUTH.md        ← evidence matrix backing every claim
│   ├── OYECHATS_MARKETING_STORY.md        ← narrative story beats
│   ├── OYECHATS_NOTEBOOKLM_QUICK_CONTEXT.md   ← compressed executive summary of the above
│   └── OYECHATS_VIDEO_STYLE_PROMPT.md     ← locked visual-style prompt for marketing videos (creative direction, not a fact source)
├── technical/                             ← deep architecture reference
│   └── OYECHATS_TECHNICAL_KNOWLEDGE.md    ← architecture, data model, AI pipeline, security, infra
├── setup/                                 ← onboarding + day-to-day workflow
│   └── OYECHATS_SETUP_AND_WORKFLOW.md     ← Launch Studio onboarding + day-to-day operator loop
└── features/                              ← one self-sufficient doc per major feature
    ├── OYECHATS_FEATURE_CHATBOT.md            ← grounded AI chatbot + knowledge training
    ├── OYECHATS_FEATURE_QUALIFICATION.md      ← silent BANT/MEDDIC/CHAMP/GPCTBA+C&I lead scoring
    ├── OYECHATS_FEATURE_LIVE_CHAT.md          ← human handoff, queueing/claiming, canned responses, offline messaging
    ├── OYECHATS_FEATURE_LEAD_ENRICHMENT.md    ← email verification + company lookup
    ├── OYECHATS_FEATURE_JOURNEY_ANALYTICS.md  ← visitor page-journey tracking
    ├── OYECHATS_FEATURE_WIDGET_BRANDING.md    ← one-line install + auto brand-matching + customization
    ├── OYECHATS_FEATURE_BILLING.md            ← credit ledger, invoicing, Razorpay, lapse behavior
    ├── OYECHATS_FEATURE_TEAM_OPERATORS.md     ← inviting teammates, roles, multi-device alerts
    └── OYECHATS_FEATURE_AFFILIATE.md          ← referral/affiliate program
```

Each document is self-sufficient: uploading **only that one file** to a fresh NotebookLM notebook is enough to work from it in isolation. Cross-references between documents exist (e.g. the setup doc points to the feature docs rather than re-explaining them), but no document depends on another to avoid being wrong.

---

## Which Documents to Use for Which Purpose

**Overall product / business story** — use everything in `marketing/` (4 files). Priority if a source-count limit forces trimming:
1. `OYECHATS_MASTER_KNOWLEDGE.md` (must-have)
2. `OYECHATS_SOURCE_OF_TRUTH.md` (must-have — the guardrail)
3. `OYECHATS_MARKETING_STORY.md`
4. `OYECHATS_NOTEBOOKLM_QUICK_CONTEXT.md` (nice-to-have compressed backup)

**Technical / architecture overview** — use `technical/OYECHATS_TECHNICAL_KNOWLEDGE.md` alone. It is intentionally the longest, deepest document in the package and does not require any other file.

**Setup & daily workflow** — use `setup/OYECHATS_SETUP_AND_WORKFLOW.md` alone. It cross-references the Widget Branding and feature docs by name for anyone who wants more depth, but is complete on its own.

**One feature** — use the single matching file from `features/`. Each is written to be sufficient in isolation; only bundle multiple feature docs together if you deliberately want combined coverage.

---

## Primary Sources by Track

- **Marketing track:** `marketing/OYECHATS_MASTER_KNOWLEDGE.md` — every other marketing doc derives from it or supports a dimension of it (story, evidence).
- **Technical track:** `technical/OYECHATS_TECHNICAL_KNOWLEDGE.md` — the deep-technical sibling to the master knowledge doc, synthesized from `docs/oyechats-technical-story.md` and root `CLAUDE.md`, then spot-checked directly against source (`rag_service.py`, `models.py`, `auth.py`, `ssrf.py`, `response_style.py`, `embedder.py`).
- **Setup track:** `setup/OYECHATS_SETUP_AND_WORKFLOW.md` — the connective tissue across features, from first login through Launch Studio into daily operator life.
- **Feature track:** each `features/OYECHATS_FEATURE_*.md` stands alone, grounded directly in the relevant service/route files.

---

## Unresolved [VERIFY] Items Across the Package

These are flagged, not silently resolved — close them before stating the affected claim as settled fact. Items struck through were closed in the 2026-08-31 documentation audit by reading the shipped source rather than a describing document.

> **One correction from that audit is a standing rule, not a footnote:** the live-chat **routing** claim (item 4) was sourced from a module docstring describing code that nothing calls. Any capability claim built on a docstring, a config column, or a design document — rather than on a traced call path — should be treated as unverified until the caller is found.

1. ~~**Dashboard navigation/IA conflict**~~ — **CLOSED.** Resolved against `app/src/shell/nav.ts:74-110`, the one definition the rail, breadcrumbs and command palette all read. Neither documented IA is what ships. The rail is **Home · Inbox · Leads · Journey · Analytics · Chatbots**, with **Billing** and **Settings** in the footer; Journey is a top-level route, and the customer-facing noun is **"Chatbots," not "AI Agents."** Corrected in `marketing/OYECHATS_SOURCE_OF_TRUTH.md`, `setup/OYECHATS_SETUP_AND_WORKFLOW.md`, `marketing/OYECHATS_MASTER_KNOWLEDGE.md` and `features/OYECHATS_FEATURE_JOURNEY_ANALYTICS.md`.
2. **Launch Studio step-order mismatch** — `app/CLAUDE.md`'s mandate describes an aspirational 8-step onboarding order, but the shipped `app/src/features/launch-studio/steps.config.ts` defines a different, merged 7-step sequence. `setup/OYECHATS_SETUP_AND_WORKFLOW.md` follows the shipped code as ground truth and states the mismatch plainly; three step component files (`ConnectStep.tsx`, `KnowledgeStep.tsx`, `PlanStep.tsx`) exist on disk but are not wired into the live component map — dead code, not an alternate live path.
3. ~~**USD billing rail**~~ — **CLOSED.** `INTL_PAYMENTS_ENABLED` defaults `false` (`api/app/config.py:428`) and every USD charge path 409s while it is off (`api/app/api/subscription_routes.py:554`). USD is display-only; Razorpay/INR is the sole live rail. See `technical/OYECHATS_TECHNICAL_KNOWLEDGE.md` §7.2 and `features/OYECHATS_FEATURE_BILLING.md`.
4. **Live-chat routing is not live at all** — corrected, not merely flagged. The `Department` model and a three-strategy routing service both exist, but `select_operator` (`api/app/services/live_chat_routing_service.py:85`) has **no caller anywhere in the API**, so `Bot.live_chat_routing_strategy` changes nothing. A waiting visitor is announced to the whole eligible operator pool and the first to accept takes the chat. **Never say a chat is routed, balanced, or assigned to a chosen operator.** See `features/OYECHATS_FEATURE_LIVE_CHAT.md` §3.4.
5. **Terminology** — partially closed. **"Bot → Chatbot" is what shipped**; "AI Agent" did not (the string survives once in all of `app/src`, in a filename), so the earlier "Bot → AI Agent" mapping is retired. "Session → Conversation" remains the intended direction and was not re-audited surface-by-surface — still open.
6. **CI/CD, HA/scaling posture, backup restore-testing** — only what's directly documented in root `CLAUDE.md` is stated; pipeline internals, standby infrastructure, and backup restore-test cadence are flagged `[VERIFY]` in `technical/OYECHATS_TECHNICAL_KNOWLEDGE.md` rather than assumed.

None of these block using the package — they exist so any claim built from it is stated deliberately, or not at all, rather than guessed.
