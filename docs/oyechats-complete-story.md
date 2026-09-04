# OyeChats — The Complete Story

*A single end-to-end narrative of the entire product: what it is, how it is put together, and how every part of it works — from the moment a stranger lands on the marketing page to the moment a refund is clawed back eleven months later. No framework names, no language names, no library trivia. Only the system, its flows, and its pipelines.*

> **Duplication notice (2026-08-31).** The body of this file is **byte-identical** to
> [`oyechats-technical-story.md`](oyechats-technical-story.md) — only the title and the
> audience blurb differ. Two copies of an 800-line system narrative will diverge the first
> time someone corrects one of them. **Proposed canonical: `oyechats-technical-story.md`**,
> because it carries explicit audience framing and is the file
> [`oyechats-marketing-story.md`](oyechats-marketing-story.md) links to. This file is a
> deletion candidate pending that decision; it has not been deleted, because the choice of
> which name survives is the owner's to make. Until then, any correction must be applied to
> **both** files.


---

## Part 0 — What OyeChats Is, In One Breath

OyeChats is a platform that lets any business put a genuinely knowledgeable AI chatbot on its own website in about ten minutes, without writing code.

The business signs up, points the platform at its website, and the platform reads that website the way a diligent new employee would — every page, every PDF, every brochure — and turns it into a private, searchable memory. The business then copies one line of embed code and pastes it into its site. From that moment, every visitor to that site sees a chat launcher in the corner. When they ask a question, the answer comes from the business's *own* content, not from the open internet, and not from the model's imagination.

But the chatbot is only the front door. Behind it sits a full commercial machine:

- The bot silently **qualifies** every visitor against a sales framework, scoring how ready they are to buy.
- When a visitor wants a human, the conversation **hands off live** to a real operator, with a queue, routing, transfers, and push notifications to their phone.
- Every conversation becomes a **lead record**, enriched with location, company, device, browsing journey, and a qualification tier.
- The whole thing runs on a **credit economy** with plans, trials, promotions, top-ups, invoices, tax, dunning, refunds, and an affiliate program.
- A **super-admin control tower** sits above all of it, able to see every customer, every rupee, every conversation, and every failure.

That is the product. The rest of this document is how it actually works.

---

## Part 1 — The Cast of Characters

Every flow in OyeChats is driven by one of six actors. Understanding who they are makes every later mechanism obvious.

**The Visitor.** An anonymous person browsing a customer's website. They never create an account. They are identified only by a chat session, a browser-side identifier, and whatever they voluntarily reveal. They are the reason the whole system exists.

**The Customer (also called the Owner or the Workspace).** The business that signed up. They own bots, knowledge, leads, billing, and team members. Their world is the dashboard.

**The Operator.** A human support or sales agent working inside a customer's workspace. They may be the owner themselves, or an invited teammate. They live in the Support inbox, answer handed-off chats, and can be reached on their phone. They have their own identity, their own presence state (online / away / offline), their own capacity limit, and their own permissions — an operator can see conversations and leads but not billing.

**The Affiliate.** Someone who refers new customers to OyeChats via a referral code, and is tracked for it.

**The Super Admin.** The OyeChats team. They see the entire platform: every workspace, every conversation, every credit movement, every invoice, every failed webhook, every server log. They can tune pricing, swap AI models, impersonate a customer to debug, refund an invoice, or flip a global kill switch — all without a deployment.

**The Machine.** The background worker. Nobody sees it, but it is the most industrious actor in the system. It crawls websites, re-embeds documents, renews subscriptions, expires trials, sends dunning emails, renders invoices, reconciles the payment gateway against the ledger, prunes stale data, escalates unanswered handoffs, and re-crawls customer websites weekly. It runs on a precisely choreographed daily timetable described in Part 12.

---

## Part 2 — The Anatomy: The Four Surfaces

OyeChats presents itself to the world through four distinct surfaces. Everything else is internal.

**The Marketing Site.** The public storefront. Pricing, features, legal pages, sign-up entry point. It reads live pricing from the platform so the published price and the price actually charged can never drift apart.

**The Widget.** The small chat experience that gets embedded on the customer's website. It is deliberately self-contained: it ships as a single bundle plus a stylesheet, injects its own container into the host page, and renders in complete isolation so it can never collide with the host site's own styling or scripts. It works on any website that has a page body — a modern app, an old-school HTML page, a hosted store, a page builder. Same one-line install everywhere. The widget authenticates using a **public bot key** that is visible in the page source by design, exactly like every other chat product on the market.

**The Dashboard.** Where the customer lives. Home, Chatbots, Support, Leads, Journey, Analytics, Workspace, Settings — plus the Launch Studio, a guided first-run experience. Operators see a restricted version of the same dashboard: Support, Leads, Settings only.

**The Control Tower.** The super-admin console. A separate surface with its own authentication path, deliberately unreachable by an operator key or any customer credential.

---

## Part 3 — Identity and Access: Who Is Allowed to Do What

OyeChats resolves identity at the very edge of every request, and it does so with four distinct kinds of credential. This is worth understanding precisely, because almost every security property of the platform derives from it.

**The customer key.** Issued at registration, held by the dashboard. It identifies a workspace owner. It is the strongest customer-level credential and the only one that can reach billing, plan changes, and — if the account carries the super-admin flag — the control tower.

**The bot key.** Public, embedded in the customer's page source. It identifies a *bot*, not a person. It can start chats, stream answers, submit lead forms, and request a human. It can do nothing administrative.

**The operator key.** Held by team members. It resolves to an operator inside a specific workspace. Deliberately, this key **cannot** escalate to the control tower even if the workspace owner is a super admin — the console path demands the strict customer key and nothing else.

**The workspace context.** When someone has been invited into another business's workspace, their own customer identity is paired with a workspace selector, so one human can hold one login and switch between the workspaces they belong to. The switcher in the dashboard is exactly this mechanism made visible.

On top of these sit a set of gates that every protected route passes through:

- **Verified email** — an unverified account can browse but cannot do the things that cost money or send mail.
- **Active subscription** — expired or suspended workspaces lose serving capability, not data.
- **Feature entitlement** — "does this plan include live chat / qualification / webhooks / auto-recrawl / branding removal?" is answered from a single entitlements service, so the dashboard's greyed-out button and the backend's refusal can never disagree.
- **Limit enforcement** — "can this workspace add another bot / another seat / another document?" comes from the same place.
- **Origin enforcement** — a bot can be pinned to a list of allowed domains so a stolen bot key doesn't work when pasted into a stranger's site.
- **Suspension and deactivation** — a suspended workspace is refused at the door; a deactivated one cannot authenticate at all.

There is also an **impersonation** mechanism: a super admin can mint a short-lived, revocable token that lets them see the platform exactly as a specific customer sees it, for support and debugging. Impersonation is loud — a persistent banner is shown — and it is **read-mostly**: writes are blocked unless the specific endpoint is explicitly marked as safe to perform on a customer's behalf.

---

## Part 4 — Birth: How a Customer Comes Into Existence

### 4.1 Arrival and Sign-Up

A prospect lands on the marketing site, reads the pricing, and clicks to start. They can sign up two ways:

**With an email and password.** The account is created immediately in an unverified state, and a one-time code is emailed to them. Until they enter that code, the account exists but is fenced: it cannot send mail, cannot burn credits on outbound features, and carries a persistent "verify your email" banner.

**With a single-click social sign-in.** The platform runs the standard authorization dance with the identity provider, receives a verified profile, and links it to either a brand-new account or an existing one with the same email address. Accounts created this way skip verification entirely, because the identity provider has already done it. The same path also supports a direct identity-token exchange, which is what the mobile app uses.

Either way, the moment the account exists, three things happen behind the scenes: the country of the signup is detected from edge signals so pricing and tax can be resolved correctly; a referral code, if one was carried in from an affiliate link, is attached permanently as first-touch attribution; and the account is placed on the default free plan with its starting credit grant.

There is also an **invite path**. If someone was invited into an existing workspace, the invite link resolves to a token that shows them who invited them and to what. Accepting either creates a fresh identity linked into that workspace, or attaches their existing identity to it. Either way they land as an operator in someone else's workspace, not as a new business.

