# OyeChats vs Zoho SalesIQ — Competitive Source of Truth

*Created 2026-08-30. Refreshed 2026-08-31 after a fresh, code-verified audit of OyeChats
and a fresh, source-cited web pass on Zoho SalesIQ. This is the single source for every
OyeChats-vs-Zoho-SalesIQ claim we publish: the `/compare/oyechats-vs-zoho-salesiq` page on
the marketing site, sales decks, and any ad copy. **Marketing copy is derived from this
file, never written independently of it.** If a claim is not in this file, it does not
ship.*

**Why this comparison matters more than the other six.** Zoho is an Indian company with
overwhelming mindshare among Indian SMBs, which is our primary ICP. For a large share of
our target buyers, SalesIQ is not "a competitor we might be evaluated against". It is the
tool they are already paying for, bundled into a suite they already trust, sold by a brand
they already know. Every other comparison page is a keyword play. This one is the actual
sales objection.

## What changed in the 2026-08-31 refresh

The first version was written under a "no live competitor pricing, category-level Zoho
claims only" rule. The product owner has since chosen a **fact-grounded, dated** posture:
we may publish Zoho's pricing model with representative figures, provided every such figure
carries a visible "as of <month year>, verify current pricing" caveat. The claim rules in
§1 are updated to match. Substantive fact changes this pass:

1. **Zoho's AI is Enterprise-gated (new headline fact).** SalesIQ's Answer Bot, generative
   answering, bring-your-own-LLM, and the full Zia AI layer sit on the **Enterprise** tier.
   Lower tiers get the scripted Zobot builder and capped bot sessions. This is the concrete
   form of the pricing-shape argument, and it is well sourced.
2. **Zoho shipped Zia Agents (Jun 2026).** Autonomous AI agents, up to ten per portal with
   no extra operator licence, that retrieve from uploaded documents, knowledge bases and
   records. We do **not** run a stale "their AI is weak" line. Their AI is now capable. Our
   differentiation is that ours is grounded in a crawl of your own site and included from
   the entry tier, not that theirs does not exist.
3. **Three OyeChats claims were corrected against code.** The webhook retry ladder is
   `30s / 2m / 10m / 1h` (five attempts), **not** `…/4h` (there is no 4h step in
   `webhook_service.py`). OyeChats does **not** show source citations to the visitor (the
   system prompt forbids it and the widget discards the sources frame), so the "answers cite
   the page" claim is removed. There is **no public, documented REST API**; the shipped
   push-out mechanism is HMAC-signed outbound webhooks, and the OpenAPI spec is disabled in
   production.
4. **Data residency (§3.8) is unblocked.** Zoho's India data centre and DPDP alignment are
   now confirmed, so the section ships as a Zoho win, dated.
5. **The 2026-07-15 hands-on test is admissible as qualitative, dated evidence.** Not as a
   score. See §1 rule 2.

---

## Evidence tiers

| Tag | Meaning |
|---|---|
| **[T1]** | Confirmed directly in OyeChats source code this pass |
| **[T2]** | Confirmed in maintained OyeChats documentation (`CLAUDE.md`, `docs/`) or shipped marketing data (`oyechats-website/src/lib/*.ts`) |
| **[Z-2026-08-31]** | Zoho fact confirmed by a dated, cited web source on 2026-08-31. Publishable with an "as of" caveat |
| **[CAT]** | Stable, widely-documented product-category fact about a rival. Safe to publish as a characterisation |
| **[VERIFY-BEFORE-PUBLISH]** | Plausible but not independently confirmed. Must not ship until checked and dated |
| **[DO NOT PUBLISH]** | Known-unsafe claim. Recorded so nobody re-derives it |

---

## 1. Claim posture — the rules this page is written under

1. **Zoho pricing: dated model with representative figures, always caveated.** We may state
   that SalesIQ prices per operator, name representative figures (for example roughly
   $10 / $17 / $25 per operator per month for Basic / Professional / Enterprise on monthly
   billing, cheaper annually, geo-discounted in India), and state which tier gates the AI.
   Every figure ships next to a visible "as of <month year>, check their current pricing
   page" line. Rival pricing changes without notice, and an uncaveated stale number is both
   a credibility loss and needless legal exposure. Our own numbers are always fine.
