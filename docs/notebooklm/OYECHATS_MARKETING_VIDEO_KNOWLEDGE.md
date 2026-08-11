# OyeChats — Marketing Video Knowledge

*Translates `OYECHATS_MASTER_KNOWLEDGE.md` and `OYECHATS_MARKETING_STORY.md` into knowledge specifically shaped for generating a 1–2 minute cinematic marketing film. This document does not contain the video prompt itself — it defines what the video is allowed and required to communicate.*

---

## Video Objective

By the end of the video, the viewer must understand: **a business can put a real, trustworthy AI on its own website that answers from the business's own content, quietly figures out which visitors are worth talking to, and hands the good ones to a real person — all set up in about ten minutes without code.**

---

## Target Viewer

A non-technical business decision-maker evaluating OyeChats as a purchase: CEO, CMO, founder, head of sales/marketing, or another buyer-side evaluator. Not a developer, not an existing OyeChats customer being onboarded — a prospective buyer forming a first impression. **[Consistent with `docs/oyechats-marketing-story.md` stated audience]**

---

## Viewer Knowledge Level

Assume zero familiarity with RAG, embeddings, vector search, LLMs, chunking, or any implementation term. The viewer knows what a chatbot is in the consumer sense (like a support widget they've seen on other sites) and what "leads" and "sales pipeline" mean in a business sense. Every idea must be expressible without a single engineering term.

---

## Single Most Important Idea

**"Your website can finally talk back — accurately, on-brand, and only to the visitors worth your team's time."**

---

## 90–120 Second Narrative

A concise story arc, built only from evidenced content:

**1. Problem (≈10–15s).** A business's website sits there. A visitor has a question. Nothing answers. Nothing is remembered.

**2. Discovery (≈10–15s).** The business points OyeChats at its own website. In minutes, it has read everything — and learned how the business talks and looks, not just what it sells. **[T2 — Part 4.2 Step 3]**

**3. The OyeChats experience (≈25–35s).** A visitor arrives, asks a real question, gets a real answer — instantly, in the business's voice, sourced from the business's own content. Underneath, the conversation is quietly being scored for how ready this visitor is to buy — no interrogation, just a silent read. **[T2 — Part 6, Part 7]**

**4. Business value (≈15–20s).** The business's dashboard shows the payoff: a qualified lead, enriched, ready to act on — not a lost browser tab. **[T2 — Part 8]**

**5. Human connection (≈15–20s).** The moment a visitor is ready for a person, a real team member steps in — already holding the full context, no cold start. The AI didn't replace anyone; it made sure the right conversation reached the right person at the right time. **[T2 — Part 9.7; see `OYECHATS_MASTER_KNOWLEDGE.md` Section 10 — human-AI framing is non-negotiable]**

**6. Transformation (≈10–15s).** The website that used to just sit there is now working — continuously, quietly, for the business.

**7. Brand ending (≈5–10s).** Logo, tagline: **"OyeChats. You only talk to buyers."**

---

## Essential Product Moments

The five to seven moments that most efficiently communicate what OyeChats actually is:

1. **A website being "read"** — pages, a PDF/brochure, turning into something the AI now knows. Visualizes Section 6.1 (ingestion/training).
2. **A visitor typing a real question, getting a real, sourced answer, streamed live.** Visualizes Section 6.2 (grounded answers).
3. **A quiet, non-intrusive qualification signal** — a tier or score appearing, without the visitor being visibly interrogated. Visualizes Section 6.3, respecting the "chips off by default" constraint.
4. **A lead record forming** — contact + context assembling itself. Visualizes Section 6.5.
5. **A handoff moment** — notification reaching a real person, who picks up with full context already in hand. Visualizes Section 6.4.
6. **One line of code going live** — the install moment. Visualizes Section 6.8 and the "ten minutes, no code" promise.
7. **The brand mark and tagline as a closing beat.**

---

## Product UI Moments

Real interfaces that may appear, per confirmed evidence:

- The **chat widget/launcher** on a business website — confirmed live, customizable (orb / mascot / uploaded logo). **[T1 — `widget/src/components/Launcher.jsx`]**
- A **streamed chat answer** appearing in the widget window.
- A **lead record / leads list** in the dashboard, showing enrichment.
- A **live-chat handoff notification** reaching an operator.

**Caution:** exact dashboard navigation labels are unresolved between two sources (see `OYECHATS_SOURCE_OF_TRUTH.md` — IA conflict). Prefer generic, label-light UI framing (a leads list, a conversation view, a notification) over rendering specific nav-bar text that might not match the shipped build at production time.

---

## Business Value Moments

Outcomes to visualize, all evidenced, none numeric:

- A conversation becoming a structured lead (not a raw chat log).
- A qualification tier/badge appearing on a lead.
- A "still there" moment after a lapse — knowledge paused, not gone (optional, if the video has room for a trust beat).

Do **not** visualize: a growth chart, a revenue number, a percentage uplift, a testimonial quote, a customer logo wall — none of these are sourced.

---

## Human Moments

Where real people should appear, and why:

- **The business owner/team member** during setup — pointing the platform at their site, reviewing the widget preview. Represents the ease of setup.
- **The operator/team member** receiving and picking up a live handoff — this is the single most important human moment in the video, because it is the direct evidence that OyeChats augments people rather than replacing them. **[T2 — Part 9.7; mandatory per `OYECHATS_MASTER_KNOWLEDGE.md` Section 10]**
- The **visitor** is present throughout as the other side of the conversation but does not need a distinct "hero" human moment — their presence is implied by the chat itself.

---

## What NOT To Explain

Technical/product detail that must not consume runtime in a 1–2 minute film:

- Vector embeddings, chunking, hybrid search, reranking, relevance-gate mechanics.
- The credit ledger, plan tiers, pricing specifics, tax/invoice mechanics.
- The qualification framework names (BANT/MEDDIC/etc.) or scoring math.
- The conversation state machine, routing strategies, or queue mechanics.
- Any internal-only Control Tower / super-admin functionality (Section 6.9 of Master Knowledge — explicitly not customer-facing material).
- Webhooks, integrations, or developer-facing configuration.

These are all real and correctly documented elsewhere (`OYECHATS_MASTER_KNOWLEDGE.md`), but none of them are what a non-technical buyer needs in two minutes.

---

## What Must Be Understood

The irreducible minimum the viewer must leave with:

1. OyeChats reads a business's own website/content and answers from it — truthfully, not by guessing.
2. It figures out which visitors are worth a human's attention, quietly.
3. A real person from the business still closes the conversation when it matters — the AI does not replace the team.
4. Setup is fast and does not require a developer.
5. The brand: OyeChats. "You only talk to buyers."
