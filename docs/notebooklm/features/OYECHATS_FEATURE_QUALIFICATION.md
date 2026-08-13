# OyeChats Feature — Lead Qualification

*Part of the OyeChats NotebookLM knowledge package. This single document is written to be a sufficient, standalone knowledge source on ONE feature: silent, background sales-readiness scoring.*

Evidence tiers used below: **[T1]** = confirmed directly in source code this pass · **[T2]** = confirmed in existing product documentation · **[MARKETING CLAIM — VERIFY IMPLEMENTATION]** = stated in marketing material, not independently re-verified here · **[VERIFY]** = open question, not resolved in this pass.

---

## 1. What This Feature Is

Every conversation a visitor has with the OyeChats AI is silently scored for sales-readiness in the background — using the business's chosen sales framework (BANT, MEDDIC, CHAMP, or GPCTBA+C&I) — so the team can see, at a glance, which visitors are worth a human's time and which are still just browsing. **[T1]**, confirmed in `api/app/services/qualification_service.py` and `api/app/services/rag_service.py`.

## 2. Who Cares & Why

- **Business owners / sales leads:** stop treating every chat as equal. A visitor who reveals urgent need, budget, and decision authority should surface differently than one who's just poking around.
- **Sales teams:** get a pre-scored, tiered lead list instead of a flat inbox — time goes to the visitors most likely to buy.
- **Operators taking a live handoff:** inherit a visitor who already has a qualification score and evidence trail, not a cold conversation. **[T2]**, consistent with the live-handoff framing in the existing marketing/master-knowledge docs.

## 3. How It Actually Works

**Four supported frameworks, chosen per bot** — confirmed directly in `PRESET_FRAMEWORKS` in `qualification_service.py`: **[T1]**

| Framework | Dimensions scored |
|---|---|
| **BANT** | Need, Timeline, Authority, Budget |
| **MEDDIC** | Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion |
| **CHAMP** | Challenges, Authority, Money, Prioritization |
| **GPCTBA+C&I** | Goals, Plans, Challenges, Timeline, Budget, Authority, Consequences |

