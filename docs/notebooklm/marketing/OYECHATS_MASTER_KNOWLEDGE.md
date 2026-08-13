# OyeChats — Master Product Knowledge

*Primary NotebookLM source document. Business-language product truth, evidence-tagged. See `OYECHATS_SOURCE_OF_TRUTH.md` for the full claim-by-claim citation matrix this document draws from.*

**Evidence tiers used throughout:**
- **[T1 — Implemented]** — confirmed directly in application source code, database models, or live-rendered assets.
- **[T2 — Documented]** — confirmed in current, code-derived product documentation (`docs/oyechats-technical-story.md`, root `CLAUDE.md`).
- **[T3 — Positioned]** — confirmed in the approved marketing narrative (`docs/oyechats-marketing-story.md`), a framing/emphasis choice rather than a raw capability claim.
- **[VERIFY]** — plausible but not confirmed by inspected sources; needs a human check before use.
- **[MARKETING CLAIM — VERIFY IMPLEMENTATION]** — appears in marketing material, implementation not directly confirmed here.
- **[PRODUCT CAPABILITY — NOT CURRENTLY POSITIONED]** — real, code-confirmed, but absent from the approved marketing story; not core buyer-facing material.

---

## 1. Executive Definition

**What is OyeChats?** A SaaS platform that lets a business install a knowledgeable AI chatbot on its own website, without writing code, by pointing the platform at the business's own website and documents. **[T1/T2 — root `CLAUDE.md`: "OyeChats is a SaaS chatbot platform where customers sign up, create chatbot instances, upload their knowledge base, and embed an AI chatbot on their website with a single script tag."]**

**What does it do?** It reads a business's website and uploaded documents, turns that content into a searchable private knowledge base, answers visitor questions from that knowledge base only (not the open internet, not invented content), scores how sales-ready each visitor is, and — when a visitor is ready for a human — hands the conversation to a real team member live, with routing, queueing, and multi-device notification. **[T2 — `docs/oyechats-technical-story.md`, Part 0, Part 5, Part 6, Part 7, Part 9]**

**Who is it for?** Businesses that have a website and want it to actively qualify and convert visitors rather than sit static — the buying account is the business (a "Customer"/"Account" that owns bots, knowledge, leads, and billing); the accounts's team members act as "Operators" answering live chats; and the business's own website visitors are the ones conversing with the AI. **[T1/T2 — `docs/oyechats-technical-story.md`, Part 1; root `CLAUDE.md` DB schema — `Client`, `Operator`, `ChatSession` models]**

**What fundamental problem does it solve?** A business website is passive — it presents information but does nothing when a visitor has a question, and it captures almost nothing about who visited or how close they were to buying. OyeChats makes the website an active participant: it answers on the business's behalf from the business's own real content, and it turns every conversation into qualified, enriched sales data. **[T2/T3 — synthesized from `docs/oyechats-technical-story.md` Parts 0, 6, 7, 8 and `docs/oyechats-marketing-story.md` Part 16]**

---

## 2. Core Product Proposition

**Product truth (what is actually built):** A knowledge-grounded conversational AI (retrieval-augmented generation over the business's own crawled/uploaded content) + a rule-based/LLM-scored sales-qualification layer (BANT/MEDDIC/CHAMP/GPCTBA+C&I) + a live human-handoff contact-center system + a credit-metered billing system + an analytics layer, all reachable through one embeddable widget and one admin dashboard. **[T1/T2 — root `CLAUDE.md` "How It Works (End-to-End)" and "Database Schema"; `docs/oyechats-technical-story.md` Parts 5–10]**

**Customer value (what the business actually gets):** Fewer unanswered visitor questions, an automatic first-pass read on which visitors are worth a salesperson's time, and a record of every conversation enriched with company, location, and journey data — without hiring anyone or writing an FAQ by hand. **[T2/T3 — `docs/oyechats-technical-story.md` Parts 7–8; `docs/oyechats-marketing-story.md` Parts 7–8]**

**Marketing positioning (the chosen framing, not a separate capability):** "You only talk to buyers" — the AI does the qualifying work invisibly, so a human's time is spent only on visitors worth talking to. This is a *framing* of the qualification-and-handoff mechanism above, not an additional feature. **[T3 — live site meta title/description, sourced from `oyechats-website/src/app/layout.tsx`]**

---

## 3. The Problem

**The actual business problem documented:** A business's website content — pages, PDFs, brochures — sits unused by anyone actively asking it questions. A visitor with a question either digs through the site themselves, gives up, or emails/calls and waits. Nothing on a typical static site scores or remembers who a visitor was, what they asked, or how close they were to buying. **[T2 — inferred directly from what OyeChats is built to replace, per `docs/oyechats-technical-story.md` Part 0 and Part 5's entire premise of "turning a website into memory"]**