### 4.2 The Launch Studio — Guided First Run

A brand-new customer does not land in an empty dashboard. They land in the **Launch Studio**, a seven-step guided build that takes them from nothing to a live, working chatbot. The Studio remembers where they stopped, so closing the tab and coming back the next day resumes exactly where they left off.

**Step 1 — Welcome and Plan.** Explain the product, show what they get, let them pick a plan or continue on free. If a launch promotion is running, this is where the offer is surfaced and claimed.

**Step 2 — Create Agent.** Name the chatbot. A bot record is created and assigned a permanent, unique bot key. From this instant the bot exists and is addressable — it just has no knowledge yet.

**Step 3 — Setup and Train.** The heart of onboarding. The customer types their website address. The platform then performs the most important trick in the product, described in full in Part 5: it discovers, fetches, reads, and memorizes their entire website — and while doing so, it also *learns who they are*. It extracts the company name and description, infers the brand's tone of voice, pulls the brand's actual colors out of the site's own styling, and harvests any brochures or videos linked in the footer. By the end of this step the bot doesn't just know facts about the business; it knows how the business talks and what it looks like.

**Step 4 — Test Agent.** The customer chats with their own bot immediately. To make the first impression strong, the platform pre-generates a couple of **seed questions** — and it does so carefully. Candidate questions are generated from the extracted company context, then each candidate is *verified* by running the exact retrieval the live bot uses, with a stricter quality bar than normal chat. Only questions with genuinely strong supporting content survive. If none survive, none are shown. The rule is absolute: a suggested sample question must never produce a weak or "I don't know" answer, because a bad first answer destroys trust faster than no sample at all.

Owner previews in the Studio are free — they don't burn chat credits — but they are bounded by a per-bot daily preview quota, so the free preview path can't be abused as an unlimited free AI endpoint.

**Step 5 — Customize Widget.** Colors, avatar, launcher name and logo, welcome title and subtitle, the offline message, the waiting message. The brand colors extracted during the crawl are offered as recommendations, so most customers accept a palette that already matches their site rather than picking from a color wheel. A live preview renders beside the controls.

**Step 6 — Deploy.** The embed snippet is shown with copy-to-clipboard and per-platform instructions. If the customer's site is on a hosted platform, tailored guidance is offered. There is also an option to email the snippet to a developer.

**Step 7 — Verification.** The platform confirms the widget is actually live on the customer's domain and stamps the moment it first saw it. That timestamp is the platform's north-star activation metric: **time to verified live widget**, measured from account creation to first bot going live, and reported as a median across all customers in the control tower.

Throughout the Studio, the dashboard emits **activation events** — studio opened, first document uploaded, widget installed, and so on. These are deliberately free-form so a new milestone can be instrumented without any schema work, and they feed the onboarding funnel that the OyeChats team watches.

---

## Part 5 — Knowledge: How a Website Becomes a Memory

This is the deepest pipeline in the product, and everything downstream depends on its quality. There are two ways knowledge enters the system — crawling a website and uploading files — and they converge into one identical processing chain.

### 5.1 Discovery — Deciding What to Read

Before anything is fetched, the platform performs a fast, cheap **discovery** pass. It reads the site's robots directives and its sitemaps, and assembles a candidate list of pages. This takes seconds, not minutes, and it exists for one reason: to tell the customer *before they spend anything* how big their site is and what the crawl will cost in credits. The customer sees a page count and a cost preview and consents.

Discovery also respects the plan. Every plan carries a maximum crawl depth, a maximum page count, a maximum number of pages that need heavy rendering, and a concurrency ceiling. A free account crawls shallow and small; a professional account crawls deep and wide.

### 5.2 Fetching — Reading the Pages

Fetching runs through a **provider abstraction with a primary and a fallback**. One provider is preferred; if it fails, stalls, or returns nothing useful for a page, the second one is used. Both return the same shape, so everything downstream is indifferent to which one did the work. Nothing is rendered locally — fetching is an off-box, managed operation, which keeps the platform's own machines light and makes very large crawls survivable.

Crawls are long-running and therefore **streamed**. Pages flow back in waves. Live per-page progress is published so the dashboard can show a real, moving progress indicator rather than a spinner, and a heartbeat keeps the job from being mistaken for a hung process and killed. The customer can cancel mid-crawl, and there is a global crawl indicator in the dashboard shell so a crawl running in the background is never invisible.

Critically, **ingestion happens concurrently with fetching**. Pages don't wait for the crawl to complete — they are processed in waves as they arrive, with a final deduplicated sweep at the end to catch stragglers. This means a large site starts becoming useful long before the crawl finishes.

### 5.3 Extraction — Getting to the Text

Uploaded files are unwrapped according to their type. Documents yield text plus page-level positioning. Structured office files yield text plus section headings. Plain text passes through. Crawled pages arrive already reduced to clean readable text by the fetch provider.

### 5.4 Cleaning

Extracted text is normalized: whitespace collapsed, encoding artifacts repaired, navigational boilerplate and repeated page furniture stripped. The goal is that what survives is the page's actual substance, not its chrome.

### 5.5 Deduplication

A cryptographic fingerprint is computed over the cleaned text. If a source with the identical fingerprint already exists for this bot, ingestion stops right there. This is what makes re-uploading the same brochure harmless, and it is the mechanism that makes weekly re-crawling cheap — more on that shortly.

### 5.6 Quota Enforcement

Before anything is stored, the platform counts the characters of cleaned, pre-chunk text and checks it against the workspace's knowledge allowance. Every plan carries a character ceiling — a small one for free accounts, a generous one for standard, none at all for professional. A running counter is kept on the account, incremented on ingest and decremented on delete, and each individual source records its own character contribution so a deletion can subtract exactly the right amount without re-processing anything.

### 5.7 Chunking

Cleaned text is split into overlapping passages. The overlap matters: a fact that straddles a boundary would otherwise be lost to both halves. Each passage carries its provenance — which source it came from, which page, which section — so an answer can always be traced back to its origin.

### 5.8 Optional Contextual Enrichment

There is an optional stage, off by default, that prepends a short machine-written context sentence to each passage before it is memorized — essentially telling each fragment what document and situation it belongs to. It measurably reduces retrieval failures, at a small one-time cost per passage at ingest.

### 5.9 Memorization

Each passage is converted into a numerical fingerprint of its *meaning* — a fixed-length vector — using a single, consistent model. This is non-negotiable and deliberately has no fallback: mixing two different meaning-models inside one memory would silently corrupt every future search, because the two would place the same idea in different locations. If the conversion fails persistently, the ingestion job fails and retries later. It never quietly substitutes something else.

Alongside the meaning fingerprint, a conventional keyword index is built for the same passage. Every passage therefore lives in memory twice: once by meaning, once by literal words. Part 6 explains why both are needed.

### 5.10 Structured Event Extraction

There is a specialized side-pipeline for a specific and very common failure: questions about dates. "When is your next workshop?" is nearly impossible to answer reliably from prose, because the model has to parse fuzzy date language at answer time and reason about *today*. So during ingestion, an inexpensive keyword filter identifies event-shaped pages, and only those pages are passed to a structured extractor that pulls each event out as a typed record with a real timestamp. At answer time, a date question is served by a precise lookup, not by reading prose. Stale events — ones whose source page no longer mentions them, or whose date has aged past the retention window — are pruned automatically.

### 5.11 Media Harvesting

Businesses hide their best assets in their footers: the brochure PDF, the product video, the channel link. The main crawl's readability pass often discards footer regions as navigational clutter. So a targeted secondary pass isolates the footer regions of the site root specifically and harvests video links and downloadable file links from them. For videos, the platform also fetches the title and duration in a single request, so a video can later be presented as a proper card rather than a bare link.

### 5.12 The Result

Every ingested passage ends up stored with: its text, its meaning fingerprint, its keyword index, its source name and provenance, its character count, its content fingerprint, and — crucially — an **active flag** and the identity of the bot that owns it. Every retrieval query in the entire platform filters on both. That single detail is what makes Part 11's knowledge-deactivation mechanic possible, and it is what guarantees one customer's memory can never leak into another's answers.