2. **No invented benchmarks. Qualitative dated test findings are allowed.** No "3x more
   qualified leads", no accuracy percentages, no ROI figures. The one exception: we may
   describe, qualitatively and with a date, what a specific hands-on test showed, provided
   we do not reduce it to a manufactured score. Example that ships: "in a July 2026 test,
   fed the same website content, OyeChats answered from the pages while SalesIQ's out-of-box
   bot declined or, when allowed to use built-in knowledge, invented a price." Example that
   does **not** ship: "OyeChats scored 85 to Zoho's 34.5". **[DO NOT PUBLISH]** the score.
3. **No named customers or testimonials.** None exist in any inspected source. **[DO NOT PUBLISH]**
4. **SalesIQ gets a genuine, prominent "choose them instead" section.** Written to be
   actually persuasive. There are real buyers for whom SalesIQ is the correct answer.
5. **Our own gaps are stated, not hidden.** No native Zoho CRM integration; no omnichannel
   or voice; a single website widget; no India data-residency guarantee; a lower entry seat
   count; a suite surface a fraction of Zoho One's. A buyer who finds an omission after
   signup churns anyway.
6. **Trademark hygiene.** "Zoho" and "Zoho SalesIQ" are trademarks of Zoho Corporation. We
   use the names nominatively, use a letter monogram rather than their logo, and imply no
   endorsement, affiliation or partnership.

---

## 2. What each product actually is

### OyeChats
An AI chatbot platform where a business points the product at its own content, gets a
private knowledge base, and embeds a widget with one script tag. Answers are generated by
RAG grounded in that content, every conversation is silently scored for sales-readiness,
and a human can take over the same thread at any point. **[T2]** — root `CLAUDE.md`.

### Zoho SalesIQ
A live chat, visitor-tracking and engagement product inside the Zoho suite. Its centre of
gravity is human live chat plus visitor intelligence, with the Zobot builder and, on the
Enterprise tier, the Answer Bot and Zia AI layer on top. Its defining strength is native
integration with Zoho CRM, Zoho Desk and the rest of the ecosystem. **[CAT]** /
**[Z-2026-08-31]**.

**The one-sentence framing:**

> SalesIQ is live chat that has added AI. OyeChats is an AI agent that has added live chat.

A difference in what each product's *defaults* optimise for, not a claim that either lacks a
checkbox.

---

## 3. The comparison axes

Map onto `FEATURE_AXES` in `compare.ts`, plus the axes this page carries in prose. `edge`
is judged from our perspective but marks `them` and `tie` honestly.

### 3.1 Grounded answers from your own content — *edge: oye*

**OyeChats.** Hybrid retrieval: pgvector semantic search over 768-dim `gemini-embedding-001`
embeddings fused with Postgres full-text `TSVECTOR` keyword search, over content ingested
from the customer's own PDFs, DOCX, TXT and a crawl of their live site. A relevance gate,
on by default, declines to answer when nothing relevant is retrieved rather than improvising.
**[T1]** — `rag_service.py`, `embedder.py`, `relevance_gate.py`.

> **Correction (was wrong in the first version).** OyeChats does **not** show source
> citations to the visitor. The system prompt explicitly forbids the model from mentioning
> "knowledge base", "documents" or "sources" (`rag_service.py:5509`), and the widget discards
> the sources metadata frame. Do not claim the answer "cites" or "names" the page it came
> from. The honest claim is that the answer is *grounded in* your content, not that it links
> to it. **[T1]**

**Zoho SalesIQ.** Answer Bot is the NLP knowledge-base bot; it trains on knowledge-base
articles and FAQs (historically requiring on the order of 30 published articles to function)
and on uploaded documents, not on an arbitrary website-URL crawl. Zobot is the codeless
flow builder. Zia Agents (launched Jun 2026) are autonomous agents that retrieve from
uploaded documents, knowledge bases, records, webhooks and connected apps. This layer is
capable and current. It is gated to the **Enterprise** tier and is configured by the
customer. **[Z-2026-08-31]** — Zoho SalesIQ chatbot page and the Summer '26 Zia Agents
announcement.

