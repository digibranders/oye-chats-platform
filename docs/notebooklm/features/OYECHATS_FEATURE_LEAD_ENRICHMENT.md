# OyeChats Feature — Lead Enrichment (Email Verification + Company Lookup)

*Self-contained NotebookLM knowledge source on ONE feature: how OyeChats turns an anonymous website visitor into an enriched, exportable lead record. Evidence tiers: [T1] = confirmed directly in current code, [T2] = confirmed in code comments/docs referenced by code, [VERIFY] = stated but not independently re-confirmed here.*

---

## 1. What This Feature Is

When someone chats with an OyeChats AI Agent and leaves an email address, OyeChats automatically enriches that raw contact into a fuller lead record — without asking the visitor a single extra question. Two independent signals feed this:

1. **IP-based company & network signal** — resolves what company (if any) plausibly owns the visitor's network, plus VPN/proxy/Tor risk flags. [T1, `api/app/services/ip_intel_service.py`]
2. **Email verification & company-domain resolution** — checks whether the email address is real and deliverable, and if it's a business address, resolves the company behind that domain (name, description, logo). [T1, `api/app/services/reoon_service.py`, `email_domain_service.py`, `company_profile_service.py`]

Both run silently, in the background, on infrastructure the visitor never sees.

---

## 2. Who Cares & Why

- **Sales/ops teams** get a lead that already shows "who is this, and can I actually reach them?" instead of a bare email string.
- **Business owners** avoid wasting outreach credits/time chasing addresses that will bounce.
- **Marketing teams** get a cleaner picture of which companies are actually engaging with the site.

