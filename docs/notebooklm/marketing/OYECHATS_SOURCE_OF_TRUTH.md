# OyeChats — Source of Truth / Claim Matrix

*Every major claim used across this documentation package, with its source, evidence, and status. Purpose: prevent NotebookLM (or any downstream consumer of these documents) from treating an unverified or conflicting claim as settled fact. Status values used: **CONFIRMED**, **MARKETING POSITIONING**, **IMPLEMENTATION CONFIRMED**, **NEEDS VERIFICATION**, **NOT SUPPORTED**.*

---

## Source Hierarchy Used

1. **Actual implemented product/code** — files directly inspected: root `CLAUDE.md` (code-derived technical reference), `app/CLAUDE.md` (build mandate), `widget/src/components/*.jsx`, `app/src/design-system/icons/platformLogos.ts`, live asset URLs (curl-verified).
2. **Current product documentation** — `docs/oyechats-technical-story.md` (comprehensive, code-derived narrative).
3. **Current approved marketing story** — `docs/oyechats-marketing-story.md`, developed and reviewed in this working session.
4. **Project memory** (prior-session facts about shipped/unshipped status) — used only as *context for flagging uncertainty*, never as a primary claim source; anything sourced only from memory is marked NEEDS VERIFICATION below.

No raw `.py`/`.jsx` business-logic files beyond those listed above were re-read in this pass; root `CLAUDE.md` is itself maintained as a code-derived reference by the project, and is treated as tier-1 on that basis.

---

## Product Capability Claims

| Claim | Source | Evidence | Status |
|---|---|---|---|
| Business points platform at its website; content is crawled/read into a private knowledge base | root `CLAUDE.md` RAG Pipeline; `docs/oyechats-technical-story.md` Part 5 | `api/app/ingestion/pipeline.py`, `embedder.py` referenced in Key Files table | CONFIRMED |
| Answers are grounded only in the business's own content (hybrid vector + keyword search) | root `CLAUDE.md` RAG Pipeline diagram | `rag_service.py` referenced directly | CONFIRMED |
| Relevance gate refuses to answer when nothing relevant is retrieved | root `CLAUDE.md` (`RELEVANCE_GATE_ENABLED` flag); `docs/oyechats-technical-story.md` Part 6.6 | Named config flag in code reference | CONFIRMED |
| Reranking (cross-encoder) available | root `CLAUDE.md` (`RERANK_ENABLED` flag) | Named config flag, off by default per doc | IMPLEMENTATION CONFIRMED (optional, not always-on) |
| Qualification frameworks: BANT, MEDDIC, CHAMP, GPCTBA+C&I | root `CLAUDE.md` `Bot.qualification_framework`, `BANTSignal` model; `docs/oyechats-technical-story.md` Part 7 | DB model field + narrative doc agree | CONFIRMED |
| Interactive qualification chips ship OFF by default on every framework | `docs/oyechats-technical-story.md` Part 7.1 | Direct quoted statement in doc; not independently re-verified against code in this pass | IMPLEMENTATION CONFIRMED (per doc; not re-read in raw code) |
| Live human handoff with 4-state machine, routing strategies, multi-device notification | root `CLAUDE.md` `ChatSession.status`, `Operator`, `ChatAuditLog`, `live_chat_service.py`, `ws_routes.py`; `docs/oyechats-technical-story.md` Part 9 | Model fields + service file references agree | CONFIRMED |
| Lead capture with email verification, company lookup, journey enrichment | root `CLAUDE.md` `LeadInfo` model; `docs/oyechats-technical-story.md` Part 8 | Model + doc agree | CONFIRMED |
| IP-based company/organization lookup is "metered and currently held behind a flag" | `docs/oyechats-technical-story.md` Part 8.2 | Direct quoted statement | IMPLEMENTATION CONFIRMED (explicitly not fully live — do not market as always-on) |
| Credit ledger is append-only/event-sourced; lapse deactivates (not deletes) knowledge | root `CLAUDE.md` `CreditLedger` model; `docs/oyechats-technical-story.md` Part 10, Part 11 | Model + doc agree | CONFIRMED |
| Razorpay/INR is the sole live payment rail; USD pricing exists but is staged behind a flag | root `CLAUDE.md` Tech Stack table ("Razorpay (INR) — single provider"); `docs/oyechats-technical-story.md` Part 10.1 | Direct tech-stack table entry + narrative doc agree | CONFIRMED (do not depict USD billing as live) |
| One-line embeddable widget works on any website with a body tag | root `CLAUDE.md` "Widget Embedding — How It Works" | Direct section, lists WordPress/Webflow/Shopify/plain HTML | CONFIRMED |
| Platform-specific install guidance covers HTML, Next.js, React, Vue, Angular, Shopify, Squarespace, Svelte, Webflow, Wix, WordPress, Framer, Bubble, Astro, GTM | `app/src/design-system/icons/platformLogos.ts` | Direct source inspection of the icon-mapping file | CONFIRMED |
| Widget launcher avatar is customizable: animated "orb," generic "mascot," or business's own uploaded logo | `widget/src/components/Launcher.jsx` `renderBotIcon()` | Direct source inspection | CONFIRMED |
| Super-admin Control Tower: cross-tenant visibility, runtime pricing/model config, impersonation, webhook replay | `docs/oyechats-technical-story.md` Part 15 | Narrative doc, internal-only surface | CONFIRMED, but **PRODUCT CAPABILITY — NOT CURRENTLY POSITIONED** for buyer-facing material (internal ops tool, not a customer feature) |
| Affiliate program with tracked referral codes | `docs/oyechats-technical-story.md` Part 10.13 | Narrative doc | CONFIRMED, but a distinct audience from the core buyer story |

