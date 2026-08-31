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
| Qualification frameworks: BANT, MEDDIC, CHAMP, GPCTBA+C&I | `PRESET_FRAMEWORKS` in `qualification_service.py`; `BANTSignal` model; `docs/oyechats-technical-story.md` Part 7 | Confirmed in the service. **Do not cite `Bot.qualification_framework` as the evidence — no such column exists.** The bot's framework lives in `Bot.bant_config` (JSONB, `models.py:361`); the `qualification_framework` column is on `chat_sessions` (`models.py:985`), stamping which framework scored one conversation. | CONFIRMED (citation corrected) |
| Background qualification scoring runs on ARQ | — | It does not. `_background_bant_extraction` is dispatched through `core/thread_pool.submit_background` (`rag_service.py:7274`), an in-process pool, so the work is **non-durable** — an API restart mid-flight loses that turn's scoring with no retry. | **NOT SUPPORTED as stated** — say "in the background after the answer is sent," not "queued" or "durable" |
| Interactive qualification chips ship OFF by default on every framework | `docs/oyechats-technical-story.md` Part 7.1 | Direct quoted statement in doc; not independently re-verified against code in this pass | IMPLEMENTATION CONFIRMED (per doc; not re-read in raw code) |
| Live human handoff with 4-state machine and multi-device notification | root `CLAUDE.md` `ChatSession.status`, `Operator`, `ChatAuditLog`, `live_chat_service.py`, `ws_routes.py`; `docs/oyechats-technical-story.md` Part 9 | Model fields + service file references agree | CONFIRMED |
| **"Routing strategies" decide which operator receives a chat** | `live_chat_routing_service.py` module docstring (three strategies), `Bot.live_chat_routing_strategy` column | `select_operator` (`live_chat_routing_service.py:85`) has **no caller in `api/`** — only its own unit tests. `request_handoff` (`live_chat_service.py:885`) broadcasts to the whole eligible pool; the first accept wins. Corroborated by `app/src/features/agents/advanced/behaviour.config.ts:472-491`. | **NOT SUPPORTED — do not use.** A module docstring is not a shipped behaviour. Say "the team is notified and whoever's free claims it," never "routed." |
| Lead capture with email verification, company lookup, journey enrichment | root `CLAUDE.md` `LeadInfo` model; `docs/oyechats-technical-story.md` Part 8 | Model + doc agree | CONFIRMED |
| IP-based company/organization lookup is "metered and currently held behind a flag" | `docs/oyechats-technical-story.md` Part 8.2 | Superseded by code: `ip_intel_service.py` calls the lookup for every visitor ("Always-on, best-effort signal"); *display* is plan-gated via `VISITOR_INTELLIGENCE_SLUGS` (`plan_entitlements_service.py:531`), not flag-gated | CONFIRMED as live on paid tiers, but **still do not market as always-on**: the code's own measured production result was 0 usable company names in 10 lookups before filtering, because most visitors browse from an ISP. It is an occasional bonus signal. |
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
| Dashboard IA = Home, Chatbots, Support, Leads, Journey, Analytics, Workspace, Settings (+ Launch Studio) | `docs/oyechats-technical-story.md` Part 2 | Narrative doc | **SUPERSEDED — see Conflict Log** |
| Dashboard IA = Home, AI Agents, Inbox, Leads, Analytics, Workspace (no separate Journey/Settings nav) | `app/CLAUDE.md` "Information architecture — the ONLY sidebar" | Direct quote from the active build mandate governing `app/` | **FORWARD INTENT, not shipped state — see Conflict Log** |
| **Dashboard IA (shipped) = Home · Inbox · Leads · Journey · Analytics · Chatbots, with Billing and Settings in the rail footer** | `app/src/shell/nav.ts:74-110` | Direct source inspection of `WORKSPACE_NAV` / `AGENT_NAV` / `FOOTER_NAV` — the single definition the rail, breadcrumbs and command palette all read | **CONFIRMED — this is the row to cite** |
| Admin dashboard is a real, actively-developed interface (not a mockup) | `app/src/shell/OyeChatsMark.tsx` | Direct source inspection — functioning theme-aware logo component | CONFIRMED (existence of a real app); does not resolve which IA version is currently shipped |

### Conflict Log — Dashboard Information Architecture

**Nature of conflict:** `docs/oyechats-technical-story.md` (tier 2, product documentation) and `app/CLAUDE.md` (the active build mandate for the same surface) described two different navigation structures for the same admin dashboard, and this package previously declined to pick between them.

**Resolution — closed by going to the source both documents describe.** Neither was right. `app/src/shell/nav.ts` holds the one definition the rail, the breadcrumb trail and the command palette all read, and it ships:

```
Home · Inbox · Leads · Journey · Analytics · Chatbots        (rail)
Billing · Settings                                            (rail footer)
```

A chatbot's own tabs (`AGENT_NAV`, same file) are **Overview · Knowledge · Experience · Deploy · Qualification · Quotation · Behaviour** — the file's comment records that *"Deploy replaces Channels"* and *"Behaviour replaces Advanced"*, and that Qualification was promoted out of Advanced *"because it is a revenue surface and not a technical one."*

Three specific corrections fall out of this, each of which an earlier version of this package would have got wrong:
1. **Journey is a top-level route (`/journey`)**, not a tab inside Analytics. `nav.ts` says so explicitly: *"it moved back out to its own top-level route."*
2. **The customer-facing noun is "Chatbots," not "AI Agents."** The string "AI Agent" appears once in the whole of `app/src`, in a context filename. The mandate's rename did not land in the UI.
3. **Settings is a real, separate footer item**, not folded into Workspace — and there is no rail item called "Workspace" at all.

**Practical instruction:** cite `app/src/shell/nav.ts` for any nav label, not either narrative document and not the mandate. Prefer generic framing (a leads list, a conversation view) where a label is not load-bearing. **Status: CONFIRMED against code.**

---

## Terminology Standardization Map

| Legacy/internal term | Current customer-facing term | Evidence | Status |
|---|---|---|---|
| Bot | **Chatbot** | The shipped rail says "Chatbots" and every agent tab hint says "this chatbot" (`app/src/shell/nav.ts:80,98-104`). The DB table/model is still literally `Bot` internally. **"AI Agent" is not the shipped customer-facing term** — the string appears once in all of `app/src`, in a context filename; the mandate's rename was reverted in the UI. | CONFIRMED against code — use **Chatbot**, not "AI Agent" |
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

1. ~~**Dashboard IA**~~ — **closed** against `app/src/shell/nav.ts:74-110`. Neither documented IA is what ships. *(See Conflict Log above.)*
2. **Terminology rollout** — partially closed. "Bot → **Chatbot**" is confirmed shipped (and "AI Agent" is confirmed *not* shipped). "Session → Conversation" remains the intended direction but was not re-audited surface-by-surface in this pass — still **NEEDS VERIFICATION**.
3. **Qualification chip default-off behavior** — confirmed via the narrative documentation (`docs/oyechats-technical-story.md`) but not independently re-verified against the raw `qualification_service.py` source in this pass (subsequently closed with direct code confirmation in `features/OYECHATS_FEATURE_QUALIFICATION.md`).