Plan gating is two-tiered: [T1, `api/app/services/plan_entitlements_service.py`]
- **Email verification itself** (the Reoon check powering both the widget's live blur-check and the background lead check) is gated to the **Standard and Professional** plans — Free and Starter skip the Reoon call entirely rather than paying for a check they can't act on.
- **The full "Network & risk" enrichment display** — IP/company signal, the email-validity badge, and the manual "Send follow-up" button — is gated narrower, to **Professional only**. On Free/Starter/Standard the section renders as a locked upsell teaser rather than partial data (`VisitorIntelligenceSection.tsx`'s `LockedTeaser`).

---

## 3. How It Actually Works

### 3a. IP → company/network signal
- Every visitor's IP is looked up via ipapi.is. [T1]
- The vendor classifies the IP range as `business | hosting | isp | education | government`. Only `business`, `education`, and `government` ranges are treated as "somewhere a person could actually be employed" — hosting and ISP ranges are excluded even if the vendor's own label calls them a company name. [T1]
- A second, independent filter checks whether the *name itself* looks like an employer rather than network infrastructure — rejecting things like "TSBB pool2" or generic ISP-pool labels, and rejecting a hand-curated list of consumer carrier brands (Airtel, Comcast, Vodafone, etc.) even when they show up on a `business`-typed range. This exists because production testing found IP resolution alone produced **zero usable company names out of 10 real lookups** — 9 consumer ISPs and 1 subnet label. [T1, code comment with measured evidence]
- The two checks (range type + name plausibility) are both required — either alone lets bad data through.
- Risk flags — VPN, proxy, Tor, datacenter — are surfaced alongside the company signal, and the dashboard visibly warns "company signal is unreliable" when a VPN/proxy is detected. [T1]

### 3b. Email verification
- Every captured email is run through Reoon's *power mode* email verification (not the cheaper "quick mode" — a live accuracy test found quick mode wrong on 3 of 11 checks, including a false positive on a known-invalid address; power mode costs the same). [T1]
- The result feeds a **shared "obviously undeliverable" check** used identically in two places: the widget's real-time validation as the visitor types, and the background enrichment that persists to the lead record. Keeping these identical matters — the two used to disagree, and a lead the widget accepted could then never be emailed. [T1]
- Deliberately **does not** gate on Reoon's own `is_safe_to_send` flag, because that flag is `False` for any catch-all mail server — which describes plenty of legitimate corporate mail setups, not just bad addresses. Gating on it would have wrongly rejected real B2B leads. [T1]
- An address is only flagged bad ("obviously undeliverable") for concrete reasons: invalid syntax, disposable-address service, spam-trap, an explicit "invalid" verdict, or a mail server that doesn't accept mail. [T1]
- The result is stored as a **three-state value**, not true/false: `True` = validated deliverable, `False` = confirmed bad, `None`/unknown = "never checked" (Reoon was unreachable, the plan doesn't include validation, or the lead predates this feature). [T1, `LeadInfo.is_valid_email`, nullable boolean]
- If Reoon itself is unreachable, the system fails open — it never blocks or mislabels a real visitor because of an OyeChats-side outage. [T1]

### 3c. Company-domain resolution (from the email)
- The domain half of the email address is checked against a maintained list of ~93 free/personal email providers (Gmail, Yahoo and its many country variants, Outlook/Hotmail/Live and their variants, iCloud, ProtonMail, GMX, Mail.ru, QQ, Naver, Rediffmail, Zoho, and more) — if it matches, no company lookup is attempted; a personal address doesn't identify an employer. [T1, `email_domain_service.py`]
- Deliberately conservative in the other direction too: a couple of domains that *look* like consumer webmail (e.g. `sify.com`, `indiatimes.com`) are intentionally excluded from the free-provider list because they're also live corporate domains for real companies — the code comments explicitly warn that a wrong entry here silently drops a real company's leads.
- For a genuine business domain, OyeChats resolves it to a company profile: name, description, and logo. This is **cached cross-tenant by domain** (one resolution serves every customer who later sees a lead from that domain), with the site's own declared identity (schema.org markup, `og:site_name`) preferred over an LLM guess, and an LLM call only spent when the site declares nothing itself. [T1, `company_profile_service.py`]
- Resolution failures are carefully split into "the target genuinely has nothing to show" (cached with growing backoff, up to 90 days) versus "our infrastructure failed" (short 15-minute cooldown, never blamed on the domain) — because wrongly blacklisting a real company's domain for 90 days due to an OyeChats-side outage would hide that company from every customer, not just one. [T1]

---

## 4. What It Looks Like

In the lead detail drawer (Leads page, Professional plan), a "Network & risk" section shows: [T1, `VisitorIntelligenceSection.tsx`]

- A company card (if resolved): company name, domain, and an explicit disclaimer — *"Derived from the visitor's network — not a confirmed employer"* — because the AI Agent never claims certainty it doesn't have.
- If no company name qualifies but a network operator is known, a plainer line: *"Connecting via [ISP/ASN name]"*.
- A VPN/proxy warning banner when applicable.
- An email deliverability badge: "Deliverable · [score]/100" (green), "Not confirmed deliverable" (red), or "Email not yet validated" (neutral) — reflecting the three-state value directly, never guessing.
- A "Send follow-up email" button that is always visible (never silently hidden), but disabled with an explanation when the address failed validation, and asks for one-click confirmation when the address was never checked.

On lower plans, this entire section is replaced by a locked teaser: *"Network signal & email validity are locked — Upgrade to Professional to see this and send a manual follow-up."*

---

## 5. A Real Scenario Walkthrough

1. A visitor from a mid-size logistics company chats with the AI Agent on the customer's website and asks a pricing question.
2. In the background, their IP resolves to a `business`-typed range with a plausible company name — it passes both the range-type check and the name-plausibility check, so it's shown (with the "not a confirmed employer" caveat).
3. Later in the conversation the visitor shares their work email, `priya@theirlogisticscompany.com`.
4. That email is verified by Reoon in power mode — valid syntax, not disposable, mail server accepts mail — and stored as `is_valid_email = True` with a deliverability score.
5. The email domain isn't a free provider, so it's resolved to a company profile — reusing a cached result if another OyeChats customer's lead already triggered a lookup for that same domain, or crawling the site's homepage for its declared name/logo if not.
6. The operator opens the lead in the dashboard and sees: an IP-derived network signal, a "Deliverable · 92/100" badge, and the resolved company name — everything needed to act, with nothing overstated as certain.
7. The operator clicks "Send follow-up email" — it sends immediately, because the address is confirmed valid.

---

## 6. Capabilities vs Limits

**What this genuinely does:**
- Enriches *inbound* chat visitors who are already engaging with the AI Agent. It identifies who's already talking to you.
- Gives an honest, evidence-based read on deliverability and (where possible) company identity — deliberately choosing "say nothing" over "say something false" at every decision point in the code.

**What this does NOT do:**
- **It is not a cold-outbound prospecting or list-building tool.** It never looks up leads who haven't visited/chatted; it only enriches visitors who already showed up.
- **IP → company resolution only works when the visiting company owns its own IP block.** Most visitors browse from a home ISP, mobile carrier, or VPN, none of which resolve to a usable company name — the code's own measured result was 0 usable names out of 10 real lookups before filtering was tightened, and the filtering exists specifically to suppress the resulting false positives, not to guarantee a high hit rate. Treat IP-based company identification as an occasional bonus signal, not a dependable feature of every conversation.
- **No deliverability/accuracy percentage should be quoted** (e.g. "99% accurate email verification") — none exists in the source material; only the specific power-mode-vs-quick-mode comparison (3/11 wrong for quick mode) is evidenced, and that's about mode selection, not overall accuracy.
- The email-validity badge and network signal are both explicitly hedged in the UI itself ("not a confirmed employer", three-state validity) — that honesty should be preserved rather than flattened into a confident claim.
- This is a **paid-plan feature with a two-tier boundary**: email verification runs on Standard and Professional; the full enrichment display (IP/company signal, validity badge, follow-up button) is Professional-only. Do not depict any part of it as available on Free or Starter, and do not collapse the two gates into one plan name.

---

## 7. Evidence & Open [VERIFY] Items

- All mechanics above are confirmed directly in current code as of this writing: `reoon_service.py`, `ip_intel_service.py`, `company_profile_service.py`, `email_domain_service.py`, `domain_normalizer.py`, `plan_entitlements_service.py` (gating logic, functions `is_visitor_intelligence_enabled_for_bot` and `is_email_validation_enabled_for_bot`), `VisitorIntelligenceSection.tsx` (UI, `app/src/features/leads/`).
- The "0 usable company names out of 10 real lookups" and "3 of 11 quick-mode results wrong" figures are pulled directly from code comments citing a specific internal test/plan document (`docs/superpowers/plans/2026-08-08-visitor-intelligence.md`); the underlying plan document itself was **not** independently re-read for this doc — treat the figures as [T2], sourced via code comment rather than the primary document.
- Plan-gating is now directly confirmed in `plan_entitlements_service.py`: `EMAIL_VERIFICATION_SLUGS = {"standard", "professional"}` gates the Reoon check itself; `VISITOR_INTELLIGENCE_SLUGS = {"professional"}` gates the IP/company signal, the validity badge, and the follow-up button, plus grants the feature to any bespoke (non-seeded) paid plan slug. This supersedes any earlier assumption of a single "Professional-only" boundary for the whole feature.
- The free-email-provider list in `email_domain_service.py` currently holds ~93 entries (counted directly from source), not "100+" — corrected in this pass.
- No customer testimonial, case study, or numeric "leads enriched" / "reply rate" statistic exists anywhere in the inspected source — do not invent one.
