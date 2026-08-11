# OyeChats — NotebookLM Quick Context

*Maximum-density executive overview. Depth and evidence citations live in the other six documents in this folder — this one is a fast-load summary, not a replacement for them. Every line here is traceable to `OYECHATS_SOURCE_OF_TRUTH.md`.*

---

**What OyeChats is:** A SaaS platform that lets a business install a knowledgeable AI chatbot on its own website in about ten minutes, without code — the AI is trained by reading the business's own website and documents, and answers visitors only from that content.

**Target audience:** Primary buyer = the business owner/decision-maker (CEO/CMO/founder). Also: the business's team members ("Operators," scoped access), and the business's own website visitors (who chat with the AI, never sign up).

**Core problem:** A website is passive — it presents content but doesn't answer a visitor's specific question, and it remembers nothing about who visited or how close they were to buying.

**Core solution:** The AI reads and memorizes the business's own content, answers visitor questions from it (refusing honestly rather than guessing when it doesn't know), silently scores how sales-ready each visitor is, and hands ready visitors to a real human on the team, live, with full context.

**Main capabilities (customer-facing):**
1. Website/document ingestion → private AI knowledge base ("Training").
2. Grounded, hallucination-resistant conversational answers.
3. Silent sales qualification (BANT/MEDDIC/CHAMP/GPCTBA+C&I) — interactive interrogation chips are **off by default**.
4. Live human handoff with routing, queueing, multi-device operator alerts.
5. Enriched, exportable lead records (contact, company, journey, qualification).
6. Journey analytics (page trail before/during/after chat).
7. Credit-metered billing with real invoicing; lapsed subscriptions pause knowledge (never delete it).
8. One-line install on any website platform (HTML, WordPress, Shopify, Webflow, Next.js, etc.).

**Customer journey:** Sign up free (no card) → guided 7-step setup (name agent → point at website → AI reads & learns brand voice/colors → test with pre-verified sample questions → customize widget → deploy one line of code → confirmed live) → conversations, leads, and analytics start flowing into the dashboard.

**Business value:** Fewer unanswered visitors, automatic first-pass qualification so the team's time goes to the right people, near-zero setup effort, low-risk churn (lapse pauses, doesn't delete).

**Marketing positioning (approved tagline):** "OyeChats. You only talk to buyers."

**Human + AI relationship — critical framing rule:** The AI qualifies and first-responds; **a real person on the business's team still closes the conversation.** The product's own handoff architecture (operators receive full context, never start cold) makes this a structural fact, not just a marketing choice. Never position OyeChats as replacing a sales/support team.

**Brand personality:** Confident, plain-spoken, premium-but-warm, honest over impressive (the product itself is architected to refuse rather than bluff). No hype-adjective language.

**Visual identity — "Voltage Paper" theme:**
- Dominant field: warm paper/cream neutrals (`#FAFAF7`), near-black ink (`#0A0A0A`).
- Single accent color: Volt violet `#7C3AED` (never a background wash — a deliberate, restrained highlight only).
- Fonts: Geist (headings), Inter (body), Geist Mono (code), Fraunces italic (editorial accent only).
- Logo: one glyph, two forms, both confirmed live in production. The core mark is a rounded "C"-ring/speech-bubble glyph with three dots, single-color (near-black on light, white on dark). As a **standalone icon** — `logo-light.png` / `logo-dark.png` — it's confirmed rendering in the live Admin dashboard sidebar (`https://app.oyechats.com/logo-light.png`). As a **full wordmark** — `oyechats-wordmark.png` / `oyechats-wordmark-light.png` — the same glyph is embedded as the "C" of "chats" in "Oyechats," confirmed live on the marketing homepage (`https://www.oyechats.com/`). Use the icon alone for tight spaces, the full wordmark for hero/title placements. Two other logo concepts (indigo signal-arcs, an orange glyph) were found in the codebase and are confirmed dead/unused — do not use them. A third file, `oyechats-mark.png` (navy bubble), is stale — the local website repo checkout is a couple of commits behind production and still points at it, but production itself no longer serves it.

**Reference video style ("papercraft/origami diorama"):** Everything — UI, devices, speech bubbles, people — rendered as folded, embossed craft paper, shot macro-photography style with shallow depth of field and soft studio lighting. A warm gold glow marks "the important thing" in each shot. **Adaptation rule: re-key that glow to Volt violet (`#7C3AED`/`#A78BFA`) for OyeChats material — everything else about the papercraft medium should be kept.** An angular gold/silver origami robot represents the AI; soft paper-sculpture humans represent people — keep this material contrast, especially in any handoff scene.

**Critical do-not-do rules:**
- Do not depict the AI replacing the sales/support team.
- Do not cite any ROI/conversion-rate/revenue number — none exist in source material.
- Do not depict visitors being rapid-fire interrogated by qualification chips — the default experience is silent background scoring.
- Do not claim USD/multi-currency billing as live — Razorpay/INR is the sole live payment rail.
- Do not use generic AI-hype language, invented customer names/logos/testimonials, or literal AI clichés (glowing brains, circuit boards, floating binary).
- Do not use the stale/dead logo variants (navy bubble, indigo signal-arcs, orange glyph).
- Do not depict the exact dashboard nav labels without verification — two sources disagree on current information architecture (see `OYECHATS_SOURCE_OF_TRUTH.md`); prefer generic, label-light UI framing.

**Final approved message:**
> "OyeChats. You only talk to buyers."
> AI chatbot that qualifies every visitor before your sales reps ever see them — grounded answers, live handoff, and analytics, all from your own website.