**What happens to visitors without OyeChats:** They read pages linearly, may not find the specific answer they need, and if they don't convert on the spot there is typically no record that they were ever there, what they were interested in, or that they should be followed up with. **[VERIFY — this is a reasonable inference about the "before" state, not a claim OyeChats' own source material states explicitly about competitors or the pre-OyeChats world; do not present as a researched market claim, only as a logical narrative setup]**

Do not exaggerate this into "businesses are losing X% of visitors" or any invented statistic — no such figure exists in any inspected source. **[Explicit constraint — no source supports a quantified loss/conversion-rate claim]**

---

## 4. The OyeChats Solution

The full path, evidenced stage by stage:

**Business →** signs up, points the platform at its website URL during a guided onboarding ("Launch Studio"). **[T2 — `docs/oyechats-technical-story.md` Part 4.2]**

**→ Website** is discovered (sitemap/robots read, page count + cost estimate shown for consent), fetched via a managed crawl provider with an automatic fallback provider, and ingested concurrently as pages arrive — cleaned, deduplicated, quota-checked, chunked, optionally context-enriched, embedded into a meaning-vector plus a keyword index, with dated events and footer media (videos, brochures) separately harvested. **[T1/T2 — root `CLAUDE.md` RAG Pipeline diagram: extraction → cleaning → chunking → embedding → storage, `api/app/ingestion/`; `docs/oyechats-technical-story.md` Part 5, all subsections]**

**→ Visitor** lands on the business's site, sees an embedded chat launcher (customizable per bot — an animated "orb," a generic bot-icon "mascot," or the business's own uploaded logo image), and the visitor's page-view trail begins recording immediately, before they ever open the chat. **[T1 — `widget/src/components/Launcher.jsx` `renderBotIcon()`, avatar types `orb`/`mascot`/`upload`; `docs/oyechats-technical-story.md` Part 6.1 journey tracking]**

**→ Conversation** — the visitor asks a question; the platform authenticates the bot, checks the domain allowlist, rate-limits, saves the message immediately, deducts a credit under a lock, and routes through fast deterministic paths (name capture, greetings, safety screening, cache) before doing real retrieval. **[T2 — `docs/oyechats-technical-story.md` Part 6.2–6.3]**

**→ AI assistance** — the query is rewritten for context, searched by both meaning-similarity and keyword match, fused, and gated by a relevance check: if nothing relevant was actually found, the bot says so honestly rather than generating an unsupported answer. A layered prompt (identity, scope, brand voice, style, retrieved passages, date context, media whitelist, history, qualification instructions) drives a streamed, sanitized answer with a fallback model on standby. **[T1/T2 — root `CLAUDE.md` "RAG Pipeline" including `RELEVANCE_GATE_ENABLED`, `RERANK_ENABLED` flags and LiteLLM primary/fallback model routing; `docs/oyechats-technical-story.md` Part 6.4–6.8]**

**→ Opportunity** — in the background, every conversation is scored against the business's chosen sales-qualification framework (BANT, MEDDIC, CHAMP, or GPCTBA+C&I), producing a tier (unqualified/MQL/SAL/SQL); a tier upgrade fires an email, an in-app notification, and an outbound webhook. **[T1/T2 — root `CLAUDE.md` `BANTSignal` model, `qualification_service.py`; `docs/oyechats-technical-story.md` Part 7]**