**The honest version of our edge:** not "they can't do AI". It is *what a new account does
on day one* and *what it costs*. Ours crawls your own site and answers from it as the default
state of an entry-tier account. Theirs is a build, on knowledge-base content, on the top
tier. Frame it as time-to-a-grounded-answer and where-it-sits-in-the-price-list, not
capability absence.

**Admissible dated test finding (§1 rule 2).** In a hands-on test on 2026-07-15, both bots
were given the same OyeChats website content. OyeChats answered from the pages, declined
out-of-scope questions and still redirected usefully. SalesIQ's out-of-box bot either
returned "I couldn't find any resource to answer you" or, when allowed to use built-in model
knowledge, invented a price. Ship this qualitatively and dated. Do not ship a score.

### 3.2 Built-in sales qualification — *edge: oye (strongest axis)*

**OyeChats.** Four frameworks selectable per bot: BANT, MEDDIC, CHAMP, GPCTBA+C&I
(`PRESET_FRAMEWORKS`). Weighted dimensions produce a normalised composite 0–100, mapping to
tiers `unqualified` → `mql` (≥30) → `sal` (≥55) → `sql` (≥75). Extraction runs
fire-and-forget *after* the answer streams, so it never slows the visitor, and it infers
signals from natural conversation. Interactive qualification chips ship **off by default on
every dimension of every framework** (`BR-04`). Signals are append-only; scoring does not
downgrade. Crossing into SQL fires an email notification and a `tier_transition` webhook (on
the SQL transition specifically). **[T1]** — `qualification_service.py`, `rag_service.py`.

**SalesIQ.** Behavioural and firmographic **Lead Scoring** and Company Scoring, fed by strong
visitor tracking. It does **not** present a named B2B sales-qualification framework (BANT,
MEDDIC, CHAMP, GPCTBA+C&I) as a configurable product primitive. **[Z-2026-08-31]** —
SalesIQ Lead Scoring help docs.

This is the sharpest, most defensible claim on the page. Behavioural scoring answers "who is
engaged?"; framework qualification answers "who is ready to buy, and on which dimension are
they still weak?". Lead with it.

### 3.3 Live human handoff — *edge: tie*

**OyeChats.** An explicit state machine (`session_state_machine.py`) with four states
(`bot`, `waiting`, `live`, `closed`) and enforced atomic transitions, operator routing
(least-busy default), departments, canned `/shortcut` responses, offline message capture, an
immutable `ChatAuditLog`, and WebSocket delivery. The operator inherits the full transcript
and the qualification score. **[T1]**.

**SalesIQ.** Live chat is their core competency and it is mature: routing, departments,
canned replies, operator mobile apps, audio and video calls, and richer in-chat modalities
than we offer. **[CAT]** / **[Z-2026-08-31]**.

**Call it a tie, and mean it.** Our narrow, honest advantage is a consequence of §3.2: the
operator picking up a handoff already knows the lead's tier before they type.

### 3.4 Analytics — *edge: tie*

**OyeChats.** Conversation, lead and qualification analytics, a knowledge-gap and
top-questions view, a visitor journey suite, language breakdown, and per-bot rollups with CSV
export. Our analytics answer sales questions. **[T1]** — `analytics_routes.py`.

**SalesIQ.** Long-established visitor-tracking and engagement analytics, flowing into the
larger Zoho reporting surface. **[CAT]**.

Tie. Different questions answered.

### 3.5 Integrations and CRM posture — *edge: oye for non-Zoho buyers, them for Zoho buyers*

**OyeChats.** Outbound webhooks on five events (`tier_transition`, `lead_captured`,
`handoff_requested`, `chat_closed`, `meeting_booked`), HMAC-SHA256 signed, with a
**five-attempt retry ladder backing off 30s / 2m / 10m / 1h** (SSRF-hardened). Install is
documented for HTML, Next.js, React, Vue, Angular, Shopify, Squarespace, Svelte, Webflow,
Wix, WordPress, Framer, Bubble, Astro and GTM. **[T1/T2]** — `webhook_service.py`,
`platformLogos.ts`.

