# OyeChats — NotebookLM Quick Context

*Maximum-density executive overview. Depth and evidence citations live in the other documents in this folder — this one is a fast-load summary, not a replacement for them. Every line here is traceable to `OYECHATS_SOURCE_OF_TRUTH.md`.*

---

**What OyeChats is:** A SaaS platform that lets a business install a knowledgeable AI chatbot on its own website in about ten minutes, without code — the AI is trained by reading the business's own website and documents, and answers visitors only from that content.

**Target audience:** Primary buyer = the business owner/decision-maker (CEO/CMO/founder). Also: the business's team members ("Operators," scoped access), and the business's own website visitors (who chat with the AI, never sign up).

**Core problem:** A website is passive — it presents content but doesn't answer a visitor's specific question, and it remembers nothing about who visited or how close they were to buying.

**Core solution:** The AI reads and memorizes the business's own content, answers visitor questions from it (refusing honestly rather than guessing when it doesn't know), silently scores how sales-ready each visitor is, and hands ready visitors to a real human on the team, live, with full context.

**Main capabilities (customer-facing):**
1. Website/document ingestion → private AI knowledge base ("Training").
2. Grounded, hallucination-resistant conversational answers.
3. Silent sales qualification (BANT/MEDDIC/CHAMP/GPCTBA+C&I) — interactive interrogation chips are **off by default**.
4. Live human handoff with a durable queue and multi-device operator alerts — the team is notified and whoever's free claims the chat (**there is no automatic routing; do not say "routed"**).
5. Enriched, exportable lead records (contact, company, journey, qualification).
6. Journey analytics (page trail before/during/after chat).
7. Credit-metered billing with real invoicing; lapsed subscriptions pause knowledge (never delete it).
8. One-line install on any website platform (HTML, WordPress, Shopify, Webflow, Next.js, etc.).

**Customer journey:** Sign up free (no card) → guided 7-step setup (name agent → point at website → AI reads & learns brand voice/colors → test with pre-verified sample questions → customize widget → deploy one line of code → confirmed live) → conversations, leads, and analytics start flowing into the dashboard.

**Business value:** Fewer unanswered visitors, automatic first-pass qualification so the team's time goes to the right people, near-zero setup effort, low-risk churn (lapse pauses, doesn't delete).

**Marketing positioning (approved tagline):** "OyeChats. You only talk to buyers."

**Human + AI relationship — critical framing rule:** The AI qualifies and first-responds; **a real person on the business's team still closes the conversation.** The product's own handoff architecture (operators receive full context, never start cold) makes this a structural fact, not just a marketing choice. Never position OyeChats as replacing a sales/support team.

**Brand personality:** Confident, plain-spoken, premium-but-warm, honest over impressive (the product itself is architected to refuse rather than bluff). No hype-adjective language.

**Critical do-not-say rules:**
- Do not claim the AI replaces the sales/support team.
- Do not cite any ROI/conversion-rate/revenue number — none exist in source material.
- Do not claim visitors are rapid-fire interrogated by qualification chips — the default experience is silent background scoring.
- Do not claim USD/multi-currency billing as live — Razorpay/INR is the sole live payment rail.
- Do not claim live chats are routed, load-balanced, or assigned to a chosen operator — assignment is broadcast-then-first-accept.
- Do not promise scheduled or emailed performance reports — none exist; the customer opens a dashboard with 7/30/90-day windows.
- Multilingual ships **English and Hindi only** in the dashboard; do not imply a long language list.
- Do not use generic AI-hype language or invented customer names/logos/testimonials.
- Dashboard nav labels are now settled against `app/src/shell/nav.ts`: **Home · Inbox · Leads · Journey · Analytics · Chatbots**, with Billing and Settings in the footer. The product noun is **"Chatbot," not "AI Agent."** Do not take labels from `app/CLAUDE.md` or `docs/oyechats-technical-story.md` — neither matches the build.

**Final approved message:**
> "OyeChats. You only talk to buyers."
> AI chatbot that qualifies every visitor before your sales reps ever see them — grounded answers, live handoff, and analytics, all from your own website.