### 5.13 Living Knowledge — Auto-Recrawl

Websites change. A knowledge base captured once decays. So paid plans get **auto-recrawl**: a toggle that, once on, causes the platform to re-fetch every previously-crawled address for that bot on a recurring schedule.

The elegance here is that "only re-process what actually changed" comes for free from the deduplication step. The platform pulls the distinct list of previously-crawled addresses — excluding uploaded files, which are not web pages and must not be touched — re-fetches them all, and lets the fingerprint check silently discard everything unchanged. Only genuinely modified pages get re-chunked, re-memorized, and re-billed. Pages that vanished from the site are swept away as orphans.

The customer can also trigger a recrawl manually, and before committing they can view a **diff** — what would be added, what would be changed, what would be removed — and decide.

### 5.14 Knowledge Gaps

The platform tracks the questions visitors asked that the bot could **not** answer well, and surfaces them in the dashboard as a knowledge gap list. This closes the loop: the product tells the customer exactly which page they need to write next.

---

## Part 6 — The Conversation: What Happens When a Visitor Types

This is the single most important flow in the product, and it is far more elaborate than "search then generate." What follows is the actual sequence, in order.

### 6.1 Before Anyone Types

The widget loads, finds its own embed tag, reads the bot key, and requests that bot's public configuration: colors, avatar, launcher, welcome text, whether live chat is on, whether the lead form is on and what fields it wants, business hours, and the offline message.

It also immediately starts **journey tracking**. Every page the visitor views is appended to a browser-side trail, with a phase marker: pages viewed *before* the chat opened are the pre-chat journey, pages viewed after the chat closed are the post-chat journey. This trail is flushed to the platform on a throttle. It is the raw material for the entire Journey analytics surface, and it is captured whether or not the visitor ever chats — which is exactly what makes "which pages precede a conversion" answerable at all.

If a lead form is configured to appear before chatting, it appears now. If the bot has business hours and is currently outside them, the widget presents the offline path instead of the live one.

### 6.2 The Message Arrives

The visitor types and sends. The platform authenticates the bot from the public key, enforces the domain allowlist if one is configured, checks that the owning workspace isn't suspended, and applies a rate limit that is bucketed **per bot key and per visitor address together** — so one abusive source cannot exhaust the shared allowance and lock out every legitimate visitor on the site.

The visitor's message is written down and committed *immediately*, before any expensive work begins. This matters: if anything downstream fails, the question is never lost.

Then the credit is taken. Credit deduction happens *before* generation, inside a lock, so concurrent requests cannot oversell an account. If generation subsequently fails to produce anything at all, the credit is refunded — and the refund is triggered *structurally*, from the outcome of the generation call, never by matching text. That distinction is load-bearing: a bot whose system prompt made it echo an error-looking phrase must not be able to force free requests.

### 6.3 The Fast Exits

Before any retrieval happens, several short-circuits fire in order. Each exists because it fixed a real, visible failure.

**The first-message name flow.** On the very first message, if the bot doesn't yet know who it's talking to, it replies asking for a name — and *defers* the real question, remembering it so it can be answered on the very next turn. The visitor can decline, and declining is respected permanently. Names offered mid-conversation ("actually it's Priya") are detected and updated.

**Deterministic intent routing.** Greetings, acknowledgments, and identity questions are answered directly, without retrieval. This exists because "hi" matches nothing in any knowledge base, so the relevance gate would classify it as off-topic and open the conversation with a refusal — which reads as broken. Three categories are handled: greetings and acknowledgments, identity and meta questions ("are you an AI?", "who made you?", "is this recorded?"), and a small set of conversational fillers.

**Safety screening.** The incoming message is screened for prompt-injection and manipulation patterns. If it trips the screen, a refusal is returned and no generation occurs.

**Answer caching.** Repeated questions can be served from cache. But the cache is intelligently bypassed: handoff detection still runs on a cache hit so a visitor asking for a human is never served a stale cached answer instead; and a turn that *produced* a media card is not cached, because which card is appropriate depends on conversational context the cache key can't capture. Note the scope: it is per-turn, not per-bot. Skipping the cache for any bot whose knowledge base contained a single media URL anywhere permanently disabled the QA cache for that whole bot.

### 6.4 Query Understanding

Surviving messages go through **query rewriting**. Conversation is full of pronouns and ellipsis — "what about the enterprise one?" means nothing on its own. The rewriter uses recent history to expand the question into a self-contained search query. It has a timeout; if it doesn't return in time, the pipeline falls back to the raw text rather than stalling the visitor.

The query is also **expanded with the company's own name** where that helps disambiguate, and normalized for cache lookup. Query fingerprints are themselves cached, so a repeated question doesn't pay for the meaning-conversion twice.

### 6.5 Hybrid Retrieval

Two searches run against the bot's memory:

**Meaning search** converts the query into the same kind of fingerprint used at ingestion and finds the passages closest in meaning. This catches paraphrase — "how much does it cost" finds a page that only says "pricing."

**Keyword search** finds passages containing the literal terms. This catches the things meaning-search is bad at: product codes, part numbers, proper nouns, exact phrases.

Their results are merged by **reciprocal rank fusion**, which rewards passages that both methods ranked highly rather than simply concatenating two lists. The fused set is trimmed to a tuned depth — deliberately flat rather than adaptive, because cost predictability matters more than marginal recall.

If the meaning-conversion service is unavailable, the pipeline degrades gracefully to keyword-only rather than failing. If retrieval returns *nothing*, a multi-query fallback fires: the question is rephrased several ways and retried, on the theory that the first phrasing was simply unlucky.

### 6.6 The Gates

**The relevance gate** — on by default — asks a fast, cheap judge to score each retrieved passage against the question. If *every* passage scores below threshold, the gate fires: the pipeline does not generate an answer from irrelevant material. Instead it returns a graceful pivot. This is the platform's primary hallucination defense, and the threshold is tunable per bot, so a customer with a narrow, precise knowledge base can tighten it and a customer with broad content can loosen it.

The pivot itself is nuanced. If the question *looks* like it's about this business but nothing was found, the visitor gets a "I don't have that specific information — here's what I can help with" pivot. If the question is plainly off-topic, they get a scope refusal that names the business and steers back. These are different messages because they are different situations.

**Optional reranking.** A cross-encoder can be enabled to reorder the surviving passages more precisely than fusion alone. It fails silently to the original order on any error, so it can never block an answer.

### 6.7 Prompt Assembly

The prompt handed to the model is layered, and the layer order is deliberate:

1. **Identity** — who this bot is, which company it represents, and its extracted company description.
2. **Scope** — what it is and is not allowed to discuss, and how strictly to enforce that.
3. **Voice** — the customer's brand tone, either free-typed or filled from a curated preset. The presets are authored short enough to survive truncation intact.
4. **Response style** — a fixed block governing *how* to speak: length, formatting, when to use lists, how to space follow-ups, never asking two questions at once.
5. **Retrieved context** — the surviving passages with source attribution.
6. **Date hints** — today's date and any date context derived from the retrieved material, so "next month" is anchored.
7. **Structured events**, if the question looks date-shaped.
8. **Media catalog** — a whitelist of the exact videos and files available, so any media the bot offers must exist.
9. **Conversation history** — recent turns for continuity.
10. **Qualification instructions**, if the plan includes qualification and the bot has it enabled.

### 6.8 Generation and Streaming

The answer is generated by a primary model with an automatic fallback to a second model if the primary is unavailable. Tokens stream to the visitor as they are produced.

The stream is not passed through raw. A **live sanitizer** sits between the model and the visitor:

- It strips internal control markers as they arrive, so the visitor never glimpses machinery. Markers can straddle chunk boundaries, so the sanitizer buffers just enough to catch a marker split across two arrivals, and drains its buffer at the end.
- It runs an **output-side leakage guard**: if the accumulating answer starts reproducing the system prompt, the stream is stopped. Already-sent bytes cannot be recalled, but the leak can be truncated.
- If the model produces nothing at all, a graceful apology is substituted and the credit is refunded.