**→ Human interaction** — if the visitor asks for a person (or the bot's own answer implies one is needed), the conversation moves through an audited state machine (`bot → waiting → live/closed`), an available operator is selected by a configurable routing strategy, and every device that operator owns is notified simultaneously. **[T1/T2 — root `CLAUDE.md` `Operator`, `Department`, `ChatAuditLog` models, `live_chat_service.py`; `docs/oyechats-technical-story.md` Part 9]**

**→ Lead/business outcome** — the conversation becomes an enriched lead record (contact info, optionally verified; company identified from the email domain; location, device, journey, qualification breakdown attached), visible, exportable, and follow-up-able in the dashboard. **[T1/T2 — root `CLAUDE.md` `LeadInfo` model; `docs/oyechats-technical-story.md` Part 8]**

---

## 5. Target Customers

Only audiences directly evidenced in the source material — no invented personas:

- **The buying account / primary buyer** — "The Customer (also called the Owner or the Workspace)": the business that signs up, owns bots, knowledge, leads, billing, team members. **[T2 — `docs/oyechats-technical-story.md` Part 1]**
- **Operational users on the business's team** — "The Operator": a human support/sales agent inside the workspace, invited or the owner themself, working the live-chat inbox and leads, with their own permission scope (cannot reach billing). **[T1/T2 — root `CLAUDE.md` `Operator` model with `role: owner|admin|operator`; `docs/oyechats-technical-story.md` Part 1]**
- **Website visitors** — anonymous people browsing the business's website who interact with the chatbot; they never create an account. **[T2 — `docs/oyechats-technical-story.md` Part 1]**
- **Affiliates** — people who refer new customers via a tracked referral code; a secondary audience with their own portal. **[T2 — `docs/oyechats-technical-story.md` Part 1, Part 10.13]**

Decision-maker framing for marketing purposes (CEO/CMO/business owner evaluating the purchase) is a **[T3 — Positioned]** choice made in `docs/oyechats-marketing-story.md`, consistent with "The Customer" being the actual buyer role in the product itself — not a separate invented persona.

---

## 6. Core Capabilities

Each capability: what it does, why it matters, who benefits, how it appears in-product, evidence, and marketing-positioning status.

### 6.1 Website-to-Knowledge Ingestion (Training)
- **What:** Discovers, fetches, cleans, deduplicates, chunks, and embeds a business's website and uploaded documents into a private, bot-scoped knowledge base; also extracts the company's name, description, brand tone, and brand colors during the same pass.
- **Why it matters:** Removes the need to hand-write an FAQ or manually configure the bot's knowledge.
- **Who benefits:** The business (setup speed), indirectly the visitor (accurate answers).
- **How it appears:** Launch Studio Step 3 "Setup and Train"; recurring "auto-recrawl" toggle on paid plans; manual re-check with a before/after diff.
- **Evidence:** **[T1/T2]** root `CLAUDE.md` RAG Pipeline + `api/app/ingestion/pipeline.py`, `embedder.py`; `docs/oyechats-technical-story.md` Part 5.
- **Marketing status:** **[T3 — Positioned]**, core narrative beat in both story docs.

### 6.2 Grounded Conversational Answers (No Hallucination by Design)
- **What:** Hybrid (meaning + keyword) retrieval, a relevance gate that refuses to answer from irrelevant material, and a background groundedness auditor that rates whether generated claims were actually supported.
- **Why it matters:** Prevents the AI from inventing plausible-sounding wrong answers — the single most reputational risk of a customer-facing AI.
- **Who benefits:** Both the business (brand trust) and the visitor (accurate help).
- **How it appears:** A "pivot" response ("I don't have that specific information...") instead of a guess when nothing relevant is found.
- **Evidence:** **[T1/T2]** root `CLAUDE.md` `RELEVANCE_GATE_ENABLED`, `RERANK_ENABLED`, `rag_service.py`; `docs/oyechats-technical-story.md` Part 6.5–6.6, Part 16.
- **Marketing status:** **[T3 — Positioned]**, core trust message in `docs/oyechats-marketing-story.md` Part 6.

### 6.3 Sales Qualification (BANT / MEDDIC / CHAMP / GPCTBA+C&I)
- **What:** Every conversation is scored, dimension by dimension, against a chosen sales framework — by default via silent background inference from the conversation, optionally via interactive chips (off by default).
- **Why it matters:** Surfaces which visitors are actually worth a salesperson's time, without interrogating the visitor.
- **Who benefits:** The business's sales team.
- **How it appears:** Qualification tier badge on a lead/conversation; tier-change notifications (email, in-app, webhook).
- **Evidence:** **[T1/T2]** root `CLAUDE.md` `BANTSignal` model, `Bot.qualification_framework`; `docs/oyechats-technical-story.md` Part 7.
- **Marketing status:** **[T3 — Positioned]**, central to the "you only talk to buyers" positioning.
- **Caveat:** **[T2]** the interactive-chip mode ships **off by default on every framework** — do not claim visitors are directly interrogated by the bot; the default experience is silent scoring. `docs/oyechats-technical-story.md` Part 7.1.

### 6.4 Live Human Handoff
- **What:** An audited four-state conversation machine (`bot`/`waiting`/`live`/`closed`), configurable routing (least-busy/round-robin/first-available), a durable queue, and multi-channel operator notification (dashboard, browser push, mobile push, email) with cross-device claim deduplication.
- **Why it matters:** Catches visitors at the exact moment they're ready for a person, without losing them to an unanswered request.
- **Who benefits:** The business's operators and the visitor.
- **How it appears:** "Talk to a human" request in the widget; operator inbox with full prior bot transcript, visitor context, canned responses, file sending, transfer, close.
- **Evidence:** **[T1/T2]** root `CLAUDE.md` `Operator`, `Department`, `ChatAuditLog` models, `live_chat_service.py`, `ws_routes.py`; `docs/oyechats-technical-story.md` Part 9.
- **Marketing status:** **[T3 — Positioned]**, `docs/oyechats-marketing-story.md` Part 9.

### 6.5 Lead Capture & Enrichment
- **What:** Contact capture (pre-chat/mid-chat form, or bot-asked), optional real-time email verification, company identification from the email domain, location/device resolution, journey trail, qualification breakdown — all attached automatically to the lead record.
- **Why it matters:** Turns a conversation into an actionable, contextualized sales record without manual data entry.
- **Who benefits:** The business's sales/marketing team.
- **How it appears:** Filterable/sortable Leads list with full transcript and enrichment, export, follow-up email.
- **Evidence:** **[T1/T2]** root `CLAUDE.md` `LeadInfo` model; `docs/oyechats-technical-story.md` Part 8.
- **Marketing status:** **[T3 — Positioned]**.
- **Caveat:** **[T2]** IP-based company/organization identification (the second enrichment path, beyond email-domain lookup) is explicitly described as "metered and currently held behind a flag" — treat as **[PRODUCT CAPABILITY — NOT CURRENTLY POSITIONED / NOT FULLY LIVE]**, do not present as a guaranteed always-on feature. `docs/oyechats-technical-story.md` Part 8.2.

### 6.6 Journey Analytics
- **What:** Page-view trail captured before, during, and after a chat (whether or not the visitor ever chats), feeding a dedicated Journey analytics view — which pages precede a conversion, where visitors go after a chat ends.
- **Why it matters:** Extends visibility beyond the chat itself into the whole visit.
- **Who benefits:** Marketing/business analysts.
- **How it appears:** The "Journey" analytics view, one of eight analytics surfaces.
- **Evidence:** **[T1/T2]** `docs/oyechats-technical-story.md` Part 6.1, Part 14.
- **Marketing status:** **[T3 — Positioned]** — described in `docs/oyechats-technical-story.md` as "the most distinctive view."

### 6.7 Credit-Based Billing, Real Invoicing, Reversible Lapse
- **What:** An append-only, event-sourced credit ledger; automated tax-compliant invoicing; a lapse mechanic that deactivates (not deletes) knowledge on non-payment/cancellation, fully restorable on reactivation.
- **Why it matters:** Predictable costs for the buyer; low-risk churn (nothing is lost) which supports win-back.
- **Who benefits:** The business (predictability, trust); OyeChats (reversible churn instead of hard loss).
- **How it appears:** Billing/Usage dashboard pages, invoice downloads, plan/credit displays.
- **Evidence:** **[T1/T2]** root `CLAUDE.md` `CreditLedger`, `Invoice`, `Subscription` models; `docs/oyechats-technical-story.md` Part 10, Part 11.
- **Marketing status:** **[T3 — Positioned]**, `docs/oyechats-marketing-story.md` Parts 10–11.
- **Note:** **[T2]** Razorpay/INR is the sole live payment rail; USD/multi-currency pricing is defined in data but staged behind a flag, not live. Root `CLAUDE.md`: "Payments | Razorpay (INR) — single provider." Do not depict or claim USD billing as live.

### 6.8 Platform-Agnostic Install
- **What:** A single-line embeddable script (IIFE bundle) that works on any website with a body tag — plain HTML, React/Next.js, WordPress, Shopify, Webflow, Squarespace, etc. — with platform-specific install guidance in the dashboard.
- **Why it matters:** Removes technical/developer dependency for install.
- **Who benefits:** Any business regardless of their site's tech stack.
- **How it appears:** Launch Studio "Deploy" step; a platform-icon picker (`app/src/design-system/icons/platforms.tsx`) covering HTML, Next.js, React, Vue, Angular, Shopify, Squarespace, Svelte, Webflow, Wix, WordPress, Framer, Bubble, Astro, GTM.
- **Evidence:** **[T1/T2]** root `CLAUDE.md` "Widget Embedding — How It Works"; `app/src/design-system/icons/platformLogos.ts` (confirmed platform list); `docs/oyechats-technical-story.md` Part 2.
- **Marketing status:** **[T3 — Positioned]**.

### 6.9 Internal-Only Capabilities (Not Customer-Facing Marketing Material)
Real, code-confirmed, but not part of the customer-facing story — useful for context, not buyer-facing material:
- Super-admin **Control Tower**: cross-tenant visibility, pricing/model configuration at runtime, impersonation, webhook replay, reconciliation. **[T2 — `docs/oyechats-technical-story.md` Part 15]** — **[PRODUCT CAPABILITY — NOT CURRENTLY POSITIONED]**; it is an OyeChats-operations feature, not something the buying business uses.
- Optional contextual chunk enrichment and cross-encoder reranking — both off by default, internal quality levers. **[T2 — Part 5.8, Part 6.6]** — **[PRODUCT CAPABILITY — NOT CURRENTLY POSITIONED]**.
- Affiliate program — real and documented, but a distinct audience/story from the core buyer story. **[T2 — Part 10.13]** — see the dedicated feature document.

---

## 7. Customer Journey

In plain, business-language terms:

1. A business signs up (email or one-click social sign-in), lands on a free plan with starting credits, no card required.
2. They're guided through a seven-step setup: pick a plan → name their AI Agent → point it at their website (the platform reads everything and learns the brand's voice and colors) → test the agent with pre-verified sample questions → customize the widget's look → deploy one line of code → the platform confirms it's live.
3. From that moment, every visitor to the business's site can talk to the AI Agent, and the business's dashboard starts filling with conversations, qualified leads, and analytics.
4. The business's team works from a Support/Inbox surface when a visitor asks for a human, closes deals from enriched lead records, and manages billing/knowledge from Workspace/Settings.