Each dimension has weighted scoring options (e.g. BANT's "Budget" ranges from "No budget yet" = 5 points to "$20K+/mo" = 25 points). A **composite score (0–100)** is calculated from whichever dimensions are enabled, normalized against their weights — not a raw point sum. That composite maps to a **tier**: `unqualified` → `mql` (≥30) → `sal` (≥55) → `sql` (≥75). These exact threshold numbers are the shared default across all four frameworks. **[T1]**

**Scoring happens silently, in the background, after every message** — not as a blocking step in the visitor's conversation. A fire-and-forget extraction step (`_background_bant_extraction` in `rag_service.py`) runs once the AI's answer has already streamed back to the visitor: an LLM reads the conversation and infers qualification signals (e.g. "we need this live by next month" → a Timeline signal) without the visitor ever being asked a direct qualification question. **[T1]**

**Interactive qualification chips ("pill" questions like "What's your budget range?") default OFF for every single dimension, in every one of the four frameworks — with no exception.** This is confirmed directly in the source code, not just documentation: a code comment (tagged `BR-04`) explicitly states the rationale — interrogative pill prompts read as "qualification fishing" to modern B2B visitors, and the team aligned this default with how Drift, Intercom Fin, and HubSpot behave. Background LLM extraction still scores the dimension even with the chip off; the visitor simply never sees an intrusive prompt. A business can still flip individual dimensions on per-bot from the admin Qualification settings if they want the more interrogative flow. **[T1] — this closes a previously open [VERIFY] item from the source-of-truth doc, which had only confirmed this behavior via product documentation, not the raw service code.**

**Evidence is never silently thrown away.** Every extracted signal is written to an append-only audit table (`BANTSignal`) — even when it doesn't beat the current best score for that dimension — so operators can see the *depth* of qualification (a visitor who mentioned urgent need six times vs. once), not just the final number. The score itself follows a "never-downgrade" rule: a weak follow-up answer cannot drag down a strong earlier signal, only a stronger one can raise it. **[T1]**

**Crossing into "SQL" (sales-qualified lead) tier triggers two real, code-confirmed actions** (not just a UI badge change):
1. An email notification to the business's designated recipients, if the bot has `email_on_qualified` turned on. **[T1]**
2. An outbound webhook (`tier_transition` event) carrying the session ID, old tier, new tier, and score — for businesses piping leads into their own CRM/automation. **[T1]**

## 4. What It Looks Like

- A per-conversation qualification **score and tier badge** (e.g. "SQL · 82") visible wherever a lead/conversation record is shown in the dashboard.
- A **framework picker** in the bot's qualification settings, letting a business choose BANT / MEDDIC / CHAMP / GPCTBA+C&I and toggle individual dimension chips on or off.
- An **evidence trail** per dimension (what the visitor said, what score it produced) available to whoever reviews the lead.
- *[VERIFY]:* the exact current dashboard screen names/layout for this are not independently confirmed against a live screenshot in this pass — the admin dashboard is mid-rebuild (Admin 2.0). Treat specific on-screen navigation text as unconfirmed.

## 5. A Real Scenario Walkthrough

A visitor lands on a business's website and opens the chat. They ask a product question — the AI answers it, grounded in the business's own content. A few messages later, they mention: *"We need this rolled out company-wide by next quarter, and I'm the one who signs off on the budget."* Nothing about the conversation *feels* like an interrogation — there was no pill question, no "please rate your budget" prompt. But in the background, the extraction step reads that message, recognizes an Authority signal and a Timeline signal, scores them, and updates the conversation's composite score. The score crosses the SQL threshold. The business's sales lead gets an email. A webhook fires to their CRM. When a human operator later opens that conversation for a live handoff, they see the tier, the score, and exactly which statements the visitor made that earned it — no cold start. **[T1] mechanics, illustrative scenario, not a real transcript.**

## 6. Capabilities vs. Limits

**Does:**
- Scores every conversation silently and continuously, message by message.
- Supports four distinct, industry-standard sales frameworks, chosen per bot.
- Preserves a full evidence trail, not just a final number.
- Triggers real notifications (email + webhook) on reaching sales-qualified status.

**Does NOT do:**
- **Does NOT rapid-fire interrogate visitors with a quiz of qualification questions.** The default experience has zero qualification chips — a chatbot bombarding a visitor with "What's your budget?" / "What's your timeline?" pop-ups is explicitly the opposite of how the product is configured out of the box.
- Does **not** cite any ROI, conversion-rate, or revenue figure — no such number exists in any source material inspected for this package. Never invent one.
- Does not replace a human closing the deal — qualification identifies *who* is ready; a person on the business's team still does the closing (see the live-handoff feature doc / master knowledge doc for that boundary).

## 7. Evidence & Open [VERIFY] Items

- **[T1]** All four frameworks, their dimensions, weights, and default `cta_enabled: False` — `api/app/services/qualification_service.py`, `PRESET_FRAMEWORKS`, code comment tagged `BR-04`.
- **[T1]** Silent background scoring, fire-and-forget extraction, never-downgrade rule, append-only `BANTSignal` audit log — `api/app/services/rag_service.py`, function `_background_bant_extraction`.
- **[T1]** Tier thresholds (mql 30 / sal 55 / sql 75) and composite-score normalization — `qualification_service.py`, `calculate_composite_score`, `get_tier`.
- **[T1]** SQL-tier email notification (gated on `bot.email_on_qualified`) and `tier_transition` webhook — `rag_service.py`, same function, lines confirming `send_qualified_lead_email` and `fire_webhook` calls.
- **[VERIFY] — RESOLVED this pass:** whether chips are truly off by default across all frameworks was previously "confirmed via product documentation, not re-verified against raw `qualification_service.py`" per the existing `OYECHATS_SOURCE_OF_TRUTH.md`. Direct code inspection in this pass confirms it unambiguously for all 4 frameworks and every dimension.
- **[VERIFY] — still open:** exact current admin dashboard screen/label for qualification settings and lead score display — not confirmed against a live screenshot; the admin dashboard is mid-rebuild under the Admin 2.0 mandate, so `app/src/pages/Qualification.jsx` is a technical/logic reference only, not a confirmed current UI reference.