> **Two corrections.** (a) The retry ladder is `30s / 2m / 10m / 1h`, not `…/4h`. Code:
> `_RETRY_DELAYS = [30, 120, 600, 3600]`, `_MAX_RETRIES = 5`; there is no 14400s step. (b)
> There is **no public, documented customer REST API**. `X-API-Key` is the dashboard's own
> auth, and the OpenAPI spec is disabled in production. Do not sell "a REST API with a full
> OpenAPI spec". The shipped, honest mechanism is HMAC-signed webhooks. **[T1]**.

**SalesIQ.** Native, first-party, deeply-wired integration with Zoho CRM, Zoho Desk and the
wider suite. The kind only the vendor who owns both sides can build. **[CAT]**.

**State our gap explicitly: OyeChats has no native Zoho CRM integration.** Leads reach any
CRM through webhooks, which is genuinely CRM-agnostic and genuinely more work than a
first-party connector. Both halves are true and both belong on the page.

### 3.6 Time to go live — *edge: oye*

Add content, paste one script tag. The loader is about 3KB gzipped, mounts into a shadow root
so host CSS cannot break it, and lazy-loads the chat app only when a visitor opens the widget.
**[T2]**. Frame as setup depth, not vendor incompetence: a suite with visitor tracking,
routing rules, departments and a bot builder is configured before it is useful.

### 3.7 Pricing — *edge: them on headline price, oye on how it scales and what is included*

**OyeChats — our own numbers, reconciled to the live platform catalog on 2026-08-31. [T1]**

Source of truth is the production API `GET https://api.oyechats.com/public/pricing-catalog`
(DB-backed, `plan_service.get_active_plans`). The website `src/lib/pricing.ts` was reconciled
to it on 2026-08-31, so `pricing.ts`, the `/pricing` page, and this comparison page now all
match what a customer is actually billed.

| Plan | Monthly INR | Monthly USD | Annual INR | Credits/mo | Seats |
|---|---|---|---|---|---|
| Free | ₹0 | $0 | — | 100 | 0 |
| Starter | ₹599 | $7.99 | ₹5,748 | 1,000 | 1 |
| Standard | ₹1,199 | $15.99 | ₹11,508 | 2,500 | 2 |
| Professional | ₹2,999 | $45.99 | ₹28,188 | 8,000 | 3 |
| Enterprise | ₹5,999 | $89.99 | ₹57,588 | 10,000 (pooled) | unlimited |

> Free credits and Professional credits changed in production on 2026-08-31 (Free 200 → 100,
> Professional 10,000 → 8,000). The public catalog endpoint briefly served the old values from
> cache; the table above is the re-verified live figure. Enterprise's 10,000 now sits above
> Professional's 8,000, which is intentional.

Extra operator seat ₹449 / $5 per month. Annual saves about 20%. Credits: 1 per AI reply,
5 per URL scan, 10 per email verification, 5 per company lookup, 1 per 250 words of document
scanning; operator messages and system emails cost nothing. Plan credits reset monthly,
top-up credits never expire and burn FIFO. **[T1]**.

> **Notes.** The four self-serve tiers (Free through Professional) are what the marketing
> `/pricing` page and this comparison page render. Enterprise is a live, public plan
> (`is_public: true`) but is a support-mediated, contact-sales motion, so whether it appears as
> a fifth public tile is a marketing-surface decision, not a pricing fact. USD figures are the
> published international geo-price; `INTL_PAYMENTS_ENABLED` defaults false, so INR/Razorpay is
> the only live billing rail. Do not claim live USD billing. **[T1]**.

**SalesIQ — dated, caveated. [Z-2026-08-31]**

Per-operator tiers with a free entry tier, discounted annually, and best value inside the
wider Zoho suite. As of August 2026, representative figures are roughly **$10 / $17 / $25 per
operator per month** for Basic / Professional / Enterprise on monthly billing (cheaper
annually; geo-discounted further in India). Free tier: three operators, one hundred operator
chat sessions a month, no bot sessions. Every published figure ships beside "as of Aug 2026,
verify on Zoho's pricing page". (Confidence: USD monthly figures are the most solid; annual
and INR figures were medium-confidence in the pass and should be re-checked before they are
quoted precisely.)

