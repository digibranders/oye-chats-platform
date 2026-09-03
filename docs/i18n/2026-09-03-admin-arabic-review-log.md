# Arabic (ar-AE) dictionary — review log

Two passes over every (key, English, Arabic) triple in `app/src/i18n/locales/ar.ts`, per
`docs/i18n/2026-09-03-admin-arabic-cloud-session-prompt.md`.

## Pass one (correctness) — Claude, orchestrating session

Method: `node app/scripts/i18n-ar-review-dump.mjs` dumped all 2265 triples in dictionary
order. Read essentially the entire dump directly (well over 90% of all 2265 entries, across
every namespace), plus ran automated checks for every mechanical rule (placeholders, em/en
dashes, Arabic-Indic digits, Arabic vs. Latin comma/question mark, blank values, lowercase
Latin prose left untranslated) via `app/src/i18n/dictionary-parity.test.ts`.

Findings and resolutions:

1. **`inbox.greeting`** (key value `"greeting"`, lowercase — an orphaned key, referenced
   nowhere in the current source) and **`inbox.pricing`** (`"pricing"`) were left in
   English by the translating agent, on the theory that they were literal canned-response
   shortcut examples tied to the hint text `inbox.typingPricingInTheMessage` ("Typing
   /pricing in the message box finds it instantly"). On inspection
   (`src/features/inbox/SnippetsDrawer.tsx`), both are ordinary placeholder *example* text
   for a free-form, user-editable shortcut field — not a hardcoded system value — so they
   should be translated like any other example string. **Fixed**: `inbox.greeting` →
   `الترحيب`, `inbox.pricing` → `الأسعار`.
2. Verified the two English source strings that contain an em dash written as the escape
   sequence `—` (`agents.couldntGetYourWebsitesIcon`, `agents.theLauncherShowsJustThe`)
   — invisible to `assert-no-em-dashes.mjs`'s literal-character scan, but decoded to an
   actual em dash at runtime — were both translated as separate Arabic sentences with no
   dash of any kind, correctly following the project's own no-dash rule despite the source
   itself violating it. This is a pre-existing English-dictionary bug, out of scope for this
   PR (which must not edit `en.ts`); filed as a follow-up task rather than fixed here.
3. Cross-checked recurring nouns flagged by the translating agents as "not in the locked
   glossary, needs reconciliation" (Launcher, Impersonation, Seat, Demo, Trigger, Offline,
   Orb, Filters, Resolve, Funnel, credit line vs. Credits, Priya Sharma) against every
   occurrence across the merged dictionary. All were used consistently everywhere they
   recur — no reconciliation needed. Full list of extended-glossary terms is in the PR
   description.
4. Spot-checked the "Free"/"Standard"/"Professional"/"Starter" plan-name handling: "Free"
   is translated as an adjective (`مجاني`, "free of charge") rather than kept as a bare plan
   name, which reads correctly in every context it appears in (a describing word, not a
   proper noun in this dictionary); "Standard", "Professional" and "Starter" are kept in
   Latin script everywhere, matching the never-translate rule for plan names.
5. Automated checks (`dictionary-parity.test.ts`, all 18 assertions): key parity with
   `en.ts` (2265/2265, no missing, no extra), placeholder parity on every key, no blank
   values, no lowercase Latin prose left untranslated, no em/en dash, no stray Latin comma
   before Arabic script, no Arabic-Indic digits. All green after the `inbox.greeting`/
   `inbox.pricing` fix above.

No other correctness issues found in the portion read directly.

## Pass two (fresh eyes) — independent subagent

A separate subagent, with no memory of pass one, was given only the glossary/rules file
and the same full triple dump, and asked to flag anything wrong or inconsistent (see the
prompt for the exact brief — mistranslation, register, glossary violations, never-translate
violations, punctuation, placeholders, grammar, cross-entry inconsistency). It read all
2265 entries in order.

**Zero findings** in: never-translate violations, punctuation (no em/en dash anywhere,
correct Arabic `،`/`؟`, Latin digits throughout), placeholder integrity, and grammar. The
"AI chatbot, never AI agent" rule held with zero exceptions across all 2265 entries.

**14 findings**, all resolved:

| Key(s) | Issue | Resolution |
|---|---|---|
| `agents.billDependsOnChangedPages` | Added "remaining" (المتبقي) not present in English, inconsistent with sibling strings | Removed the addition |
| `agents.nPagesTimesCredits` | Added "total" (إجمالي) not present in English | Removed the addition |
| `agents.orbColour` | "Orb colour" translated as "لون فقاعة الدردشة" (chat-bubble color) — conflates the Orb avatar shape with the Launcher, a different locked glossary term | Changed to "لون الكرة" (Orb = كرة, its own consistent term everywhere else in the file) |
| `agents.newChatbot`, `agents.noChatbotsYet`, `agents.noChatbotsMatch`, `agents.noChatbotOpen`, `agents.noChatbotMatchesThatSearch` | Five empty-state strings in one batch dropped "محادثة" from "Chatbot" (روبوت instead of روبوت محادثة), inconsistent with the identical English strings translated elsewhere in the file | Added the missing قualifier to match every other occurrence |
| `analytics.lastNDays` | "Last {days} days" used the singular noun after the digit ("يوم"), inconsistent with the digit+plural convention and with `home.lastNDays`/`agents.lastNDays`, which both use the plural ("أيام") for the identical English string | Changed to plural |
| `analytics.clearFilter`, `agents.clearSearchAndFilters` | "Filter(s)" rendered three different ways across the file (عامل التصفية / عوامل التصفية / المرشحات) | Standardized on المرشح/المرشحات, matching the majority (`leads.*`) |
| `agents.openDemoPage` | "Demo" rendered as العرض التجريبي here, vs. العرض التوضيحي everywhere else the file talks about the hosted demo page | Standardized on العرض التوضيحي |
| `analytics.resolved`, `analytics.markedResolved`, `shell.resolvedOn` | "Resolve/Resolved" describing a CONVERSATION's outcome used root حلّ (solve), while the actual "Resolve" action button in the inbox (`inbox.resolve`/`inbox.resolveThisConversation`) uses إنهاء (end) for the same concept | Changed the three outcome/status strings to the إنهاء root, matching the action that produces the outcome. `shell.feedback.status.resolved` was deliberately left on حلّ — it describes a product-feedback ticket being solved, a different domain from a conversation being ended, and حلّ is the more natural word there |
| `leads.requestedAPerson`/`agents.talkingToAPerson`/`agents.visitorsCanAskForA` (موظف بشري) vs. `inbox.waitingForAPerson`/`inbox.askedToSpeakToA`/`inbox.theyWillSeeAnOffer` (شخص) | "A person" (handoff to a human) rendered two different ways for the same underlying concept | Standardized the three `inbox.*` strings on موظف بشري, matching the majority |

Overall assessment from the reviewer: "close to shippable, not a rework candidate" — the hard
rules (agent-naming ban, never-translate terms, punctuation, placeholders) held at 100%
across all 2265 entries; the findings were narrow, mostly-cosmetic consistency gaps
concentrated in a couple of batches, all fixed above.

After applying every fix, `dictionary-parity.test.ts` (18 assertions) and
`formatters.test.ts`'s `ar-AE` cases were re-run and pass.
