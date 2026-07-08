# OyeChats Platform — BANT/Qualification System Review

**Scope:** `qualification_service.py`, `lead_service.py`, `behavioral_service.py`, the BANT-extraction path in `rag_service.py`, `BANTSignal`/`ChatSession` schema, the qualification CTA pill (widget + admin), `analytics_routes.py`, `operator_routes.py`, `bot_routes.py`, and the admin `Qualification.jsx` configurator.
**Method:** Full-file code read of every qualification code path, cross-referenced against every production caller (`grep` for every consumer of each scoring function), plus targeted live web research on 2026 B2B qualification-framework practice to sanity-check product decisions against the market.
**Lens:** Senior engineering correctness/architecture review + senior B2B marketing/sales-ops review of what the scores actually mean to a customer's sales team.
**Posture:** Adversarial. Verdicts are not softened for morale.

---

## 1. Executive Summary

### The product idea is good. The implementation has a load-bearing bug that breaks it for most of the market it's aimed at.

OyeChats' qualification system is genuinely well-designed **as a concept**: a single visitor-facing chat surface that quietly runs LLM-based signal extraction in the background (`extract_qualification_signals`), maps free-text statements to a scoring rubric, and lets each customer pick the sales framework that fits their deal size — BANT for transactional/low-ACV, MEDDIC for complex enterprise, CHAMP for consultative mid-market, GPCTBA+C&I as a superset. This is not a naive design: it mirrors what 2026 B2B sales-ops research actually recommends (see §4) — different deal sizes genuinely warrant different frameworks, and forcing every customer into one four-letter acronym is a known anti-pattern. The decision to default budget/timeline "pill" questions **off** for the BANT preset, with scoring inferred silently from conversation text instead, is directly aligned with what Drift/Intercom/HubSpot do today and is correctly documented in-code as such.

The problem is that **only the BANT framework's scoring is actually wired into every downstream system that reads it.** MEDDIC, CHAMP, and GPCTBA+C&I are fully exposed in the admin UI (`Qualification.jsx`'s "Scorecard" tab lets a customer pick any of the four, edit weights, and save), fully accepted by the API (`bot_routes.py` PATCH), and the extraction LLM *does* correctly score their dimensions into `dimension_scores` JSONB. But the composite score/tier that every other surface in the product reads — the Leads dashboard, the operator console's sort order, the analytics MQL/SAL/SQL funnel, and the tier-transition email/webhook trigger — is computed by summing exactly four hardcoded columns (`bant_need_score + bant_budget_score + bant_authority_score + bant_timeline_score`) that only the BANT preset ever writes to. **A customer who picks MEDDIC will see every one of their leads stuck at score 0, tier "unqualified," forever** — not because extraction failed, but because the number it extracted is written to a field nothing else reads (§2, BR-01). The one function that computes the score *correctly* for any framework (`qualification_service.calculate_composite_score`) has zero production callers anywhere in the codebase — it is reachable only from its own test file.

The second major finding compounds the first from a UX angle: the "one-tap qualification" pill — the exact mechanism meant to be the *reliable, low-latency, zero-ambiguity* alternative to free-text extraction — is not actually deterministic. A pill tap just resends the button's label text through the ordinary chat pipeline, so it's scored by the same probabilistic LLM extraction as anything a visitor types, with the same cost and the same failure modes. Two of the five default Budget-tier button labels are short enough to be silently dropped entirely by an unrelated cost-saving heuristic (§2, BR-02) — meaning a subset of visitors who do exactly what the product asks them to do (tap a button) get **zero** qualification signal recorded, silently.

Both findings are the kind that pass every existing test (extraction tests mock the LLM and assert on `dimension_scores`, not on what the dashboard shows) and would only surface via a customer complaint: "I switched to MEDDIC and now all my leads show 0."

### Top findings by impact