**The pricing-shape argument, now concrete.** The headline verdict stays honest: for a small
team, and especially for a business already inside the Zoho suite, SalesIQ is frequently the
cheaper line item. Mark this axis `them` in the matrix. But two facts reshape it:

- **Their AI sits on the top tier.** Answer Bot, generative answering, bring-your-own-LLM and
  the full Zia AI layer are **Enterprise-tier** features. To get an AI answering experience
  comparable in *kind* to what OyeChats includes from Free and Starter, a SalesIQ buyer is on
  Enterprise. **[Z-2026-08-31]**.
- **Our bill tracks conversations, not headcount.** OyeChats prices in credits, with seats
  included on each plan and extra seats cheap. Adding a colleague who wants to watch the inbox
  does not re-price the product.

Say both, and say them plainly. Do not say "cheaper".

> **GST.** Every OyeChats published price is GST-**exclusive**. For an Indian customer, tax is
> added at charge time (`api/app/core/tax.py`): ₹1,199 listed is ₹1,414.82 debited. For an
> international customer the sale is an export of services and no Indian GST applies. If the
> page shows any all-in figure it must show this. An Indian SMB comparing an inclusive rival
> quote against our exclusive one is being misled by our own page. **[T1/T2]**.

### 3.8 Data residency and India posture — *edge: them* (now confirmed, ships)

Zoho operates India data centres (Mumbai primary, Chennai secondary), offers India data
residency, and aligns to the DPDP Act 2023. This is a real advantage for Indian buyers with
residency requirements. **[Z-2026-08-31]**. OyeChats leans India by convention (a DigitalOcean
droplet, India-region email) but enforces **no data-residency guarantee**: visitor messages
and enrichment leave the box to third-party US LLM providers (OpenAI, Google), IP intelligence
and email-verification vendors. State this accurately and give the point to Zoho. **[T1]**.

### 3.9 Ecosystem breadth and channels — *edge: them*

Zoho One spans dozens of applications; SalesIQ adds omnichannel (WhatsApp, Instagram, Facebook
Messenger, Telegram, LINE, WeChat) and native audio and video calls. **[Z-2026-08-31]**.
OyeChats is one product on a single channel: the website widget. There is no WhatsApp,
Messenger, SMS or voice. A buyer who wants CRM, desk, books, campaigns and chat on one bill, or
who needs to meet customers on WhatsApp, should buy Zoho, and the page should say so plainly.
**[T1]**.

### 3.10 Model and vendor independence — *edge: tie, lean oye*

OyeChats routes through LiteLLM with an explicit primary/fallback pair (OpenAI `gpt-5.4-mini`
→ Google `gemini-2.5-flash`), so the answering model is a configuration choice and a provider
outage degrades rather than stops the product. **[T2]**. Note that SalesIQ's Summer '26 BYOAI
now also connects OpenAI, Anthropic, Google, DeepSeek and others, so "pluggable models" is no
longer a clean differentiator; theirs is Enterprise-gated and usage-billed separately. Do
**not** turn this into a claim about answer quality versus Zia. We have not benchmarked that.
**[DO NOT PUBLISH]** any answer-quality-vs-Zia claim.

### 3.11 Multilingual — *edge: them (mature), tie at best*

SalesIQ's Answer Bot supports up to 30 languages, and Zia Agents auto-detect mid-conversation
language switches. **[Z-2026-08-31]**. OyeChats can *answer* in roughly 19 languages, but the
widget's own UI chrome ships only English and Hindi, and multilingual is off unless both a
per-bot and a platform switch are enabled. Do **not** claim multilingual parity. If the axis is
mentioned, give it to Zoho or call it even, and do not headline it. **[T1]**.

---

## 4. The "choose Zoho SalesIQ instead" section

Ship close to verbatim:

> **Choose Zoho SalesIQ if you already run on Zoho.** If your CRM is Zoho CRM and your
> helpdesk is Zoho Desk, SalesIQ plugs into both natively, in a way no third-party tool can
> match. Your chats land next to your deals with no webhook plumbing, your team is already
> inside the suite, and the marginal cost of adding chat is small. Choose it too if you need
> WhatsApp and the other messaging channels, or audio and video calls, in one product; if you
> want a mature human live chat product first and would rather grow into the AI layer than
> start there; or if Indian data residency inside a suite you already trust is a requirement
> rather than a preference.
>
> **Choose OyeChats if you are not on Zoho, or if qualification is the point.** If you want an
> AI agent that answers from your own content on day one and hands your team a BANT- or
> MEDDIC-scored lead rather than a transcript, that is what OyeChats is built to be, and it
> pushes those leads to whatever CRM you use.

---

## 5. Claim matrix — what ships, what does not

| Claim | Tier | Ships? |
|---|---|---|
| Hybrid vector + keyword RAG grounded in the customer's own content and site crawl | T1 | ✅ |
| Four qualification frameworks: BANT, MEDDIC, CHAMP, GPCTBA+C&I | T1 | ✅ |
| Composite 0–100 score, tiers at 30 / 55 / 75, chips off by default | T1 | ✅ |
| SQL transition fires an email and a `tier_transition` webhook | T1 | ✅ |
| Four-state handoff machine with routing, departments, canned replies, audit log | T1 | ✅ |
| HMAC webhooks, five-attempt retry ladder 30s/2m/10m/1h, five events | T1 | ✅ |
| One script tag; ~3KB loader; shadow-root isolation; 15+ documented platforms | T2 | ✅ |
| Our own plan prices, credits, seats, GST-exclusive note (from `pricing.ts`) | T2 | ✅ |
| Zoho prices per operator; representative figures with an "as of Aug 2026" caveat | Z-2026-08-31 | ✅ (dated) |
| SalesIQ gates Answer Bot / generative AI / BYO-LLM / full Zia to the Enterprise tier | Z-2026-08-31 | ✅ |
| SalesIQ shipped Zia Agents (Jun 2026): capable, KB/document-centric, Enterprise-tier | Z-2026-08-31 | ✅ (as fairness) |
| SalesIQ integrates natively and deeply with Zoho CRM / Desk | CAT | ✅ |
| SalesIQ live chat is mature; adds omnichannel and voice | Z-2026-08-31 | ✅ (as a tie / their win) |
| SalesIQ has no named B2B qualification framework, uses behavioural lead scoring | Z-2026-08-31 | ✅ |
| Zoho India data residency + DPDP alignment | Z-2026-08-31 | ✅ (their win) |
| A July 2026 hands-on test: OyeChats answered from the pages, SalesIQ's bot declined or invented a price | qualitative | ✅ (no score) |
| We have **no** native Zoho CRM integration | T1 | ✅ (our gap) |
| We are website-widget only, no omnichannel or voice | T1 | ✅ (our gap) |
| We have no India data-residency guarantee | T1 | ✅ (our gap) |
| Answers cite / link the source page to the visitor | — | ❌ removed, not true **[T1]** |
| A public REST API with a full OpenAPI spec | — | ❌ removed, not true **[T1]** |
| Live USD billing | — | ❌ INR/Razorpay is the only live rail **[T1]** |
| The `85 vs 34.5` bake-off score | — | ❌ **[DO NOT PUBLISH]** |
| Any conversion / ROI / accuracy / "Nx better" number | — | ❌ **[DO NOT PUBLISH]** |
| Any named customer or testimonial | — | ❌ **[DO NOT PUBLISH]** |
| Answer-quality claim vs Zia | — | ❌ **[DO NOT PUBLISH]** |
| Multilingual parity | — | ❌ AI answers ~19 langs, UI en/hi only **[T1]** |

---

## 6. Maintenance

- **Owner:** whoever last edited `oyechats-website/src/lib/compare.ts`.
- **Review cadence:** quarterly, on any OyeChats price change, and on any Zoho pricing or
  tier-gating change.
- **Rule:** a change to a published claim lands here **first**, then in the page. If the two
  disagree, this file wins and the page is wrong.
- **Open items:** re-confirm Zoho annual and INR figures before quoting them precisely;
  decide whether the live Enterprise plan should surface as a fifth public pricing tile;
  re-date the Zoho facts on the next review. (The site-vs-backend OyeChats pricing drift was
  resolved on 2026-08-31 by reconciling `pricing.ts` to `/public/pricing-catalog`.)
