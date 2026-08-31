# OyeChats — The Business Story

*Audience: CEOs, CMOs, marketing teams, and potential buyers. A plain-English walkthrough of what OyeChats is, who it's for, and why it makes businesses money — written for buyers and executives, not engineers. No technical jargon. Just what the product does and what it's worth to you.*

*For the engineering-facing, system-design deep-dive behind this product — how every mechanism actually works — see [`oyechats-technical-story.md`](oyechats-technical-story.md).*

---

> ## ⚠️ CLAIMS REVIEW — 2026-08-31, unresolved
>
> This document is buyer-facing and is used to generate customer-facing video and
> narration. A documentation audit checked its capability claims against the code. **Most
> hold.** The ones below do not, and the copy has been left **unchanged on purpose** —
> softening a sales claim quietly is the wrong fix, because each of these is a business
> decision (build the capability, or change the pitch), not an editing decision. Resolve
> them before this text is narrated, quoted in a deck, or shipped to a prospect.
>
> **1. "It routes fairly. You choose how chats get assigned to your team — spread evenly
> across whoever's least busy, strict round-robin for predictable fairness, or simply
> whoever's free first." (Part 9)** — **Not true today.** Assignment is operator-pull: a
> waiting chat is advertised to every eligible operator and goes to whoever accepts first.
> The three strategies are implemented in `live_chat_routing_service.select_operator`, but
> that function has **zero callers** in the API, `Bot.live_chat_routing_strategy` is stored
> and never read, and the console deliberately exposes no control for it
> (`app/src/features/agents/advanced/behaviour.config.ts:473-492`). There is nothing a
> customer can choose. This is the most concrete over-claim in the document and it names a
> configurable capability by its options, which makes it checkable by a prospect in a trial.
> The wiring is small — the selection logic exists and is tested — so "build it" is a real
> option.
>
> **2. "the handoff kicks off automatically" (Part 6)** — Overstated. The bot *offers*: a
> connect card is rendered and the **visitor** accepts. Nothing escalates a conversation to
> a human without the visitor's action. Part 9's own wording ("the bot itself can recognize
> when a question really needs a person and **offer** to bring one in") is accurate; Part 6
> contradicts it. Aligning Part 6 to Part 9 costs nothing.
>
> **3. "Mobile push, reaching your team's phone through the app." (Part 13, echoed in
> Part 9)** — **Unverified.** The backend does hold Expo push tokens and dispatches to them
> (`push_service.py:163`, `:246`), so the transport is real. Whether a shipped OyeChats
> mobile app exists for an operator to install is not determinable from this repository —
> there is no mobile client in it. If there is no app, "through the app" should say
> "installable web app" or be cut; if there is one, this note can go.
>
> **4. "Every single generated answer is quietly checked, after the fact, for whether its
> claims were actually backed by your content." (Part 6)** — Directionally true, with two
> caveats the word *every* papers over: the groundedness audit judges **prose** answers
> only, and it is sampled (`GROUNDEDNESS_CHECK_SAMPLE_RATE`, currently `1.0`, i.e. every
> turn — but it is a dial, not a guarantee). It is also **observability-only**: the verdict
> is logged and discarded, and never blocks, rewrites or refuses an answer. Part 6 does not
> claim it blocks, and the honest guarantee it *should* lean on is the relevance gate
> described two paragraphs earlier, which genuinely does refuse. Low risk; worth a word.
>
> Everything else spot-checked held up, including the parts most likely to be exaggerated:
> the four qualification frameworks (BANT / MEDDIC / CHAMP / GPCTBA+C&I all exist), the
> scheduled auto-recrawl, the credit ledger, the reversible-lapse mechanic, the nightly
> reconciliation, and "it won't make things up" (the relevance gate is on by default and
> genuinely blocks).
>
> Engineering-facing counterpart: [`oyechats-technical-story.md`](oyechats-technical-story.md),
> whose §9.4 has been corrected to describe the pull model.

---

## Brand Guidelines & Visual Identity

*Use this section to keep any generated video, imagery, or narration visually and tonally on-brand as real OyeChats material — not generic AI-SaaS stock styling.*

**Tagline (use verbatim where a tagline is needed):**
> "OyeChats. You only talk to buyers."

**One-line positioning (use for a subtitle or narrator setup line):**
> AI chatbot that qualifies every visitor before your sales reps ever see them — grounded answers, live handoff, and analytics, all from your own website.

**Theme name:** *Voltage Paper* — a warm, editorial "paper" neutral palette (off-white, near-black ink) punched through by a single electric-violet accent. It should read as premium, warm, and confident — not clinical or cold like a generic dark-mode SaaS tool, and not neon/gamer-purple either. Think: high-end print stationery with one deliberate jolt of color.

**Logo (current, updated mark) — live URLs, since these are what a document-only tool like NotebookLM can actually fetch (a local repo path is not reachable from outside this machine):**

| Asset | Live URL | Code path (reference only, not fetchable externally) |
|---|---|---|
| Primary mark, for light backgrounds (solid near-black) | https://app.oyechats.com/logo-light.png | `app/public/logo-light.png` |
| Primary mark, for dark backgrounds (solid white) | https://app.oyechats.com/logo-dark.png | `app/public/logo-dark.png` |
| Cropped/square favicon crop | https://app.oyechats.com/oye_favicon_cropped.png | `app/public/oye_favicon_cropped.png` |
| Small favicon (32px) | https://app.oyechats.com/favicon-32.png | `app/public/favicon-32.png` |
| Small favicon (192px) | https://app.oyechats.com/favicon-192.png | `app/public/favicon-192.png` |

All confirmed live (HTTP 200) as of this writing. These are the current logomark, used across the Admin Platform 2.0 rebuild, and supersede the older navy mark still live at `https://www.oyechats.com/oyechats-mark.png` on the marketing site — that one is stale and should not be used for new material.

**Mark description** (for when an image can't be pulled in, or as a caption): a rounded, bold "C"-shaped ring that reads simultaneously as the OyeChats initial and a speech bubble — three dots inside it (an active "typing…" indicator, reinforcing "live conversation"), with a small chat-tail notch at the bottom where the ring breaks. Clean, geometric, single-color (no gradient, no multi-color) in either pure near-black or pure white depending on background — never rendered in Volt violet or any other color.

Do not use `app/public/logo-icon.png` (an earlier, rougher sketch-style render with a sparkle flourish) — it's a discarded exploration, not the production mark, and isn't hosted at a live URL. No standalone SVG exists for the current mark — the PNG is the source of truth for shape/proportions; don't stretch or recolor it.

**Color palette (exact hex values):**

| Role | Hex | Notes |
|---|---|---|
| Paper (page background) | `#FAFAF7` | Primary light background — warm off-white, never pure white as the dominant field |
| Canvas | `#FFFFFF` | Cards/surfaces sitting on top of Paper |
| Ink (primary text) | `#0A0A0A` | Near-black, not pure black |
| Ink-2 (secondary text) | `#3F3F46` | |
| Muted text | `#71717A` | |
| Line / hairline borders | `#E7E5DE` | Warm-toned, not cool gray |
| Dark section background | `#14101E` | Used for dark/contrast sections, has a violet undertone rather than neutral black |
| Dark section text | `#F5F1FA` | |
| **Volt (primary brand accent)** | **`#7C3AED`** | The signature color — use for CTAs, highlights, the chat bubble, key emphasis |
| Volt hover/pressed | `#6D28D9` | |
| Volt on dark surfaces | `#A78BFA` | Lighter violet for legibility on dark backgrounds |
| Volt tint (light accent fill) | `#FDF4FF` | |
| Volt hairline | `#DDD6FE` | |
| Volt ink (accent text on light) | `#5B21B6` | |
| Success | `#0B7A45` (text) / `#0F9D58` (graphics/icons) | |
| Warning | `#B45309` | |
| Danger/error | `#B91C1C` | |

**The one rule that matters most:** violet (`#7C3AED`) is a *single accent*, not a background color. The dominant field is always warm paper/near-black — violet appears as CTAs, the chat bubble, icons, underlines, and emphasis, not as a wash across whole scenes. This is what makes it read as "Voltage Paper" rather than "generic purple SaaS."

**Typography:**
- Headings / display: **Geist**
- Body text: **Inter**
- Monospace (code, technical labels): **Geist Mono**
- Editorial accent (pull-quotes, testimonials only): **Fraunces**, italic — used sparingly, never for UI or body copy

**Tone for narration/voiceover:** confident, direct, plain-spoken — short declarative sentences, no hype-adjective stacking ("revolutionary," "game-changing"), no filler. The brand voice trusts the product to be impressive on its own; it doesn't oversell it. Mirrors the tagline's economy: "You only talk to buyers." — six words, no adjectives, a clear customer benefit.

---

## Video Visual Style — Papercraft / Origami Diorama

*This spec is extracted directly from a NotebookLM-generated video the team liked (`The_Active_Web__Engineering_Conversion_with_OyeChats.mp4`). Use it as the concrete visual-generation brief for any future OyeChats video — it already overlaps naturally with the Voltage Paper palette above, so the two should be treated as one system, not two competing styles.*

**Medium.** Everything in the scene is built as if physically cut, folded, and embossed from thick craft paper — website UI, phone mockups, speech bubbles, icons, even the human characters and the mascot. Nothing is flat 2D graphic design; it's a miniature tabletop diorama shot with a macro lens. Visible paper grain/fiber texture, soft rounded die-cut edges, and slightly raised/embossed or engraved lettering pressed directly into the paper (never a flat printed label).

**Palette.** Dominant field is warm cream/ivory/beige paper tones — this *is* the "Paper" side of Voltage Paper (`#FAFAF7` family), extended into taupe and warm-gray paper-shadow tones for depth. Backgrounds are neutral desk/studio surfaces (soft gray tabletop, or warm wood-grain desk for close-up character shots). Color is used sparingly and only for small functional accents — a dusty rose folder icon, a muted denim-blue icon — never as a scene-dominant hue.

**The glow accent.** Every "this is the important thing" moment is signaled by a warm light glowing *from inside* the paper object itself — a button lights up amber-gold from within, a speech bubble glows like a paper lantern, a phone screen backlights the hand holding it. **Recommendation: re-key this glow to Volt violet (`#7C3AED` / `#A78BFA` on darker paper) instead of the generic warm-gold used in the reference video.** The paper/diorama technique should stay identical; only the glow color changes — that single swap is what turns "a nice papercraft AI video" into "an unmistakably OyeChats video." Reserve the original gold only for one-off metaphors like an award or a coin, not as the recurring CTA/highlight color.

**Characters & mascot.** Humans are rendered as soft, chibi-proportioned paper-sculpture figures — rounded folded-paper limbs with visible fold-seam lines, simple friendly painted faces, business-casual paper clothing (blazer, headset for a support-agent character). The AI itself is represented by a distinct low-poly origami robot — angular folded triangle panels in metallic gold/silver, geometric (not humanoid-cute), sitting deliberately apart in tone from the warm human characters to visually separate "the AI" from "the person." Keep that human-vs-robot material contrast (warm paper vs. cold metallic-fold) whenever both appear together, e.g. an AI hand-off scene.

**UI-as-paper motifs.** Website/app chrome (browser bars, nav pills, buttons, cards, phone bezels) is rendered as stacked, layered paper cutouts with soft drop shadows between layers, giving real physical depth to what would normally be a flat screenshot. Recurring motifs: a folded-paper speech bubble with a glow inside it; a paper smartphone held in paper hands; nav pills and buttons as raised paper tabs with embossed labels; a dot-grid backdrop with thin dashed gold/accent connector lines linking related elements (e.g. "Buyer" persona icon dashed-lined to relevant content icons); a fanned stack of paper app-icon cards.

**Lighting & camera.** Soft, warm studio softbox lighting from one dominant direction, gentle realistic shadows, shallow depth of field (background objects visibly soft/out of focus), macro tabletop-photography framing — camera sits close on one hero object per shot rather than wide establishing shots. Slight cinematic tilt is fine; keep it subtle, not dramatic.

**Typography in-scene.** All in-scene lettering is engraved/debossed or subtly foil-stamped directly into the paper surface, typically set in caps or small-caps for UI labels (MENU, SERVICES, USER PROFILE) — a stationery/print-shop feel, not a digital UI font. This can coexist with the Geist/Inter type system used for the video's actual overlay titles and lower-thirds; keep in-scene "paper" lettering visually distinct from any real on-screen title cards.

**Mood in one line:** a handcrafted, tactile, premium print-stationery diorama — genuinely warm and human — telling the story of a very modern AI product. The contrast between "analog paper craft" and "digital AI subject matter" is the whole visual joke/hook; don't let the paper texture slip into looking like generic 3D-render plastic, and don't let the AI/tech elements slip into looking cold or corporate.

---

## Part 0 — What OyeChats Is, In One Breath

OyeChats turns any business website into a 24/7 AI salesperson — one that actually knows your business, qualifies your visitors, and hands the hot ones to a real human before they walk away.

You sign up, point it at your website, and in about ten minutes it has read everything — every page, every brochure, every product sheet — and turned it into a private knowledge base that only your chatbot can use. You copy one line of code onto your site. From that moment, every visitor sees a chat bubble. When they ask a question, the answer comes from *your* content — not a generic AI guess, not the open internet.

But the chat window is just the visible part. Underneath it is a complete revenue engine:

- It **quietly scores every visitor** the moment they start chatting — how ready are they to buy, right now?
- The instant a visitor is worth a human's time, it **hands the conversation to your sales or support team** — live, with a queue, routing, and a phone notification.
- Every conversation becomes a **enriched lead record** — who they are, where they came from, what they looked at, how qualified they are.
- It runs on a **simple, transparent credit system** — plans, trials, discounts, and clean invoicing, with no surprise charges.
- Your team gets a **command center** to see every conversation, every lead, and every dollar, in one place.

That's the product. Everything below is why it matters to your business — and what makes it different from the crowded field of "AI chatbot" tools.

---

## Part 1 — Who Uses It

**Your website visitors.** Anonymous strangers browsing your site. They never have to sign up or download anything to talk to your bot — they just click and type. This is your top-of-funnel audience, and OyeChats is built to convert as many of them into leads as possible.

**You — the business.** You own the bot, the knowledge it has, the leads it generates, and the billing. Everything happens in one dashboard.

**Your team.** Sales reps, support agents, whoever answers chats. They get their own login, their own inbox, and can be reached on their phone the moment a hot conversation needs them. You control exactly what they can see — a rep can work leads and chats without ever touching your billing.

**Your affiliates or partners.** Anyone who refers customers to OyeChats using a tracked referral link — useful if you're an agency reselling OyeChats, or simply want a referral program of your own.

**The OyeChats team, behind the scenes.** We can see platform health, help with support issues, and tune your account — always with your knowledge, never silently.

---

## Part 2 — Where You'll Actually Touch the Product

**Your marketing site sign-up.** Pricing is always accurate — what's advertised is exactly what's charged, because both come from the same source.

**The chat widget on your website.** A small, fast, self-contained chat bubble that drops into any website — a modern site, an old-school HTML page, a Shopify store, a page builder — with one line of code. It never breaks your site's styling, and it never breaks because of your site's styling. Same install, everywhere.

**Your dashboard.** This is where you live day to day: home overview, your chatbots, your live-chat inbox, your leads, visitor journey analytics, reporting, and settings — plus a guided setup flow the first time you log in. Team members get a scoped-down version focused on chats and leads.

**The control center (for the OyeChats team).** A separate, more locked-down view used to support and operate the platform on your behalf.

---

## Part 3 — Trust and Access, In Plain Terms

Every part of OyeChats knows exactly who is talking to it and what they're allowed to do — and that separation is airtight:

- Your **login** is the only thing that can touch billing, plans, and account-level settings.
- Your **public chatbot** can talk to visitors and take leads — nothing more. It has no access to anything administrative, even though it's technically visible in your page's code (this is standard for every chat product on the market, including the big names).
- Your **team members' logins** are scoped to chat and leads only, and can never accidentally reach billing or account settings — even if you, the owner, also happen to manage other OyeChats accounts.
- If you're invited into someone else's workspace (an agency managing multiple client accounts, for example), you can switch between the workspaces you belong to with one login.

On top of that, every action is checked against: is this account verified, is the subscription active, does this plan actually include this feature, has this account hit its limits, is this bot only allowed to run on approved domains. Nothing is enforced in the dashboard and skipped on the backend, or vice versa — what you see is what's actually true.

If our support team ever needs to look at your account to help you, they use a temporary, clearly-flagged access mode — you'd see a banner the whole time — and by default it can only look, not change anything, unless a specific action is explicitly safe to do on your behalf.

---

## Part 4 — Getting Started: From Sign-Up to Live Bot in About Ten Minutes

### 4.1 Signing Up

You sign up with email and password, or one click via Google. Either way, within seconds your account exists on a real, free-forever starter plan with credits already loaded — no credit card needed to try it.

If someone invited you to join their team, you land straight in their workspace as a team member, not as a new customer.

### 4.2 The Guided Launch — Seven Simple Steps

New customers don't land in an empty dashboard wondering what to do first. You're walked through a seven-step guided build that takes you from nothing to a live, working chatbot — and it remembers exactly where you left off if you close the tab and come back tomorrow.

1. **Welcome & plan** — see what you get, pick a plan or start free. If there's a launch offer running, it's presented right here.
2. **Create your agent** — name your chatbot. It's born instantly with its own permanent identity.
3. **Point it at your website** — this is the magic step. You type your website address, and the platform reads your *entire* site — every page, every PDF, every brochure — and teaches your bot who you are. It doesn't just learn facts about your business; it learns how your brand talks and even pulls your actual brand colors straight off your site.
4. **Test it yourself** — chat with your own bot immediately. It comes pre-loaded with a couple of smart sample questions — but only ones it's *already confirmed* it can answer well. If it can't find a genuinely strong answer to suggest, it shows nothing rather than a weak one, because a bad first answer kills trust faster than no sample question at all.
5. **Customize the widget** — colors, avatar, welcome message, all matched to your brand automatically, with a live preview.
6. **Deploy** — copy one line of code, paste it into your site (or email it straight to your developer).
7. **Go live** — the platform confirms your widget is actually working on your live site and marks the moment. This "time to live chatbot" number is the single metric we watch most closely, because it's the moment your investment starts paying off.

---

## Part 5 — How Your Website Becomes Your Bot's Brain

This is the core of the product, so it's worth explaining simply: your bot doesn't guess. It only knows what your website and documents actually say.

**It reads before it commits.** Before doing any real work, the platform quickly scans your site's structure to estimate how big the job is, shows you a page count and cost, and asks you to confirm — no surprise bills.

**It reads live, and reads a lot.** Once you say go, it fetches your pages using enterprise-grade crawling infrastructure, with an automatic backup method if the first one hits a snag on any given page — so a handful of tricky pages never stalls the whole job. You see real progress as pages come in, not a spinner. You can cancel anytime.

**It gets useful fast.** Your bot doesn't wait for the entire site to finish before it starts learning — pages are processed as they arrive, so a large site becomes useful within minutes, not hours.

**It's smart about what it keeps.** Repeated content — the same brochure uploaded twice, a page that hasn't changed since last week — is automatically recognized and skipped, so you're never billed twice for the same information.

**It finds the things hiding in your footer.** Businesses tend to bury their best assets — the product video, the downloadable brochure, the channel link — in the footer, where a naive crawler would ignore them as clutter. OyeChats specifically hunts those out and pulls them in as real, presentable media your bot can show a visitor.

**It stays current.** On paid plans, your bot automatically re-checks your site on a schedule and updates itself with anything that changed — and only what changed, so it's cheap and fast. You can also trigger a manual re-check anytime and preview exactly what would be added, changed, or removed before committing.

**It tells you what it's missing.** The dashboard shows you the actual questions visitors asked that your bot couldn't answer well — a direct, ongoing to-do list of exactly which page you should write next.

---

## Part 6 — The Conversation: Why Visitors Trust It

This is the part your visitors actually experience, and it's engineered to feel less like "talking to a bot" and more like getting a genuinely helpful, fast, accurate answer.

**It remembers context.** If a visitor asks "how much does it cost?" and then follows up with "what about the enterprise one?", the bot understands what "the enterprise one" refers to — it doesn't lose the thread.

**It won't make things up.** This is the single most important trust property in the whole product. Before answering, the bot checks whether it actually found something relevant in your content. If it didn't, it says so honestly — either "I don't have that specific detail, here's what I *can* help with" or a polite redirect back to what your business does — instead of inventing a plausible-sounding but wrong answer. This is the platform's core defense against the embarrassing "AI made something up" moment that damages brand trust.

**It sounds like you.** Your brand's tone of voice — extracted from your own site, or set manually — shapes how the bot writes. Answers are kept tight, well-formatted, and never interrogate the visitor with a wall of questions at once.

**It's fast and it streams.** Answers appear word by word as they're generated, the same experience visitors expect from modern AI products, with an automatic backup AI model on standby in case the primary one has a hiccup — so the bot rarely, if ever, just goes silent.

**It knows when to bring in a human.** If the bot's own answer implies a person should really be handling this, or the visitor explicitly asks for one, the handoff kicks off automatically — described in Part 8.

**It offers real media, not broken links.** If your bot mentions a video or a brochure, it only ever offers ones that genuinely exist and are relevant — no dead links, no invented file names.

**Every answer is auditable.** Every single generated answer is quietly checked, after the fact, for whether its claims were actually backed by your content. That's how we watch and continuously improve accuracy across the whole platform — and how a thumbs-down from a visitor can be traced all the way back to exactly what went wrong.

---

## Part 7 — Lead Qualification: The Silent Salesperson

This is where OyeChats stops being "a chatbot" and starts being a sales tool.

Every conversation is quietly scored against a proven sales-qualification framework — you choose which one fits how your team sells:

- **BANT** — Budget, Authority, Need, Timeline. The classic.
- **MEDDIC** — a deeper framework built for complex B2B sales: metrics, economic buyer, decision criteria and process, pain, champion.
- **CHAMP** and **GPCTBA+C&I** — alternative shapes for teams that already run one of these.

As the conversation happens, the AI silently reads between the lines and figures out where the visitor sits on each dimension — no interrogation required. You can optionally turn on interactive question chips that ask the visitor directly, but **these are deliberately switched off by default**, because modern buyers experience mid-chat qualification chips as being interrogated, and every serious competitor in this space defaults them off too. The background scoring alone tiers the lead perfectly well, and the visitor just gets a cleaner, more natural conversation.

Each visitor ends up in one of four tiers — **unqualified, MQL, SAL, SQL** — and every score is fully explainable: you can see exactly why a lead is scored the way it is, and what moved it. Old scores also gently decay over time, so a lead that looked hot three months ago and went quiet doesn't sit at the top of your list pretending to still be hot.

**And here's the payoff:** the moment a visitor's score crosses into a higher tier, your team gets notified instantly — by email, inside the dashboard, and via an outbound alert to any tool you've connected (Slack, your CRM, wherever). Your sales team can be paged, in their own tools, at the exact second an anonymous website visitor becomes a real opportunity.

---

## Part 8 — Turning Conversations Into Real Pipeline

A conversation becomes a lead the moment someone shares their contact details — through a form before chatting, mid-conversation, or because the bot naturally asked.

**Verified, not just collected.** Email addresses can optionally be checked in real time against a thorough validation service, so your sales team isn't chasing typo'd or fake addresses.

**Automatically enriched.** Around every lead, the platform assembles context for free: their likely company (identified from their email domain, using the same intelligence that reads websites during onboarding), their location and device, how many pages they viewed and whether they've been back before, and the full page-by-page journey that led them to chat.

**Fully actionable.** Leads show up in a clean, filterable, sortable list with the full transcript, the qualification breakdown, and everything enriched — exportable, follow-up-able directly from the record. Unsubscribes are respected and protected with a signed link, so nobody can weaponize the system to silently block a competitor's leads.

Free plans keep a limited number of leads on hand; paid plans keep them all, with conversation history retained anywhere from a week up to a full year depending on your plan.

---

## Part 9 — The Human Handoff: Never Let a Hot Lead Walk Away

This is a full live-chat contact-center experience, built directly into the chat bubble on your site.

**How it starts.** A visitor can ask for a human directly, tap a "talk to someone" button, or the bot itself can recognize when a question really needs a person and offer to bring one in. Your team can also proactively jump into a promising bot conversation themselves — this is how a sales rep pounces on a hot lead mid-chat, in real time.

**It knows who's actually available.** The system checks your business hours, who on your team is currently online, and who actually has room to take another chat — and gives the visitor an honest answer accordingly. "Everyone's busy right now" is a different experience from "we're outside business hours," and the visitor sees the right one.

**It routes fairly.** You choose how chats get assigned to your team — spread evenly across whoever's least busy, strict round-robin for predictable fairness, or simply whoever's free first.

**Nobody misses a notification.** When a chat needs a human, every device your rep has — laptop, phone, tablet — gets notified at once, through every channel available: the dashboard itself, browser push, mobile push, and email. Whichever device they see first wins, and the moment one person claims it, the notification quietly disappears from their other devices instead of nagging them. If genuinely nobody responds in time, it escalates further and, as a last resort, gracefully falls back to an offline message form — so a visitor is never left staring at a queue that goes nowhere.

**Your team works efficiently, not blind.** When a rep picks up a chat, they immediately see the entire prior conversation the AI had, plus the visitor's location, device, browsing journey, and qualification score — they're never starting cold. They get reusable canned-response shortcuts for common answers, can send files securely, transfer to a colleague or department, and hand the conversation back to the AI or close it out when done. Visitors can rate the experience afterward, feeding straight into your satisfaction reporting.

**And if nobody's around**, the visitor gets a simple message form instead, your team is alerted by push and email, and it lands in a dedicated inbox to be handled when someone's back.

---

## Part 10 — Simple, Transparent Pricing

OyeChats runs on a straightforward credit system layered under clear monthly or annual plans — no hidden usage fees, no surprise invoices.

**Free** — a genuine, permanent free tier to try the product for real, not a time-limited demo. One bot, real credits every month, a small knowledge allowance.

**Starter** — for a single site that wants a live chat option and a real, working agent. Includes a real seat for a team member, unlimited leads, and live chat turned on.

**Standard** — the most popular tier, and the one built for lead generation specifically. This is where the product's real commercial engine switches on: **lead qualification, integrations with your other tools, removing OyeChats branding, and automatic knowledge updates.** Standard is also the only plan with a full-featured seven-day free trial, so you can experience everything before paying.

**Professional** — for teams scaling serious qualified pipeline. The most credits, the most seats, unlimited knowledge, a full year of conversation history, everything unlocked.

Annual billing saves roughly a sixth compared to paying monthly. Extra seats for team members can be added to any paid plan. Every credit cost is clearly defined upfront — a bot reply, a crawled page, an uploaded document, an email verification — so usage is always predictable, never a surprise.

**Every credit movement is permanently logged and fully explainable** — nothing about your balance is ever a mystery, and every charge, refund, and grant can be traced.

**Real invoices, done right.** Every payment produces a proper, correctly numbered, tax-compliant invoice automatically — rendered, delivered to your inbox, and ready for your books, with no manual work on your end.

**Upgrades never cost you credits you already paid for** — any unused credits carry forward as a bonus. **Downgrades take effect at the end of your paid period**, not immediately, because you already paid for the time you're in.

**If a payment fails**, you get a grace period and a clear, friendly reminder sequence — never punitive, always aimed at getting your payment fixed with one click, with your service uninterrupted while you sort it out.

---

## Part 11 — The Most Human Thing in the Product: What Happens If You Lapse

If a subscription lapses — a failed payment that's never fixed, a cancellation, a trial that ends — most SaaS products either quietly delete your data or, worse, keep serving on content you're no longer paying for. OyeChats does neither.

Instead, your bot's knowledge is simply **put to sleep, not deleted.** Every page you trained it on is still there, fully intact — it's just switched off. Your bot politely stops answering from that content, and nothing is lost.

If you come back and reactivate, everything is restored exactly as it was — instantly. If a customer changes their mind about one bot but is still happily paying for another, only the lapsed one is affected; nothing else is touched.

This is a deliberate choice: **churn should always be reversible.** A customer who left because of one bad month should never come back to find their work gone.

---

## Part 12 — Always Working, Even When No One's Watching

Behind the dashboard, OyeChats runs a continuous set of background processes on a precise nightly and hourly schedule: subscriptions renew, promotions grant their credits, invoices are generated and emailed, trial reminders go out, websites get automatically re-checked for updates, and the entire day's payments are reconciled against the books every single night — a built-in financial safety net that catches any mismatch between what was charged and what was recorded, automatically, every day.

None of this requires anyone on your team to do anything. It just runs.

---

## Part 13 — Reaching People, Wherever They Are

OyeChats keeps everyone in the loop through five channels, each doing a specific job:

- **In-dashboard notifications**, live, the moment something happens.
- **Browser push**, reaching your team even when their dashboard tab isn't open.
- **Mobile push**, reaching your team's phone through the app.
- **Email** — the reliable channel for everything that matters: verification, trial and billing updates, qualified-lead alerts, handoff requests, invoices, and more, all professionally designed and consistent.
- **Outbound integrations** — connect OyeChats to your own CRM, Slack, or internal tools. Register an endpoint, choose which events matter to you (a lead crosses a qualification tier, a lead is captured, a human is requested, a chat closes, a meeting is booked), and OyeChats reliably delivers, retrying automatically if your system is briefly unavailable.

---

## Part 14 — Understanding Your Own Traffic

The dashboard turns every conversation into insight you can actually act on, across eight views:

- **Home** — what happened today, and what needs your attention right now.
- **Per-bot health** — how each chatbot is performing, and the top questions being asked.
- **Overall performance** — volume and activity across everything.
- **Top questions & unanswered questions** — what visitors want to know, and exactly where your content has a gap.
- **Visitors** — who's coming, from where, on what device, how often.
- **Ratings & resolution** — real visitor satisfaction data.
- **Qualification funnel** — how many conversations reach each buying-readiness tier.
- **Journey** — the standout view: which pages visitors read before they chat, which page *sequences* most reliably lead to a conversion, and where people go right after a conversation ends. This turns your chatbot into a genuine window into your entire site's conversion path — not just the chat itself.

---

## Part 15 — Enterprise-Grade Trust, Without the Enterprise Complexity

You don't need a security team to trust OyeChats — the guardrails are built in and running by default:

- **Your data never leaks to another customer.** Every single piece of information is strictly scoped to your account, at every layer, with no exceptions.
- **Your bot only ever tells the truth it knows.** It's built to refuse honestly rather than guess, and every generated answer is continuously checked in the background for accuracy.
- **Your bot can't be tricked.** Incoming messages are screened for manipulation attempts before they ever reach the AI, and the AI's own internal instructions can never be leaked back out, even under active probing.
- **Your money is protected.** Credits can never be double-charged or double-refunded — every financial action is protected against replay and race conditions, and the entire day's transactions are automatically checked against the books every night.
- **Uploads and links are locked down.** File uploads are size- and type-restricted server-side, so a malicious upload can't be smuggled in. Sensitive links — unsubscribe, sign-in, staff access — are all cryptographically signed and time-limited.
- **The system fails safe, not silent.** If one piece has a hiccup, OyeChats degrades gracefully and keeps serving your visitors rather than going down — and anything that genuinely needs a human's attention is flagged loudly, not buried.

---

## Part 16 — Why This Matters for the Business

Put simply, OyeChats replaces four things a growing business would otherwise buy separately, badly integrated, and expensively:

1. **A knowledgeable AI chatbot** that actually answers from your real content — not a generic FAQ bot.
2. **A lead qualification engine** that scores every visitor automatically against a proven sales framework, so your team spends time on the leads worth their time.
3. **A live-chat contact center** that catches the hot leads the moment they're ready for a human, with routing, queueing, and multi-device alerting.
4. **A visitor analytics platform** that shows you not just chat data, but the entire page journey that leads to (or away from) a conversion.

All of it installs in ten minutes with one line of code, costs are predictable and transparent, churn is reversible instead of punishing, and every safety net — financial, factual, and security — runs by default, with nobody on your team needing to configure it.

That's the pitch: **a website that used to just sit there now actively works your funnel, around the clock, and hands your team only the conversations worth having.**

---

## Part 17 — The Story, Start to Finish

A business owner finds OyeChats, signs up in seconds, and lands in a guided setup that takes about ten minutes. They point it at their website; the platform reads everything — every page, every brochure — and learns not just what the business does, but how it talks and what it looks like. The owner tests the bot with sample questions it's already proven it can answer well, matches the widget to their brand automatically, and pastes one line of code onto their site. The platform confirms it's live.

A visitor arrives. Their browsing is quietly tracked from the moment they land — before they've even opened the chat. They ask a question. The bot answers instantly, in the business's own voice, from the business's own content — and if it genuinely doesn't know, it says so honestly rather than making something up.

Behind that one reply, the platform is already scoring how qualified this visitor is against a real sales framework, all without interrupting the conversation with interrogation. The moment they cross into "hot lead" territory, the sales team gets pinged — in their inbox, in the dashboard, in their own CRM.

If the visitor wants a person, the platform checks who's actually available, picks the right rep, and rings every device that rep owns at once — the first one to respond gets the chat, and the notification vanishes everywhere else. The rep opens the chat already knowing everything the AI discussed, where the visitor came from, and how qualified they are. They close the deal, or set up the next step, and the whole thing is captured as a lead — enriched, exportable, ready for follow-up.

Meanwhile, credits are metering fairly and transparently, invoices are generating themselves, the site is quietly re-checking itself for updates every week, and every night the entire day's money is reconciled against the books automatically. If a payment ever fails, the business gets a friendly grace period and a one-click fix — and even if things lapse entirely, nothing is lost; it's just paused, ready to come back exactly as it was.

That's OyeChats: a website turned into a knowledgeable salesperson, a conversation turned into a qualified lead, a lead handed to the right human at the right moment — running itself, safely, around the clock.