The stream is framed: an opening metadata frame carries the session identifier and source list, the body carries the answer text, and a closing metadata frame carries the message identifier, the trace identifier, and every interactive card the turn produced. The closing frame is *always* sent, even if the database write fails, because the widget waits for it — hanging the visitor is worse than an incomplete record.

### 6.9 Post-Generation Repair and Enrichment

After the stream closes, a series of safety nets run:

- **Formatting repair** — if the answer ended mid-structure or ran a follow-up question into the preceding paragraph, spacing is corrected.
- **Media validation** — any media card the model produced is validated against the whitelist. Cards for media that doesn't exist are dropped. Prose placeholders where the model *described* a card instead of emitting one are cleaned up. Conversely, a bare link the model mentioned in passing can be *promoted* into a proper card, and a relevant secondary asset can be attached.
- **Meeting card resolution** — if the bot offers meeting booking and the turn warrants it, a booking card is attached, resolved against whichever scheduling provider the customer configured. Meeting cards are deduplicated per session so the visitor isn't asked to book five times.
- **Leave-a-message card** — if the turn clearly calls for taking a message rather than answering, a message card is attached. An explicit meeting card always wins over a message card when both fire.
- **Handoff detection** — if the model's answer implies a human should take over, or the visitor's phrasing asked for one, the handoff path is triggered even if the intent classifier missed it.
- **Qualification safety net** — if the model asked a qualifying question but forgot to tag it, the tag is inferred and added.

Every card is recorded as shown, so nothing repeats.

### 6.10 Fire-and-Forget Background Work

Once the visitor has their answer, three things happen asynchronously, none of which can delay or break the conversation:

**Qualification extraction.** Described in Part 7.

**Groundedness auditing.** A judge model rates whether the answer's claims were actually supported by the passages it was generated from. This is deliberately observability-only, not blocking — the answer has already been delivered. It produces the hallucination-rate signal the OyeChats team watches, and it is the only automated check on the *generated prose* itself, as opposed to the retrieved inputs.

**Tracing.** Every model call is traced end to end with a trace identifier stored on the message. A thumbs-up or thumbs-down from the visitor attaches to that same trace. So any bad answer can be opened, in full, from question through retrieval through prompt through generation — and the feedback that flagged it is attached.

---

## Part 7 — Qualification: The Silent Salesperson

On qualifying plans, every conversation is scored against a sales framework. The customer picks the framework; four are built in.

**BANT** scores Need, Timeline, Authority, and Budget, weighted equally.
**MEDDIC** scores Metrics, Economic Buyer, Decision Criteria, Decision Process, Identified Pain, and Champion.
**CHAMP** and **GPCTBA+C&I** offer alternative shapes for teams that use them.

Every dimension has a weight, a graduated set of scored options, and an optional interactive prompt. Every field is customizable — a customer can reweight, disable a dimension, rewrite the option labels, or change the tier thresholds.

### 7.1 How Scoring Actually Happens

Two paths feed the same score.

**Background extraction.** After each answer streams, a model reads the conversation and infers where the visitor sits on each dimension. This is the default and dominant path.

**Interactive prompts.** A dimension can be configured to ask the visitor directly, presenting the graduated options as tappable chips. When the visitor taps one, that answer scores the dimension deterministically.

Critically, **the interactive chips ship OFF by default on every framework**. This is a considered product decision, not an oversight. Modern buyers read mid-conversation qualification chips as interrogation, and the market leaders default them off too. Background extraction still tiers the lead perfectly well; the visitor just gets a cleaner conversation. Customers who want the aggressive flow can turn any chip back on per bot.

Extraction is also *skipped* when it obviously won't help — a greeting, or a dimension already confidently scored — so no model call is paid for without value.

### 7.2 Scoring, Tiers, and Decay

Each dimension's raw score is normalized against its own maximum, then weighted against the total of all *enabled* dimensions — so disabling a dimension redistributes its weight correctly rather than capping the achievable score. The result is a composite from zero to one hundred.

Thresholds map that composite to a tier: **unqualified**, **MQL**, **SAL**, **SQL**. Thresholds are per-bot tunable.

There is also **decay**: a lead that scored well on timeline three months ago is not as hot today. Configurable per-thirty-day decay is applied to time-sensitive dimensions, so a stale hot lead cools honestly instead of sitting at the top of the list forever.

### 7.3 The Audit Trail

Every score movement is written to an append-only signal log: which dimension, what the score was before, what it became, and what caused it — a model inference or a visitor's tap. Nothing about a lead's score is unexplainable.

### 7.4 What a Tier Change Triggers

When a session crosses into a higher tier, the platform fires a **tier transition**. That transition sends a notification email to the addresses the customer configured, creates an in-app notification, and dispatches an outbound webhook to any endpoint the customer registered. A sales team can therefore be paged, in their own tools, at the exact moment an anonymous website visitor becomes a qualified opportunity.

---

## Part 8 — Leads: Turning Conversations Into Pipeline

A conversation becomes a lead the moment contact details are captured — through a pre-chat form, a mid-chat form, or the bot naturally asking.

### 8.1 Capture and Verification

The lead form is fully configurable: which fields, which are required. Submitted email addresses can optionally be **verified in real time** against a validation service in its most thorough mode, chosen over the cheaper mode after live testing found the cheap mode wrong roughly a quarter of the time, including a false positive on a known-bad address. Verification costs credits, is metered, and can be switched off platform-wide.

### 8.2 Enrichment

Around each captured lead, the platform assembles context automatically:

- **Location** and **device**, resolved from the request.
- **Company identification**, attempted two ways. First, the email's registrable domain is resolved to a company profile — reusing the same crawl and extraction machinery the onboarding flow uses, so no new vendor is involved, and cached so a second lead from the same company is free. Second, an address-intelligence lookup can identify the organization behind the connection. This second path is honest about its limits: an internet-service-routed connection cannot reveal a real employer, and the system says so rather than guessing. It is metered and currently held behind a flag.
- **Behavioral signals** — how many pages they viewed, whether they returned, which campaign brought them, how engaged the conversation was.
- **The journey** — the ordered trail of pages before, during, and after the chat.
- **The qualification tier and per-dimension breakdown.**

### 8.3 The Leads Surface

The customer sees leads in a filterable, sortable list with unviewed markers, per-lead detail, the full transcript, the qualification breakdown, and the enrichment. They can export. They can send a follow-up email directly from a lead. Contacts who unsubscribe are suppressed — and the unsubscribe link is cryptographically signed, because an unsigned link taking a bare address would let anyone silently block a competitor's leads from ever being contacted.

Free plans cap the number of leads retained; paid plans do not. Conversation history retention scales with plan, from a week on free to a year on professional.

---

## Part 9 — The Human Handoff: Live Chat End to End

Live chat is a full contact-center flow compressed into a chat bubble.

### 9.1 The State Machine

Every conversation is in exactly one of four states, and the legal transitions are enforced centrally, atomically, with row-level locking and a compare-and-swap guard:

- **bot** → **waiting** when the visitor requests a human.
- **waiting** → **live** when an operator accepts.
- **waiting** → **bot** if the visitor cancels, the wait times out, or no operator is available.
- **waiting** → **closed** if the visitor leaves the queue entirely.
- **live** → **bot** when the operator hands the conversation back to the AI.
- **live** → **closed** when the conversation ends.
- **live** → **waiting** when the conversation is transferred to another operator or department.
- **closed** is terminal.

Every transition writes an immutable audit entry: who did it, when, why. A failed compare-and-swap fails *loudly* rather than pretending to succeed — because callers key real side effects (notifications, assignment) off the result, and a silent no-op would produce a chat that thinks it's assigned to someone who never got it.

### 9.2 Requesting a Human

A handoff can start three ways: the visitor asks explicitly, the visitor taps a connect button, or the bot's own answer implies a human is needed and the handoff safety net fires.

There is also a **reverse flow**: an operator watching a promising bot conversation can proactively offer to join. The visitor sees a connect-request popup and accepts or declines. This is how a sales team pounces on a hot lead mid-conversation.