| Rank | ID | Severity | Issue | Why it matters |
|---|---|---|---|---|
| 1 | BR-01 | **Critical** | Non-BANT frameworks (MEDDIC/CHAMP/GPCTBA+C&I) are fully exposed but functionally broken end-to-end | Every lead-facing surface (dashboard, operator console, analytics funnel, tier-transition emails/webhooks) reads a score that never gets written for these frameworks — silently makes 3 of the product's 4 advertised frameworks non-functional |
| 2 | BR-02 | High | Qualification CTA pill clicks aren't deterministic — routed back through free-text LLM extraction, and 2/5 default Budget button labels are silently dropped by a length heuristic | Undermines the flagship "one-tap qualification" mechanic; some visitors get zero signal for doing exactly what's asked of them |
| 3 | BR-03 | Medium-High | No operator-facing correction/reset path for a mis-scored lead; never-downgrade + no decay on budget/authority makes an error (or adversarial input) permanent | One ambiguous or bad-faith statement can permanently misclassify a lead with no fix short of direct DB editing |
| 4 | BR-04 | Medium | Non-BANT presets default several intrusive qualification pills to **on**, inconsistent with the platform's own stated (and correct) low-friction design principle for BANT | Customers who pick MEDDIC/CHAMP/GPCTBA+C&I get a more interrogative visitor experience than the platform's own docs/comments say it's trying to avoid |
| 5 | BR-05 | Low-Medium | `decay` logic is hardcoded to the `need`/`timeline` keys only; silently a no-op for every non-BANT framework | Same root cause as BR-01 (framework-name hardcoding) surfacing in a third place |

---

## 2. Findings

### BR-01 — Critical — Non-BANT qualification frameworks are exposed but functionally dead in every downstream consumer

**Where:**
- `api/app/services/rag_service.py:2050-2059` (`_background_bant_extraction`) — composite score computed as `bant_need_score + bant_budget_score + bant_authority_score + bant_timeline_score`, four hardcoded columns.
- `api/app/services/lead_service.py:101-105` (`calculate_lead_score`), `:125-133` (`count_dimensions_assessed`), `:180-230` (`build_lead_response`) — every one reads only `session.bant_{need,budget,authority,timeline}_score`, with zero reference to `dimension_scores` or the bot's actual `framework`.
- `api/app/api/analytics_routes.py:52,87-89` — MQL/SAL/SQL funnel counts filter on `ChatSession.bant_tier` directly.
- `api/app/api/operator_routes.py:1470-1486,1552,1605-1622` — operator console displays and **sorts leads by** `ChatSession.bant_score`/`bant_tier` directly.
- `api/app/services/qualification_service.py:362-423` (`calculate_composite_score`, `build_qualification_response`) — the only framework-aware, weighted scoring implementation in the codebase. Confirmed via `grep -rn` across `api/app` (excluding tests): **zero production callers.** The only other importer is `rag_service.py`, and only for `get_framework_config`/`get_tier` — not `calculate_composite_score`.
- `api/app/api/bot_routes.py:1469-1481` and `app/src/pages/Qualification.jsx` — framework selection (`bant`/`meddic`/`champ`/`gpctba_ci`) is a first-class, fully wired admin feature, not an experimental flag.

**The mechanism:** `extract_qualification_signals` is genuinely framework-aware — it builds its rubric prompt from whatever dimensions the bot's active framework config defines (`metrics`, `economic_buyer`, `decision_criteria`, `champion`, etc. for MEDDIC), and the extraction LLM correctly scores them into the framework-agnostic `dimension_scores` JSONB column (`rag_service.py:2045`, `dimension_scores[dim] = {...}`). This part works.