**[T2 — synthesized from `docs/oyechats-technical-story.md` Part 4.1–4.2]**

---

## 8. Visitor Journey

Only flows directly supported by inspected source:

- **Discovering the chat** — a launcher bubble appears in the corner of the business's site; after a delay, a greeting bubble can appear proactively. **[T1 — `widget/src/components/Launcher.jsx` greeting-bubble timer logic]**
- **Asking questions** — free-text chat; on the very first message, if the bot doesn't know the visitor's name, it asks and defers the real question to the next turn (visitor can decline). **[T2 — Part 6.3]**
- **Receiving answers** — streamed, sourced from the business's own content; an honest "I don't know" pivot if nothing relevant was found, never an invented answer. **[T2 — Part 6.6]**
- **Continuing conversations** — pronoun/ellipsis-aware query rewriting keeps multi-turn context coherent. **[T2 — Part 6.4]**
- **Expressing interest** — the visitor's answers are silently scored against the business's qualification framework in the background; interactive question chips exist but are off by default. **[T2 — Part 7]**
- **Requesting human help** — explicit ask, a "connect" button tap, or the bot's own answer implying a human is needed; a proactive operator can also offer to join a promising conversation. **[T2 — Part 9.2]**
- **Becoming a lead** — via a pre-chat/mid-chat form or the bot naturally asking for contact details. **[T2 — Part 8.1]**