Optionally, a handoff can be **delayed** by a configured number of seconds, giving the bot one last chance to resolve the question before a human is pulled in.

### 9.3 Availability

Before queuing anyone, the platform resolves availability from three inputs: are we inside the bot's configured business hours, are any operators online, and do any of those online operators have spare capacity? The answer is one of several distinct states — available, all busy, all offline, outside hours — and each produces different visitor-facing behavior. There is no single "unavailable"; being outside business hours is a different conversation from everyone being busy.

Operator presence is heartbeat-driven with a durable fallback, so a crashed browser tab doesn't leave a ghost operator online forever.

### 9.4 Assignment

**Assignment is operator-pull, not server-push.** A waiting conversation is advertised to every eligible operator — over their live dashboard socket, and through the notification fan-out in §9.6 — and it is assigned to whoever accepts it first. Nothing on the server picks a specific operator for a specific chat.

> **A selection engine exists and is not wired in.** `live_chat_routing_service.select_operator` implements three strategies — least-busy with a round-robin tie-break, strict round-robin, and first-available — reading `Bot.live_chat_routing_strategy`. **That function has no caller anywhere in the API**, and the column is stored, defaulted and never read. The console deliberately exposes no control for it, because a control that saved and changed nothing would be worse than an absent one; the reasoning is written down at `app/src/features/agents/advanced/behaviour.config.ts:473-492`. `Bot.operator_disconnect_timeout` is inert in the same way.
>
> Do not describe strategy-based assignment as a shipped capability. Wiring it up is a real and fairly small piece of work — the selection logic is written and tested — but until `select_operator` has a caller, "you choose how chats get assigned" is not true of the product.

What the pull model does give you, and what a naive push model would not: a chat is never assigned to an operator who has closed their laptop, because acceptance *is* the proof of presence. The cost is that fairness is whoever-is-fastest rather than whoever-is-least-loaded.

### 9.5 The Queue

If nobody is free, the visitor enters a durable first-in-first-out queue. They see their position and it updates live as the line moves. Queues have a configurable maximum size and a configurable wait timeout. On timeout, the conversation returns to the bot with an apology and, typically, an offer to leave a message. If the visitor abandons, their entry is marked abandoned rather than silently deleted — an abandoned queue entry is a real operational signal.

### 9.6 Reaching the Operator

This is one of the more carefully engineered corners of the product, because an unanswered handoff is a lost customer.

When a handoff fires, the platform notifies every eligible operator through every channel they have: the live dashboard connection if their tab is open, a browser push notification to every device they've subscribed from, a mobile push to the app if they've installed it, and an email.

Push is fanned out to **all** of an operator's devices — laptop, desktop, phone — because whichever they reach first should win. Every push for one conversation carries the same tag, so when one device claims the chat, the notification on the other devices is *replaced* with a "claimed by" update rather than sitting there tempting the same person to race themselves.

Push respects a **grace period** relative to the live connection: if the operator's dashboard is demonstrably open and active, a redundant push is suppressed. Visitor-message emails are debounced so a chatty visitor doesn't generate a mail per sentence.

And if nobody responds, an **escalation** fires: the handoff is re-broadcast, widened, and ultimately falls through to the offline path so the visitor is never left staring at a queue that will never move.

### 9.7 The Live Conversation

Once accepted, both sides are on a persistent bidirectional connection carrying a rich protocol: messages and acknowledgments, typing indicators in both directions, read receipts, file transfers, operator-joined announcements, queue updates, availability changes, visitor disconnect and reconnect, transfer notices, close notices, and connect-request resolutions. Heartbeats keep the connection alive.

Operators work from an inbox that gives them:

- Every active conversation, with the full prior bot transcript — they arrive already knowing what was discussed.
- A session details panel with the visitor's location, device, journey, behavioral score, and qualification breakdown.
- **Canned responses** — reusable snippets invoked by typing a shortcut, so common answers are one keystroke.
- **File sending**, with uploads issued through short-lived credentials that are scoped to a session the operator legitimately owns and constrained server-side to a hard size ceiling and a pinned content type.
- **Transfer** to another operator or department, with a reason.
- **Close**, which returns the conversation to the AI, and **resolve**, which marks the outcome.
- The ability to **edit the qualification** manually, overriding the machine's inference.
- Their own presence toggle and per-operator notification preferences.

When the conversation ends, the visitor can rate it and mark whether they were helped. Those ratings roll up into the resolution and satisfaction summaries in analytics.

### 9.8 When Nobody Is There

Outside business hours, or when the queue is full, or when everyone is offline, the visitor gets the **offline message form** instead of a queue. Their message is stored, the operators are notified by push and email, and it appears in a dedicated offline-messages panel in the inbox where it can be marked handled. The visitor optionally receives a confirmation email so they know a human will follow up.

The visitor can also **email themselves the transcript**. This is deliberately locked down: if the session has a captured lead email, the transcript can only be sent to *that* address. Only sessions with no captured email retain the open self-send path.

---

## Part 10 — The Money: Plans, Credits, and the Billing Machine

OyeChats runs on a credit economy layered under conventional subscription plans. Understanding the credit ledger is understanding the business.

### 10.1 The Plans

Four tiers, each defined as data rather than code, so a super admin can retune them without a deployment.

**Free** — a real, permanent free tier. Two hundred credits a month, one bot, no operator seats, a small lead cap, a tiny knowledge allowance, shallow crawling, a week of history, platform branding, no live chat, no qualification, no webhooks, no top-ups, no auto-recrawl. It is a genuine product trial, not a demo.

**Starter** — for a solo site that wants live chat and a real agent. A thousand credits, one included operator seat, unlimited leads, a meaningful knowledge allowance, a month of history, live chat on, top-ups allowed. Still no qualification, no webhooks, no branding removal.

**Standard** — the lead machine, and the most popular tier. Twenty-five hundred credits, two included seats, unlimited documents within a generous character cap, ninety days of history, deeper crawling — and this is where the product's commercial core switches on: **qualification, webhooks, programmatic access, branding removal, and auto-recrawl**. Standard is also the only tier that carries a seven-day full-feature trial.

**Professional** — for teams scaling qualified pipeline. Ten thousand credits, three included seats, unlimited knowledge, a year of history, the deepest crawling, everything enabled.

Every tier is billed monthly or annually, with annual carrying roughly a sixth off. Extra operator seats are available on every paid tier as a separate recurring add-on. Both rupee and dollar pricing are defined; the rupee rail is the live one, with the dollar rail staged behind a flag.

### 10.2 What Costs Credits

The credit costs are configuration, not code, and every one is super-admin tunable at runtime:

- **One AI reply — one credit.** This is the core meter.
- **One crawled page — five credits.**
- **One uploaded document — three credits**, scaled by size.
- **One email-address verification — ten credits.**
- **One company lookup — five credits.**
- **Customer-facing emails — free.** Notifications, confirmations, and follow-ups never cost the customer anything.

Owner previews from the dashboard are free but daily-bounded.

### 10.3 The Ledger

Credits are not a number in a column. They are an **append-only, event-sourced ledger** where every grant, every deduction, every refund, and every expiry is a separate immutable signed row. The balance is the sum. Nothing is ever overwritten, so every balance in the system's history is reconstructible and every movement is explainable.

Four rules govern it:

**Plan grants reset on renewal.** They are use-it-or-lose-it. They never expire on their own — they are simply replaced when the next cycle grants.

**Top-up grants carry forward.** Top-ups are one-time purchases of bonus-weighted credit packs, and under current configuration they are lifetime — they never expire. The machinery for timed expiry exists and is exercised: when configured with an expiry window, whatever remains unredeemed is written off as a negative row keyed back to the original grant.

**Deductions consume in strict priority order**: plan credits first, so monthly credits don't waste at cycle end; then top-ups by earliest expiry; then manual adjustments last. Every deduction records which grant it drew from, so per-grant remaining balance is a single query.

**Every mutation takes a per-account advisory lock.** Concurrent conversations cannot oversell an account. This is the invariant that makes the meter trustworthy.