But immediately after, the *composite* score (`chat_session.bant_score`) and *tier* (`chat_session.bant_tier`) — the two fields every other part of the product actually displays or filters on — are recomputed from a `score_field_map` that only contains the literal keys `need`, `timeline`, `authority`, `budget` (BANT's own dimension names). For a MEDDIC bot, none of `metrics`/`economic_buyer`/`decision_criteria`/`decision_process`/`identify_pain`/`champion` match that map, so `bant_need_score` etc. never get written, `chat_session.bant_score` stays `0`, and `get_tier(0, ...)` always returns `"unqualified"`.

**Failure scenario:** A customer configures a bot for MEDDIC (a legitimate, product-advertised choice for their enterprise sales motion). Every visitor conversation correctly extracts MEDDIC signals into `dimension_scores` — verifiable in the raw DB. But:
- The Leads dashboard (`build_lead_response`) shows every single lead at score `0`, tier `unqualified`, `dimensions_assessed: 0` (also computed from the same four hardcoded columns, `lead_service.py:125-133`).
- The operator console's live-chat qualified-lead sort (`operator_routes.py:1552`, `ORDER BY bant_score DESC`) never surfaces anyone.
- The super-admin/customer analytics funnel (`analytics_routes.py:87-89`) reports 0% MQL/SAL/SQL for that bot, forever.
- `email_on_qualified` notifications and the `tier_transition` webhook (`rag_service.py:2071-2112`) never fire, because `new_tier` is always `"unqualified"` (`old_tier != "unqualified"` never becomes true).

From the customer's perspective this looks exactly like "the AI isn't qualifying my leads" — the single core value proposition of the product — for the specific customer segment (complex enterprise deals) the platform's own framework marketing is targeting.

**Fix:** Replace the hardcoded four-column recompute in `_background_bant_extraction` with a call to the already-correct `qualification_service.calculate_composite_score(dimension_scores, framework_config)`, and store the *displayed* tier from `qualification_service.get_tier`. Then either (a) keep the four legacy `bant_*` columns as a BANT-only convenience/back-compat view, clearly documented as such, or (b) migrate `lead_service.build_lead_response`/`operator_routes` sort/`analytics_routes` funnel to read the framework-aware composite (`dimension_scores` + `calculate_composite_score`) uniformly for every framework — recommended, since (a) just relocates the same bug. This is the single highest-leverage fix in this review: it makes 3 of the platform's 4 advertised frameworks actually work.

---

### BR-02 — High — Qualification CTA pills aren't a deterministic scoring path, and some default options are silently dropped

**Where:**
- `widget/src/components/QualificationCTA.jsx` — the pill/chip UI.
- `widget/src/components/ChatWindow.jsx:2221-2224` — `onSelect={(option) => { setActiveCTA(null); handleSend(null, option); }}`.
- `widget/src/components/ChatWindow.jsx:938-968` (`handleSend`) — sends `option` as an ordinary user chat message with no dimension/CTA metadata attached.
- `api/app/db/models.py:554` — `BANTSignal.source` column, documented `# llm|cta_click`. Confirmed via `grep -rn "cta_click"` across the entire `api/` tree: **the value `cta_click` is never written anywhere.** The column exists to record a distinction the code never makes.
- `api/app/services/rag_service.py:1670-1687` (`_should_skip_bant_extraction`) — skips extraction outright when `len(question.strip()) < 10`.
- `api/app/services/qualification_service.py:64-76` — BANT preset's default Budget options include `"$1K-5K/mo"` (9 chars) and `"$20K+/mo"` (8 chars).

**The mechanism:** When a visitor taps a qualification pill (e.g., "$20K+/mo"), the UI does not call any structured "record this exact rubric answer" endpoint. It just calls `handleSend(null, "$20K+/mo")`, which is indistinguishable from the visitor having typed that string. That message then goes through the normal pipeline into `extract_qualification_signals` — a probabilistic LLM re-interpretation of what should be a 100%-certain, already-known answer (the button *is* the rubric option; there's nothing to "extract"). This spends an LLM call re-deriving information the frontend already had in hand, with a small but real chance the extraction model scores it against the wrong tier or drops it as ambiguous.

Worse, before that LLM call even runs, `_should_skip_bant_extraction` short-circuits any message shorter than 10 characters — a cost-saving heuristic aimed at greetings/fillers ("hi", "ok", "thanks"). Two of the five default Budget pill labels are shorter than that floor:
- `"$1K-5K/mo"` → 9 characters → **skipped**
- `"$20K+/mo"` → 8 characters → **skipped**

A visitor who taps either of those two buttons — again, doing exactly what the product's own UI asked them to do — produces **zero** BANT signal. Not a mis-scored one; none at all. This is silent and easily reproducible (it's a pure string-length check, not a probabilistic model behavior).

**Fix:**
1. Give the CTA pill click a dedicated, deterministic path: when `option` originates from an active CTA (the frontend already knows `cta.dimension` and the exact rubric entry it corresponds to), send it as a structured payload (`{cta_dimension, cta_option}` alongside/instead of free text) and score it directly from the known rubric entry — no LLM round-trip, no ambiguity, and it's the `source: "cta_click"` case the schema already anticipated.
2. Independent of #1, `_should_skip_bant_extraction`'s length floor should not apply to any message that is a verbatim CTA option string — or, as a minimal patch, lower/remove the floor when the message came from an active CTA context (the backend already receives `cta` state in the request in most such flows — verify and thread it through if not).

---

### BR-03 — Medium-High — No correction path for a mis-scored or adversarially-scored lead

**Where:** `rag_service.py:2024-2037` (never-downgrade rule), `lead_service.py:136-177` (`apply_display_decay` — only reduces `need_score`/`timeline_score`, never `budget_score`/`authority_score`, and only for display, never persisted). No `operator_routes.py`/`lead_routes.py` endpoint sets `bant_*_score`/`dimension_scores` downward.

**The mechanism:** The never-downgrade rule (`if new_score <= current_score: continue`) is a defensible design choice on its own — it stops a wishy-washy follow-up from erasing a strong earlier signal, and the code comments show this was a deliberate, previously-debugged decision. But combined with (a) no decay at all on budget/authority scores, and (b) no operator-facing way to manually correct or reset a dimension's score, the net effect is that **any single high-scoring statement is permanent for the life of the session** — whether it was a genuine signal, an LLM extraction false positive, or a visitor (or a competitor doing recon) intentionally typing "we have a $50k/month budget approved" to see what happens. There is no automatic decay to catch it, and no manual override to fix it — the only remedy is direct database editing.

**Failure scenario:** A single ambiguous or bad-faith message permanently classifies a session as SQL-tier. If `email_on_qualified` is enabled, a sales rep gets a "hot lead" notification and a webhook fires to whatever CRM automation is downstream, for a lead that never should have qualified — the opposite of what a qualification system exists to prevent, and a real cost to sales-team trust in the product's scoring.

**Fix:** Add an operator/admin-facing "reset dimension" or "override tier" action (even a simple `PATCH` on a session's `dimension_scores`/`bant_*` fields, audit-logged like `BANTSignal` already is), and consider extending decay to budget/authority on a longer window (they're inherently more time-durable signals than need/timeline, so decay should be slower, not absent).

---

### BR-04 — Medium — Non-BANT presets default several qualification pills to "on," contradicting the platform's own stated low-friction design principle

**Where:** `qualification_service.py:81-319`. The BANT preset (`PRESET_FRAMEWORKS["bant"]`) explicitly sets `need.cta_enabled = False` and `timeline.cta_enabled = False`, with in-code comments citing Drift/Intercom/HubSpot precedent for why intrusive qualification pills hurt conversion. The MEDDIC, CHAMP, and GPCTBA+C&I presets do not follow this — several of their dimensions (`metrics`, `economic_buyer`, `identify_pain`, `champion` in MEDDIC; `challenges`, `prioritization` in CHAMP; `goals`, `challenges`, `timeline`, `consequences` in GPCTBA+C&I) default `cta_enabled: True`.

**Why it matters (marketing lens):** The web research in §4 confirms the platform's own reasoning for disabling BANT's pills is current best practice — long/interrogative multi-field flows measurably hurt conversion, and background/silent extraction is the 2026-recommended pattern. There's no equivalent rationale in the code for why MEDDIC/CHAMP/GPCTBA+C&I customers should get a more chip-heavy, interrogative visitor experience by default — it reads as an oversight (the presets were likely authored independently) rather than an intentional decision. A customer picking MEDDIC because their deal size warrants it will, by default, get a visibly more "salesy" chat experience than a BANT customer, for no product reason.

**Fix:** Default `cta_enabled: False` uniformly across all four presets, consistent with the BANT preset's already-correct reasoning, and let customers opt back into the interrogative flow per-dimension from the admin UI (the toggle already exists and works).

---

### BR-05 — Low-Medium — `decay` logic is hardcoded to BANT's dimension names, silently a no-op for other frameworks

**Where:** `lead_service.py:136-177` (`apply_display_decay`) reads `session.bant_need_score`/`session.bant_timeline_score` by name and decays only those two keys. For a MEDDIC/CHAMP/GPCTBA+C&I bot, this function still runs (called from `build_lead_response` unconditionally) but has nothing meaningful to decay, since (per BR-01) those columns are never populated for non-BANT frameworks anyway. Once BR-01 is fixed, this becomes a second instance of the same "BANT-only" hardcoding pattern surfacing — `apply_display_decay` should generalize over `framework_config`'s actual dimension list the same way `qualification_service._dimension_keys` already does, rather than naming `need_score`/`timeline_score` literally.

**Fix:** Fold decay into the framework-aware fix for BR-01 — decay should be computed over whichever dimensions the active framework config marks with `decay`-eligible flags (or simply apply per-dimension, not per-hardcoded-name), rather than reading two literal column names.

---

## 3. What's Actually Good Here (don't regress these while fixing the above)

- **The signal-extraction prompt itself** (`rag_service.py:1775-1872`) is unusually disciplined: explicit statement-vs-question distinction, present-tense-vs-hypothetical modality checks, a documented default-to-no-signal bias, and per-dimension positive/negative few-shot examples. This is materially better prompt engineering than most "extract BANT from chat" implementations, and it correctly treats "connect me to a human" as a routing action, not a need signal — a genuinely common false-positive class in similar systems.
- **The append-only `BANTSignal` audit log persists every signal, even ones that lose to never-downgrade** (`rag_service.py:2004-2022`) — so a human reviewing a lead's history sees every mention, not just the "winning" score. This is a good transparency decision that the fixes above should preserve.
- **Per-bot rubric customization** (weights, option labels/scores, thresholds) via `bant_config` JSONB with deep-merge over presets is a clean, extensible design — the bug is entirely in the downstream *consumption* of the scores it produces, not in the configuration model itself.
- **Cost-conscious model routing** (`_bant_model()` uses the cheap gate-tier model, not the primary generation model) and the **10-character/routing-intent pre-filter** (`_should_skip_bant_extraction`) are sound cost controls in principle — BR-02 is about the *specific* interaction between that filter and CTA-originated short strings, not the filter's existence.
- **Behavioral scoring** (`behavioral_service.py`) is a well-scoped, capped (`max_score: 20`), additive signal (return visits, UTM presence, referrer quality, engagement depth) layered cleanly on top of the qualification score — a reasonable "intent" complement to "fit."

---

## 4. Market/Framework Research Notes (grounding for §1–2's marketing-lens claims)

- **Budget-question friction is a real, well-documented conversion cost** in 2026 conversational-qualification practice: every additional required field materially reduces submission rates, and the recommended pattern is exactly what the BANT preset already does — infer budget/timeline silently from conversation rather than a mandatory upfront pill. This validates the codebase's own design comment, and is the reason BR-04 (inconsistent defaults across presets) is worth fixing rather than dismissing as cosmetic.
- **Framework choice by deal size is current consensus, not a stretch feature**: BANT end-to-end for sub-$25K ACV, CHAMP at the top-of-funnel/SDR layer with light MEDDIC at the AE layer for mid-market, and full MEDDIC (with review at every pipeline stage) for $50K+ enterprise deals. OyeChats offering all four as a first-class per-bot choice is a legitimately good product decision — which is exactly why BR-01 is so costly: it turns a real competitive differentiator into a trap for the specific customers (higher-ACV, more sophisticated sales orgs) most likely to pick something other than plain BANT.
- **Execution consistency matters more than framework sophistication** — a poorly-executed MEDDIC implementation is explicitly called out in current sales-ops literature as worse than a well-executed BANT one. That is precisely the state BR-01 puts non-BANT customers in today: a sophisticated-looking framework selector backed by an engine that silently doesn't work.

Sources:
- [How AI Chatbots Improve Lead Generation & Conversion Rates](https://www.silvertouchinc.com/blog/ai-chatbots-lead-generation-conversion-rates/)
- [B2B Lead Qualification Framework: BANT vs CHAMP vs MEDDIC — Leads at Scale](https://leadsatscale.com/insights/b2b-lead-qualification-framework-bant-vs-champ-vs-meddic/)
- [B2B Lead Qualification Framework 2026: BANT, MEDDIC & Beyond](https://leadhaste.com/blog/b2b-lead-qualification-framework-2026)
- [BANT vs MEDDIC: Why You Run Both by Sales Stage](https://skipcall.io/en/blog/bant-vs-meddic)
- [Sales Qualification: BANT, MEDDIC & SPICED for B2B SaaS (2026)](https://nimitai.com/blog/sales-qualification-framework)

---

## 5. Suggested Fix Order

1. **BR-01** (Critical, ~M effort) — route the composite score/tier through `qualification_service.calculate_composite_score`/`get_tier` for every framework; this alone fixes the analytics funnel, operator sort, dashboard, and tier-transition notifications simultaneously since they all key off the same two fields.
2. **BR-02** (High, ~S-M effort) — thread CTA-originated answers through a deterministic scoring path instead of free-text re-extraction; exempt CTA-originated strings from the 10-character skip floor.
3. **BR-05** (Low-Medium, ~S effort, bundle with #1) — generalize `apply_display_decay` over the active framework's dimensions.
4. **BR-04** (Medium, ~S effort, config-only) — default `cta_enabled: False` uniformly across all four presets.
5. **BR-03** (Medium-High, ~M effort) — add an audited operator override/reset action for dimension scores.