---

## Structural / Organizational Claims

| Claim | Source | Evidence | Status |
|---|---|---|---|
| Actors: Visitor, Customer/Owner, Operator, Affiliate, Super Admin, background "Machine" | `docs/oyechats-technical-story.md` Part 1 | Narrative doc, consistent with DB models (`Client`, `Operator`) | CONFIRMED |
| Dashboard IA = Home, Chatbots, Support, Leads, Journey, Analytics, Workspace, Settings (+ Launch Studio) | `docs/oyechats-technical-story.md` Part 2 | Narrative doc | **CONFLICTS with row below — see Conflict Log** |
| Dashboard IA = Home, AI Agents, Inbox, Leads, Analytics, Workspace (no separate Journey/Settings nav) | `app/CLAUDE.md` "Information architecture — the ONLY sidebar" | Direct quote from the active build mandate governing `app/` | **CONFLICTS with row above — see Conflict Log** |
| Admin dashboard is a real, actively-developed interface (not a mockup) | `app/src/shell/OyeChatsMark.tsx` | Direct source inspection — functioning theme-aware logo component | CONFIRMED (existence of a real app); does not resolve which IA version is currently shipped |

### Conflict Log — Dashboard Information Architecture

**Nature of conflict:** `docs/oyechats-technical-story.md` (tier 2, current product documentation) and `app/CLAUDE.md` (tier 1, the active build mandate for the same surface) describe two different navigation structures for the same admin dashboard.

**Resolution applied in this package:** `app/CLAUDE.md` is treated as the more authoritative statement of *current direction* because it is the literal governing mandate for ongoing work in `app/` and explicitly states it supersedes prior UX/IA ("DO NOT reuse the existing... navigation, information architecture"). However, this package does **not** assert that the new IA is fully shipped/live — per source-hierarchy priority, "actual implemented code" would outrank both documents, and no direct UI screenshot or route-file audit was performed in this pass to confirm which IA a live user currently sees.

**Practical instruction:** Any material citing specific dashboard navigation labels must be verified against the actually-deployed dashboard immediately before use — do not trust either document's nav labels blindly. Prefer generic framing (a leads list, a conversation view) over asserting exact nav text as current fact. **Status: NEEDS VERIFICATION.**

---

## Terminology Standardization Map

| Legacy/internal term | Current customer-facing term | Evidence | Status |
|---|---|---|---|
| Bot / Chatbot | AI Agent | `app/CLAUDE.md` IA uses "AI Agents"; DB table/model is still literally `Bot` internally (root `CLAUDE.md` schema) | CONFIRMED — both true simultaneously: internal code name vs. external customer-facing label, not a contradiction |
| Session (`ChatSession`) | Conversation | `app/CLAUDE.md` "Session→Conversation" direction; internal model name unchanged | NEEDS VERIFICATION for exact rollout completeness, but directionally CONFIRMED as the intended customer-facing term |
| Crawl | Train / Training | `docs/oyechats-technical-story.md` Part 4.2 Step 3 itself is titled "Setup and Train," while internal mechanism is called "crawl" throughout the same doc | CONFIRMED — customer-facing step is already named "Train" in the current technical documentation itself |
| Human rep / generic "Agent" (person) | Operator | root `CLAUDE.md` `Operator` model, `X-Operator-Key` header, `X-Agent-Key` explicitly marked "legacy alias... during agent → operator rename" | CONFIRMED — directly evidenced in code/auth headers |
| Contact | Lead | root `CLAUDE.md` `LeadInfo` model | CONFIRMED — already aligned, no rename needed |
| Client (DB model) | Account / Business / Customer | root `CLAUDE.md` `Client` model; customer-facing language throughout marketing docs uses "the business"/"the account" | CONFIRMED as customer-facing framing; internal model name unchanged |

**Usage instruction for this package:** all customer-facing documents in this folder use the right-hand column terms. Internal/technical documents (root `CLAUDE.md`, `docs/oyechats-technical-story.md`) may still use legacy terms like "bot" or "session" — this is expected and not an error to correct in those documents.

---

## Business Outcome / Metric Claims

| Claim | Source | Evidence | Status |
|---|---|---|---|
| Any conversion-rate lift, ROI percentage, or revenue figure | — | No such figure appears in any inspected source | **NOT SUPPORTED — do not use** |
| Any named customer, testimonial, or case study | — | None found in any inspected source | **NOT SUPPORTED — do not use** |
| "Nothing falls through the cracks" / leads are automatically enriched and recorded | `docs/oyechats-technical-story.md` Part 8 | Direct capability description | MARKETING POSITIONING (framing of a real, confirmed capability — not a numeric claim) |
| "Reversible churn" (lapse pauses, doesn't delete knowledge) | `docs/oyechats-technical-story.md` Part 11 | Direct capability description | CONFIRMED as product mechanism; "most humane mechanic in the product" phrasing is MARKETING POSITIONING layered on top of a confirmed mechanism |

---

## Summary of Open [VERIFY] Items

1. **Dashboard IA** — which navigation structure (technical-story.md's or `app/CLAUDE.md`'s) is actually live at production time. *(See Conflict Log above.)*
2. **Terminology rollout completeness** — "Bot→AI Agent" and "Session→Conversation" are confirmed as the *intended* current direction, but full rollout across every customer-facing surface was not independently re-audited in this pass.
3. **Qualification chip default-off behavior** — confirmed via the narrative documentation (`docs/oyechats-technical-story.md`) but not independently re-verified against the raw `qualification_service.py` source in this pass (subsequently closed with direct code confirmation in `features/OYECHATS_FEATURE_QUALIFICATION.md`).