There is also a **scoping subtlety**: because the platform bills one subscription per bot, credits can live either in an account-wide pool (for legacy accounts and the free tier) or in a per-bot ledger (for bots with their own paid subscription). A single resolver decides which bucket a given bot's usage drains, and that decision is made once at the request boundary and threaded through everything downstream.

And there is a **kill switch** — a single configuration flag that halts credit consumption platform-wide. It exists for the day something goes badly wrong.

### 10.4 Buying: Checkout

The customer picks a plan and a cycle. The platform produces a **quote** — the base price, any referral discount, any active promotion, the tax breakup, and the final amount — and only then opens a checkout with the payment gateway. The quote and the charge are computed from the same source, so what's shown is what's charged.

Country matters. Billing country is confirmed explicitly rather than assumed, because it determines currency, tax treatment, and which gateway plan is used. A detected-versus-confirmed mismatch is recorded rather than silently resolved.

Recurring payment is mandate-based. On the Indian rail this means the customer authorizes a recurring mandate that the gateway then charges each cycle.

### 10.5 The Trial

Standard offers a seven-day full-feature trial with a starting credit grant. The trial has its own lifecycle, entirely worker-driven:

- Reminder emails at the halfway point and as the end approaches.
- On expiry, the subscription lapses and the bot's knowledge is deactivated (Part 11).
- After a further retention window, trial data is deleted — with the sweep deliberately timed so a same-day reactivation still rescues everything.

### 10.6 Promotions

A promotion is a time-boxed acquisition offer — "sign up this month, get three months free" — with a limited number of slots. The platform separates two concerns cleanly: an eligibility service decides *whether* an offer applies to this customer on this plan and for how many free cycles, and atomically claims a redemption slot; the billing layer realizes it by deferring the first gateway charge.

Because the first charge is deferred, the ordinary renewal cycle would skip these subscriptions entirely and they'd get no credits. So a dedicated daily job grants each free month's credits on aligned month boundaries, keyed so it can never double-grant. And roughly ten days before the free window ends, a reminder email goes out during working hours — so the first real charge is never a surprise.

### 10.7 The Renewal Train

Every night, a precisely ordered sequence runs. The order is not incidental; each step depends on the last having finished.

First, **pending cancellations are executed** at the gateway. A subscription the customer cancelled and whose paid period ends today must be stopped at the gateway *before* anything considers renewing it.

Then **renewals** run: due subscriptions roll their period forward and receive their monthly credit grant.

Then **promotional free-month credits** are granted for the deferred-charge subscriptions the renewal step couldn't see.

Then **scheduled downgrades are promoted** — the gateway's own completion event is the primary trigger for a downgrade taking effect, and this step is the safety net that catches a missed event. It runs *after* renewal specifically so a row whose period just rolled forward isn't wrongly promoted in the same tick.

Then **old top-ups expire**, **stale events are pruned**, and **expired trial data is deleted**.

### 10.8 Failure: Dunning

When a recurring charge fails, the gateway retries on its own schedule and eventually halts the mandate. The platform's job during this window is recovery, not punishment.

A **grace period** runs, during which the customer keeps working. Across it, an escalating email cadence fires once a day at a working hour for the customer base — a first notice, an action-required notice, and a final warning — each linking to the gateway's own recovery page where the customer can retry the same instrument, swap the card, or switch to a different payment method. On success, the subscription simply returns to active; no new subscription is created.

This is why the recovery flow only ever *resolves a link* and never mints a new mandate. The one exception is an explicit resume after an at-cycle-end cancellation, because that cancellation is irreversible at the gateway — there is genuinely nothing left to authorize, so a fresh mandate is the only option.

If the grace period elapses with no recovery, the subscription is suspended, a suspension email is sent, and the bot's knowledge is deactivated. The expiry sweep runs at a different hour than the cadence emails, deliberately hours apart, so a customer whose subscription dies today receives the suspension email rather than a routine reminder.

### 10.9 Changing Plans

**Upgrades** open a new subscription and stash the customer's unused plan credits so the activation event can re-grant them as a top-up once payment clears — the customer never loses paid-for credits by upgrading. Under the mandate model the old mandate is deliberately not cancelled during the transition; the cutover is driven by the gateway's own events.

**Downgrades** are scheduled to the end of the paid period rather than taken immediately, because the customer paid for the period they're in. The scheduled change is visible and cancellable.

**Seat changes** add or remove the recurring seat add-on. Because add-ons and parent plans can get out of step — an inline cancel that failed, a cutover stranded by a rolled-back activation — a daily sweep hunts for **orphaned seat add-ons** whose parent plan is gone and cancels them, so no customer is ever charged for seats on a plan they no longer have.

### 10.10 Invoices and Tax

Every charge produces a real, numbered, legally-shaped tax invoice.

Numbering is **series-allocated by financial year** with a dedicated counter, and dates render in the local business timezone rather than universal time — because the financial-year series the number was allocated in is local-time-based, and rendering in the wrong timezone would print a document dated to a different calendar day than the series it belongs to.

Tax is computed by a **pure integer engine** with no rounding drift. Given the charge and the supply classification, it produces the correct split between the two intra-state components or the single inter-state component. Two properties hold exactly, and they are the properties an audit checks: taxable plus total tax equals the total, and the components sum to the total tax. This is achieved with a single rounding point and a largest-remainder split, not by rounding each component independently.

The **seller-of-record identity** — legal name, registration number, addresses — is stored as runtime configuration, not code, so a corporate change is a data edit. It is **snapshotted onto every invoice at finalization**, so later edits to the seller profile can never mutate documents already issued.

Registration numbers are validated structurally and by checksum, both for the seller and — where captured — for business customers.

Non-local-currency supplies still need a local-currency mirror for tax reporting, so a foreign-exchange conversion module produces a defensible local-currency equivalent on export documents.

Finalization is **idempotent** — an already-numbered invoice is never re-numbered — and issued documents are **immutable**. Corrections are never edits; they are credit notes.

A worker sweep every few minutes renders each freshly-finalized invoice into a document, uploads it, and emails it to the customer. There is a compliance export for tax filing.

### 10.11 Refunds and Disputes

A refund claws back the credits it paid for — and it does so on whichever gateway event arrives *first*, at initiation rather than settlement, so a customer cannot spend refunded credits during the settlement window. But the legal credit note is only issued when the refund is confirmed **processed**, because a bank refund can still fail after being created, and issuing a legal document for a refund that never happened is an audit defect that cannot be quietly deleted. If the refund fails, the clawback is reversed.

Chargebacks follow the money: a dispute being opened or won only moves the invoice's dispute status, but a dispute being **lost** is when the gateway actually withdraws the funds, and that is when credits are clawed back.

### 10.12 Idempotency and Reconciliation

Every inbound gateway event is signature-verified and recorded by identity before processing, so a replayed or duplicated event can never double-grant credits or double-issue an invoice. Signature failures are counted and alerted on — a sudden run of them means either an attack or a rotated secret. Events that cannot be processed are dead-lettered rather than dropped, and can be replayed by hand from the control tower. Processed-event records are pruned weekly, past any realistic retry horizon.

Above all of that sits the **daily reconciliation** — the catch-all safety net. Once a day, well after the entire midnight billing train has settled, the platform diffs the gateway's view of the money against its own. Every captured payment in the window must have a local invoice; every plan charge must have its linked credit grant. A missing invoice is undocumented revenue and a tax exposure. A missing grant is a customer who paid and got nothing. The job is report-only by design — it proves the books, it doesn't silently rewrite them. A separate daily anomaly sweep flags invoice irregularities.

### 10.13 The Affiliate Program

Affiliates get referral codes. A code carried in on a signup link is attached to the new account as **first-touch attribution**, atomically, and permanently. Clicks are tracked. Conversions are tracked. Affiliates have their own portal showing their codes, their referrals, and their statistics, and they can be invited by email. Referral discounts are resolved provider-agnostically into basis points and then realized by the payment layer as a genuinely lower-priced plan, with the resulting discounted plans cached so the same discount doesn't create a new gateway plan every time.

Money math is centralized in one place with one rounding rule, precisely because an earlier split implementation could show one number on a quote and a different one on the invoice.

---

## Part 11 — Lapse and Recovery: The Most Humane Mechanic in the Product