---

## 9. Business Outcomes

**Direct product outcomes (what the system is built to produce):**
- Answered visitor questions grounded in the business's real content.
- A qualification tier attached to every conversation.
- An enriched lead record for every conversation that captures contact details.
- A live handoff path so a ready-to-buy visitor reaches a human quickly.
**[T2 — Parts 6–9]**

**Intended business outcomes (the purpose these mechanisms serve, per the product's own design):**
- Sales teams spend time on visitors worth talking to, not on manually triaging every inbound message. **[T2/T3 — Part 7 intro + `docs/oyechats-marketing-story.md` Part 7]**
- A business's website becomes a source of ongoing pipeline data (leads, journey, qualification) rather than a static brochure. **[T2/T3 — Part 8, Part 14]**

**Marketing claims (framing, not measured results):**
- "You only talk to buyers" (tagline) is a positioning statement about the *intent* of the qualification system, not a measured outcome metric. **[T3 — Positioned]**

**Do not invent:** no conversion-rate lift, no ROI percentage, no case-study numbers, no customer count, no revenue figure appears in any inspected source. Any such number in future material must be sourced and cited, or explicitly marked illustrative/placeholder.

---

## 10. Human + AI Relationship

OyeChats does **not** position the AI as a replacement for the business's team — the product's own architecture is built around a deliberate, structured handoff *to* humans, not around eliminating them:

- The AI's qualification work exists specifically to make human time more valuable, not to remove humans from the loop — "the market leaders default [interactive interrogation] off too... background extraction still tiers the lead perfectly well" is framed around *protecting the visitor experience*, and the entire live-handoff system (Part 9) exists precisely because human conversations still matter. **[T2 — Part 7.1, Part 9 entire]**
- The reverse flow — an operator proactively joining a promising AI conversation — explicitly frames the human as the one who "pounces on a hot lead," i.e., the human closes, the AI qualifies. **[T2 — Part 9.2]**
- When an operator picks up a handoff, they inherit full context (transcript, journey, qualification) specifically so the human isn't starting cold — this is a "hand the human a warm lead," not a "replace the human," design. **[T2 — Part 9.7]**

**Framing rule for future marketing material:** describe the AI as a **tireless first responder and qualifier** that clears the way for the business's own people — never as a replacement for the sales/support team. This is directly supported by the product's own architecture, not merely a marketing preference.

---

## 11. Product Surface

### 11.1 The Widget (visitor-facing)
- **Purpose:** The chat experience visitors interact with, embedded on the business's own site.
- **Primary user:** Anonymous website visitors.
- **Important elements:** Customizable launcher (orb / mascot / uploaded logo), colors matched to the business's brand, welcome message, business-hours-aware offline state, streamed chat, interactive cards (media, meeting booking, leave-a-message).
- **Evidence:** **[T1]** `widget/src/components/Launcher.jsx`, `ChatWidget.jsx`, `ChatWindow.jsx`; **[T2]** Part 6.
- **Relevance:** High — this is the primary visitor-facing surface of the product.

### 11.2 The Admin Dashboard (business-facing)
- **Purpose:** Where the business manages agents, knowledge, conversations, leads, and billing.
- **Primary user:** The Customer/Owner and their Operators (scoped access).
- **⚠️ IA conflict flagged — see `OYECHATS_SOURCE_OF_TRUTH.md` for detail:** `docs/oyechats-technical-story.md` Part 2 describes navigation as *Home, Chatbots, Support, Leads, Journey, Analytics, Workspace, Settings*. The current build mandate in `app/CLAUDE.md` specifies a different, newer information architecture: *Home, AI Agents, Inbox, Leads, Analytics, Workspace* (Journey folded into an agent's Analytics tab; Settings folded into Workspace). **[VERIFY — which IA is actually live in the shipped product should be confirmed before citing specific nav labels as current fact.]**
- **Confirmed-live detail regardless of IA version:** the sidebar brand mark is rendered by `app/src/shell/OyeChatsMark.tsx`, theme-aware (light/dark logo swap), confirming the dashboard is an actively developed, real interface, not a mockup. **[T1]**
- **Relevance:** Medium-high — covers agent setup, leads list, live inbox; exact on-screen labels should be verified against the shipped build before being cited as current.

### 11.3 The Marketing/Website Surface
- **Purpose:** Public storefront — pricing, features, sign-up.
- **Primary user:** Prospective buyers before signup.
- **Evidence:** **[T2]** Part 2 — "reads live pricing from the platform so the published price and the price actually charged can never drift apart."
- **Relevance:** Low for product-depth material (this is what the product documentation supports, not depicts).

### 11.4 The Control Tower (internal, super-admin only)
- **Purpose:** Platform operations — not a customer-visible surface.
- **Primary user:** The OyeChats team.
- **Relevance:** None — **[PRODUCT CAPABILITY — NOT CURRENTLY POSITIONED]** for buyer-facing material.