When a paid subscription lapses — through dunning expiry, cancellation, or trial end — the obvious thing to do is delete the customer's data or let the bot keep answering. OyeChats does neither.

Instead, the bot's knowledge is **deactivated**. Every stored passage keeps existing, untouched, but is flipped inactive. Because every single retrieval, list, and count query in the platform filters on that flag, the bot instantly stops answering from a knowledge base that was built on a paid tier — while losing nothing.

The customer is then prompted to re-add knowledge within the free tier's caps if they want to keep going. And if they upgrade again, everything is restored exactly as it was.

The scoping is careful: deactivation is per **bot**, not per account. Because the platform bills one subscription per bot, a lapse on one bot must never blank a sibling bot the customer is still paying for.

This is the mechanic that makes churn reversible.

---

## Part 12 — The Machine: The Daily Timetable

The background worker is the platform's heartbeat. Some of its work is triggered — a crawl, an ingestion, a webhook delivery, a push dispatch, an email — and some runs on a clock. The clock is choreographed deliberately, with offsets chosen so no two heavy jobs collide on a minute boundary and so every dependency runs after what it depends on.

**Every thirty seconds** — retry pending outbound webhooks; emit a worker heartbeat so the control tower can prove the worker is alive.

**Just after midnight**, the billing train in strict order — execute pending cancellations, then renew due subscriptions, then grant promotional free-month credits, then promote scheduled downgrades, then expire old top-ups, then expire lapsed past-due subscriptions, then prune stale events, then delete expired trial data.

**Every fifteen minutes** — expire trials that have run out.

**Hourly, a few minutes past the hour** — sweep for bots whose auto-recrawl is due and dispatch each one.

**Every five minutes** — render, upload, and email documents for freshly finalized invoices.

**Around one in the morning** — the invoice anomaly sweep, then the orphaned seat add-on sweep.

**Around two in the morning** — the full gateway reconciliation, deliberately last, after everything else has settled.

**Mid-morning, at working hours for the customer base** — trial reminder emails, promotional pre-charge reminders, and the dunning cadence.

**Weekly, in the quiet hours** — prune processed-event records past any realistic retry horizon.

Every job is bounded, concurrency-capped, and given a timeout long enough that a legitimate large crawl is never killed mid-flight.

---

## Part 13 — Notifications: Reaching People Everywhere

The platform pushes information outward through five distinct channels, and each has a specific job.

**In-app notifications** live in the dashboard's notification center. They are persisted, scoped to a workspace, and broadcast in real time to every open dashboard tab in that workspace. Typed factories exist for each kind — bot created, crawl completed, plan purchased, offline message received, handoff requested, feedback resolved, payment failed — so the trigger sites stay one line and the payload shape is defined in exactly one place. The row is committed first, then broadcast, so a notification is never shown that doesn't exist.

**Browser push** reaches operators when their dashboard tab is closed, on every device they've subscribed from.

**Mobile push** reaches the operator's phone through the installed app.

**Email** is the durable channel. Roughly thirty distinct transactional emails exist across the lifecycle — verification codes, password resets, email-change confirmations, trial welcome and reminders and expiry, promotional pre-charge notices, qualified lead alerts, handoff requests, unavailable-callback notices, offline message alerts, visitor confirmations, transcripts, operator invites, affiliate invites and welcomes, invoices, payment failures at three escalating levels, suspension notices, re-authorization requests, and data-deletion notices. Every one of them is rendered from a single shared design system in code — there are no externally-hosted templates in the send path — which means the entire email design lives in one place and a gallery can render the exact same functions for review. Suppression lists are honored on every send.

**Outbound webhooks** reach the customer's own systems. Five events are supported: tier transition, lead captured, handoff requested, chat closed, and meeting booked. A customer registers an endpoint, receives a signing secret, and chooses which events they want. Every delivery is signed. Failures retry five times with escalating backoff — thirty seconds, two minutes, ten minutes, an hour, four hours — and every single attempt is logged with its response. When retries are exhausted, that is recorded loudly, because it means the customer's integration has gone permanently dark for that event. The customer can inspect deliveries, send a test event, and a super admin can replay any delivery by hand.

---

## Part 14 — Analytics: What the Customer Sees About Themselves

The dashboard turns the raw conversation record into eight distinct analytical views.

**Home** — the daily overview. What happened, what needs attention, and actionable insight cards that link straight to the thing that needs doing.

**Agent overview** — per-bot health. A health score, activity trend, snapshot cards, and the top questions being asked.

**Dashboard analytics** — volume, activity over time, and performance across all agents.

**Top questions and unanswered questions** — what visitors ask most, and what the bot failed on. The second list is the knowledge-gap feedback loop.

**Visitors** — who came, from where, on what, how often.

**Ratings and resolution** — visitor satisfaction and whether conversations actually resolved.

**Qualification funnel** — how many conversations reached each tier.

**Journey** — the most distinctive view. Built from the page trails captured by the widget, it answers three questions: which pages visitors spend time on, broken down by whether it was before, during, or after a chat; which *sequences* of pre-chat pages most often precede a given conversion event; and where visitors go immediately after a chat ends, both first-hop and full sequence. Every view is scoped to a bot and a date range.

**Feedback** — thumbs-up and thumbs-down on individual answers, linked back to the exact traced generation that produced them.

---

## Part 15 — The Control Tower: Running the Platform

The super-admin console is a complete operational cockpit, and it is worth enumerating because it is where the platform is actually run.

**Command center and time series** — platform-wide health and trend at a glance.

**Customers** — every workspace, with detail, editing, billing-country correction, manual credit grants, password reset, API key rotation, impersonation, and deactivation.

**Bots, documents, sessions, leads, operators** — full cross-tenant read access to everything, with the ability to reindex an individual document.

**Live queue** — the current live-chat queue across the entire platform.

**Plans and pricing content** — create, edit, retire plans; edit the pricing copy the marketing site displays.

**Pricing configuration** — every credit cost, the top-up packs, the seat price, the expiry policy, the low-balance warning threshold, the feature master switches, and the kill switch. All editable at runtime.

**Model configuration** — which model answers, which model gates, and the retrieval knobs. Changeable without a deployment or a restart, because the resolver reads from configuration with a short in-memory cache and invalidates on write.

**Feature flags** — platform-wide toggles.

**Promotions** — create and manage launch offers, and inspect redemptions.

**Coupons** — create and manage discount codes.

**Subscriptions and revenue** — every subscription, revenue reporting, and cohort analysis.

**Invoices** — full list and detail, resend an invoice email, regenerate a document, mark an invoice paid, issue a refund, run the tax export, inspect dunning state, and inspect reconciliation results.

**Gateway reconciliation and billing funnel** — the money safety nets, surfaced.

**Payment methods, processed events, failed events** — including replaying a failed inbound event by hand.

**Webhook registrations and deliveries** — inspect any customer's registered endpoints, test them, and replay any delivery.

**Credit ledger** — every credit movement platform-wide.

**Qualification signals and growth events** — the raw qualification and business-event streams.

**Usage records, offline messages, meeting bookings, linked social accounts, notifications, push subscriptions, referral conversions** — complete operational visibility.

**Model cost breakdown and usage** — what the AI is actually costing, by model and by workspace.

**Errors, worker status, crawls, and server logs** — including reading the service journals directly from the dashboard, through a strict service allowlist, so debugging doesn't require shell access to the machine.

**Safety-net metrics** — the counters emitted by every defensive path in the conversation pipeline, so the team can see how often each guard fires.

**Tracing and observability** — a direct line into the full LLM trace store.

**Audit trail** — every platform-wide mutation, immutably recorded, showing who did what to whom. The audit helper is written so it can never break its caller: auditing is a secondary concern, and a transient failure in it must never turn a successful business operation into an error.

**Platform feedback** — feedback customers submit from inside the dashboard, with a resolution workflow that notifies them when their issue is addressed.

---

## Part 16 — The Guardrails: Every Way the System Defends Itself

Collected in one place, because the density of defenses is one of the defining characteristics of this platform.

**Tenant isolation.** Every query is scoped by owner. Session lookups in the conversation pipeline are scoped by tenant as defense in depth even where the identifier alone would be sufficient. A known-but-foreign identifier presented with a valid public key returns not-found, not access.

**Privilege separation.** The control tower is reachable only by the strict customer credential. An operator key resolving into a super-admin's workspace cannot reach it.

**Origin enforcement.** Bots can be pinned to allowed domains.

**Rate limiting.** Per route, bucketed per bot and per source address together, so one abusive source cannot starve a site's legitimate visitors. This property depends on the real source address being non-spoofable, which in turn depends on all traffic transiting the edge — a deployment invariant, not just a code property.

**Injection screening.** Incoming visitor messages are screened against known manipulation patterns before generation.

**Prompt-leak guards on both sides.** The system prompt is sanitized on the way in, and the generated stream is monitored on the way out and truncated if it starts reproducing the prompt.

**Hallucination defense in depth.** The relevance gate screens retrieved material before generation. Media cards are validated against a whitelist after generation. The groundedness auditor rates the generated prose itself, continuously, in the background.

**Scope enforcement.** Off-topic questions get a scope refusal, not an invented answer. On-scope questions with no supporting material get an honest pivot.

**Credit integrity.** Advisory locks prevent overselling. Deduction happens before service. Refunds fire structurally, never by text matching, and never for partial delivery.

**Preview bounding.** Free owner previews are daily-capped so they can't be proxied into unlimited free generation.

**Upload safety.** Upload credentials are scoped to a session the requester owns, size-limited by server-enforced policy rather than a client-supplied number, and content-type pinned so a scriptable file can't be stored and served.

**Signed tokens.** Unsubscribe links, social sign-in state, and impersonation tokens are all cryptographically signed and time-bounded.

**Webhook idempotency.** Inbound events are signature-verified and deduplicated by identity. Signature failures are counted and alerted.

**Immutability where it matters.** The credit ledger, the qualification signal log, the chat audit log, the platform audit log, and issued invoices are all append-only or frozen.

**Graceful degradation everywhere.** Meaning-search failure falls back to keyword search. Reranking failure falls back to original order. Presence-cache failure falls back to durable state. Routing-cursor failure falls back to fresh selection. Company lookup failure returns "unknown," never an error. Auditing failure is swallowed. The closing stream frame is always sent. The system's default behavior under partial failure is to keep serving, degraded and honest, rather than to break.

**Loud failure where it matters.** A lost compare-and-swap on a state transition fails loudly. An exhausted webhook retry is logged at error level. A missing invoice or missing grant in reconciliation is reported. Silence is reserved for things that genuinely don't matter.

---

## Part 17 — The Full Lifecycle, Start to Finish

To close, the whole story in one continuous pass.

A business owner reads the marketing page and signs up, with a password or a single click. Their country is detected, an affiliate's code is attached if they arrived through one, and they are placed on the free plan with a starting credit grant.

They land in the Launch Studio. They name their chatbot, which is born with a permanent key. They type their website address. The platform discovers the site's pages from its own sitemaps, shows a page count and a credit cost, and asks for consent. Then it fetches every page through a managed provider with an automatic fallback, streaming pages back in waves, ingesting them concurrently with the fetch, publishing live progress the whole time.

Each page is cleaned, fingerprinted against duplicates, counted against the plan's knowledge allowance, split into overlapping passages, converted into meaning fingerprints, and indexed by keyword. Event-shaped pages are additionally parsed into typed dated records. The site's footer is separately harvested for brochures and videos. Along the way, the company's name, description, tone of voice, and brand colors are extracted.

The customer tests the bot with verified seed questions that are guaranteed to have strong answers. They customize the widget using colors pulled from their own site. They copy one line and paste it into their website. The platform confirms it is live and stamps the moment.

A visitor arrives on that website. Their page trail starts recording before they ever click the launcher. They open the chat and ask a question.

The platform authenticates the bot, checks the domain, applies the rate limit, saves the question immediately, and takes a credit under a lock. It handles greetings and identity questions directly. It asks for a name on the first turn and defers the real question to the next. It screens for manipulation. It checks the cache — but never for a handoff request, and never for a media-bearing bot.

It rewrites the question into a self-contained query using history. It searches the bot's memory by meaning and by keyword simultaneously and fuses the two rankings. It asks a judge whether any of it is actually relevant, and refuses honestly if not.

It assembles a layered prompt: identity, scope, voice, style, retrieved passages, date anchoring, structured events, a media whitelist, history, and qualification instructions. It generates the answer with a fallback model standing by, and streams it — through a sanitizer that strips machinery, catches markers split across chunks, and truncates the stream if the prompt starts leaking.

After the stream closes it repairs formatting, validates every media card against the whitelist, attaches a meeting card or a message card with the right precedence and no repeats, catches handoffs the classifier missed, and tags qualifying questions the model forgot to tag. Then it sends a closing frame that always arrives.

In the background it extracts qualification signals against the customer's chosen framework, writing every score movement to an append-only log; it audits the answer's groundedness; and it records a full trace that any future thumbs-down will attach to.

If the visitor's score crosses a tier, an email fires, an in-app notification appears, and a webhook is dispatched to the customer's own systems, signed, with five retries.

If the visitor asks for a human, the conversation moves from bot to waiting under a locked, audited transition. Availability is resolved from business hours, presence, and capacity. An operator is selected by least-busy, round-robin, or first-available. Every one of that operator's devices is notified — dashboard, browser push, mobile push, email — with a shared tag so claiming on one device silences the others. If nobody responds, it escalates, and ultimately falls through to an offline form.

The operator accepts, the state moves to live, and they arrive already holding the full bot transcript, the visitor's location, device, journey, behavioral score, and qualification breakdown. They type with canned-response shortcuts, send files through scoped and size-capped credentials, transfer if needed, and close — returning the conversation to the AI or ending it. The visitor rates the experience.

The conversation becomes a lead: contact details captured and optionally verified, company identified from the email domain or the connection, journey attached, tier attached. It appears in the leads list, exportable, followable-up, unsubscribable through a signed link.

Meanwhile the meter has been running. Chats cost a credit each, crawled pages five, documents three, verifications ten. Every movement is an immutable ledger row. Deductions drain plan credits first, then top-ups by expiry, then manual adjustments, always under a lock.

When credits run low the customer upgrades. They see a quote with discounts, promotions, and tax, and they authorize a recurring mandate. If a promotion applies, the first charge is deferred and a dedicated job grants each free month's credits on aligned boundaries, with a working-hours reminder before the free window ends.

Every night the billing train runs in strict order: cancel, renew, grant promotional credits, promote downgrades, expire top-ups, expire past-due subscriptions, prune events, delete expired trial data. Every hour, due bots are re-crawled — re-fetching everything but re-processing only what genuinely changed, and sweeping away pages that vanished. Every five minutes, freshly finalized invoices are rendered, uploaded, and emailed. Every day at one, invoice anomalies and orphaned seat add-ons are swept. Every day at two, the entire gateway's view of the money is diffed against the platform's own books.

If a charge fails, the grace period opens and an escalating daily cadence of recovery emails goes out at a working hour, each linking to a page where the customer can rescue the payment. Success simply returns them to active. Failure suspends them — and their knowledge is deactivated, not deleted. Every passage survives, flipped inactive, invisible to every query. Upgrade again and everything comes back exactly as it was.

If they refund, the credits are clawed back at initiation so nothing can be spent during settlement, but the legal credit note is only issued when the refund is confirmed processed — and if the refund fails, the clawback is reversed. If they lose a chargeback, the credits go when the money does.

Above all of it, the OyeChats team watches from the control tower: every workspace, every conversation, every credit, every invoice, every failed event, every server log, every safety-net counter, every model cost. They tune credit prices, swap models, flip feature flags, replay dead events, refund invoices, and impersonate a customer to reproduce a bug — all at runtime, none of it requiring a deployment.

That is OyeChats, end to end: a website turned into a memory, a memory turned into a conversation, a conversation turned into a qualified lead, a lead handed to a human, and the whole machine metered, invoiced, reconciled, and defended at every layer.
