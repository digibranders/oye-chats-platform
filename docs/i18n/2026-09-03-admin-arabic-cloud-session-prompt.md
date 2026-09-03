# Add Arabic (ar-AE) to the OyeChats admin dashboard

Repo: `digibranders/oye-chats-platform`. Work on a branch cut from `development`, never on `main`. Open one pull request to `development` when done. Do not merge it.

You are adding a third dashboard language to `app/` (the React console at app.oyechats.com). Today it ships English (inline fallbacks) and Hindi (`hi.ts`). The target is Arabic for Gulf-region customers: `ar-AE`, endonym `العربية`, Modern Standard Arabic in a business register.

This is two pieces of work, and the order matters:

1. Right-to-left layout support. The dashboard deliberately pins `dir="ltr"` and an API test forbids any RTL language in the admin list. Arabic cannot ship until the console renders correctly mirrored. Do this first, with a guard so it cannot regress.
2. The Arabic dictionary: every one of the 2,264 live keys in `app/src/i18n/locales/en.ts`, translated, reviewed string by string, and proven by the same tests that guard Hindi.

Standards: zero untranslated strings, zero broken placeholders, zero layout defects in RTL on any route at desktop and phone widths, every existing check green, and a review pass over every string before you open the PR.

## Ground rules

- Branch from `development` (`git fetch origin && git checkout -b feat/admin-arabic origin/development`). Rebase on `development` before opening the PR; other people merge to it during the day.
- Stage files explicitly. Never `git add -A` or `git add .`. Never stage any `.env*` file.
- Do not edit `widget/` at all, and edit `api/` only for the language contract described below. Do not touch files outside your scope that other sessions may be working on.
- Do not change a single English string, key name, or the structure of `en.ts`. Do not reformat `en.ts` or `hi.ts`; `scripts/i18n-remove-keys.mjs` re-renders whole namespaces and that is exactly the reflow to avoid. Add Arabic with `scripts/i18n-write-ns.mjs` or a purpose-built merge that preserves the existing files byte for byte.
- No em-dashes (U+2014) or en-dashes (U+2013) in any string, English or Arabic, and no `—` escapes either, which evade `scripts/assert-no-em-dashes.mjs`. Arabic uses the Arabic comma `،` and question mark `؟`; use them.
- No `any`, no `// TODO`, no placeholder strings, no machine-translation dumps. Every value you write is what a paying customer in Dubai will read.
- Commit in small, self-contained steps, each of which lints, typechecks, tests and builds. Suggested order is in the last section.

## Read these before writing anything

Dashboard i18n runtime and conventions:
- `app/src/i18n/i18n.ts`: the store. `DICTIONARY_LOADERS` (lazy `import()` per language; English has no entry on purpose), `ADMIN_UI_LANGUAGES`, `DEFAULT_UI_LOCALE = 'en-IN'`, `t(key, params)` with `{name}`-style interpolation, `template()`, `setLocale`, `preloadDictionary`, localStorage key `oc_ui_locale`.
- `app/src/i18n/I18nProvider.tsx`: sets `lang` and `dir` on `<html>`. Read its header comment: RTL was put out of scope with a count of physical versus logical Tailwind classes. That comment describes the work you are about to do; update it when the work is done.
- `app/src/i18n/useTranslation.ts`, `app/src/i18n/Trans.tsx`: how components consume the store.
- `app/src/i18n/formatters.ts` and `app/src/ui/lib/formatters.ts`: dates, times, numbers, currency, percent, relative time, durations, bytes. Note the `ABSENT` constant and any locale-specific branches.
- `app/src/i18n/locales/en.ts` (canonical source, not loaded at runtime) and `hi.ts` (the model for what a complete dictionary looks like: same nesting, same keys, plural pairs like `websitesCountOne` / `websitesCountMany`, placeholders like `{count}`, `{name}`, `{n}`, `{total}`, `{limit}`, `{plan}`, `{email}`, `{range}`).
- `app/src/features/settings/LanguageSection.tsx`: the "Dashboard language" picker. Languages are listed by endonym and are `@i18n-exempt` (a language's name in itself is never translated).
- `app/src/services/localeCatalog.ts`: `directionForLocale()` and the `RTL_LANGUAGES` set. Arabic is already classified as RTL here; the provider already resolves `dir` through it. Once `ar` joins `ADMIN_UI_LANGUAGES`, `dir="rtl"` is applied automatically, which is why RTL support must land first.
- Tests in `app/src/i18n/`: `dictionary-parity.test.ts` (every English key present, no HTML entities, and a Hindi-specific "no lowercase Latin prose left" check you must mirror for Arabic with the Arabic script range `؀-ۿ`), `keys-exist.test.ts`, `restoredLocale.test.ts`, `Trans.test.tsx`, `formatters.test.ts`.
- Scripts in `app/scripts/`: `i18n-inventory.mjs` (AST-based; the only trustworthy count of what renders), `i18n-orphans.mjs` (must report 0 after your change), `i18n-extract-pairs.mjs`, `i18n-write-ns.mjs`, `assert-no-em-dashes.mjs`. Read their header comments; they explain the `// i18n-exempt:` and `@i18n-exempt:` conventions.
- `app/package.json`: the `size-limit` block has an entry for `dist/assets/hi-*.js`. Arabic needs its own.
- `app/src/index.css` and `app/src/ui/tokens.css`: the design tokens, font stack, and the `tracking-*` letter-spacing utilities (which must be neutralised for Arabic, see below).

Backend contract:
- `api/app/services/language_service.py`: `ADMIN_UI_LANGUAGES = frozenset({"en", "hi"})` and `admin_ui_translated`.
- `api/tests/test_admin_ui_languages_contract.py`: fails if the API list and the client loaders drift, and contains `test_rtl_locales_are_never_admin_ui_translated`, which encodes the "no RTL" decision you are reversing. Replace that test with one that says the new truth: an RTL locale may be admin-translated only because the dashboard now renders RTL, and name the guard that proves it.

Terminology:
- `widget/src/i18n/locales/ar.js`: the visitor widget already has an Arabic dictionary. Read it for the product's existing Arabic choices and stay consistent with them where the same concept appears. Do not edit it.
- Product lexicon (locked): Account, Operator, Conversation, Lead, Train, Support. The AI product noun is "AI Chatbot", never "AI Agent". Build a glossary for these and every recurring noun (Inbox, Journey, Analytics, Billing, Credits, Plan, Trial, Workspace, Widget, Knowledge, Handoff, Quotation, Visitor, Session, Webhook, API key) before translating, apply it everywhere, and put it in the PR.
- Never translate: OyeChats, Razorpay, UPI, WhatsApp, Google, Calendly, Cal.com, Zcal, API, URL, JSON, CSV, PDF, GST, GSTIN, INR, USD, AED, email addresses, domain names, product plan names as they appear in billing, and keyboard shortcut letters.

## Decisions already made (do not reopen)

- Locale tag: `ar-AE`. In CLDR it defaults to the Gregorian calendar and Latin (Western) digits, which is what Gulf business users expect on a dashboard. Do not use `ar-SA` (defaults to the Islamic calendar) or bare `ar` (Arabic-Indic digits). Verify in a test: `new Intl.DateTimeFormat('ar-AE').resolvedOptions().calendar === 'gregory'` and `new Intl.NumberFormat('ar-AE').format(1234.5)` contains Latin digits.
- Endonym in the picker: `العربية`. Entry shape mirrors Hindi: `ar: { locale: 'ar-AE', endonym: 'العربية' }`.
- Register: Modern Standard Arabic, formal-but-plain, addressing the operator as "you" (أنت) with masculine-neutral verb forms as is standard in Arabic software UI. Consistent voice across the whole dictionary.
- Plurals: the dictionary has `One` / `Many` pairs only. Do not add plural categories. Write `Many` forms that read correctly with a preceding Latin digit for all n >= 2, following the Microsoft Arabic style-guide convention for digit-plus-noun in UI. If a specific key genuinely cannot read correctly without a third form, list it in the PR under "plural limitations" instead of inventing a mechanism.
- Currency: leave currency formatting to the existing formatters with the `ar-AE` locale. Billing amounts stay in the customer's billing currency (INR or USD); Arabic changes the words around them, not the currency.
- Fonts: rely on the system stack (SF Arabic on Apple, Segoe UI on Windows, Noto Sans Arabic on Android and Linux). Do not add a webfont. Do make sure the font stack in `tokens.css` ends in a generic family so Arabic never falls to a font without the script.

## Part 1: right-to-left layout

Goal: with `dir="rtl"` on `<html>`, every route of the console mirrors correctly: the rail on the right, content flowing right to left, icons that imply direction mirrored, and everything that is inherently left-to-right (code, IDs, URLs, emails, phone numbers, API keys, numeric axes) isolated so it still reads correctly.

Method:

1. Inventory. Write a small script (keep it in `app/scripts/`, name it `rtl-physical-classes.mjs`) that lists every physical-direction Tailwind utility in `app/src` by file and line: `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `inset-x-`, `text-left`, `text-right`, `rounded-l-`, `rounded-r-`, `rounded-tl-`, `rounded-tr-`, `rounded-bl-`, `rounded-br-`, `border-l`, `border-r`, `translate-x-`, `-translate-x-`, `origin-left`, `origin-right`, `float-left`, `float-right`, `justify-self-start` / `end` are fine (logical), `space-x-` (which uses physical margins; prefer `gap`), `divide-x`, `scroll-pl-` / `scroll-pr-`, and any `left:` / `right:` / `margin-left` / `padding-right` in inline styles or CSS. Commit the script; it becomes the guard.
2. Convert. Tailwind v4 ships logical utilities: `ms-` / `me-`, `ps-` / `pe-`, `start-` / `end-`, `inset-s-` / `inset-e-`, `text-start` / `text-end`, `rounded-s-` / `rounded-e-` (and `rounded-ss`, `rounded-se`, `rounded-es`, `rounded-ee`), `border-s` / `border-e`, `scroll-ps-` / `scroll-pe-`. Convert file by file. For transforms that slide panels in from an edge (drawers, the mobile rail, toasts, the command palette), use the `rtl:` variant to flip the translate direction, or express the motion with logical insets instead of transforms.
3. Deliberate exceptions. Some physical classes are correct in both directions (a spinner, a centred element, a chart's numeric axis). Mark each with `// rtl-ok: <reason>` on the line or the line above, and have the inventory script honour the marker. The reason must say why mirroring would be wrong, not just "keep".
4. LTR islands. Anything that must stay left-to-right gets `dir="ltr"` on the element and, where it sits inline in Arabic text, `unicode-bidi: isolate` (Tailwind: add a tiny `.ltr-island` utility in `tokens.css` or use inline `dir`): code blocks, `<kbd>`, IDs from `truncateId`, API keys, webhook URLs, email addresses, phone numbers, domain names, install snippets, JSON previews, and numeric inputs. Text alignment inside an island is `text-start` relative to the island's own direction.
5. Icons. Mirror icons that encode direction: chevrons and arrows used for navigation, "back", "next", "expand" carets, breadcrumb separators, the rail collapse toggle, send-style arrows, and any "external link" arrow. Do it with `rtl:-scale-x-100` (or `rtl:rotate-180` where the icon is a straight arrow) on the icon element. Do not mirror icons whose meaning is not directional: refresh, checkmarks, close, search, clocks, play, media controls, brand logos, and the OyeChats mark.
6. Typography under RTL. Letter-spacing breaks a connected script. Every `tracking-*` utility (eyebrows, uppercase labels, badge text) must resolve to `letter-spacing: 0` when `dir="rtl"`; do it once in `tokens.css` with `[dir="rtl"]` scoped overrides for the tracking tokens rather than editing call sites. Check line-heights on Arabic headings; raise the token if ascenders and diacritics clip. `uppercase` is a no-op in Arabic and can stay.
7. Components to check by hand (each has known RTL traps): `Rail` and `AppShell` grid columns (the rail moves to the right; the grid template must use logical ordering, not `left`), `TopBar` breadcrumbs, `CommandPalette`, `Menu` and every Base UI popover or tooltip whose `side` is `left` or `right` (use `inline-start` / `inline-end` if the library supports it, else derive the side from `document.dir`), `DataTable` (header sort icons, numeric column alignment, sticky first column), `SidebarLayout`, `DatePicker`, sliders and progress bars, switches (a toggle's "on" side should follow reading direction), `Field` trailing slots, toasts, the `ActivityChart` and every Recharts chart (keep the plotting area an LTR island with `dir="ltr"`; mirror only the surrounding labels), the onboarding checklist, the Launch Studio and install-snippet screens, billing invoices and plan cards, and any component that positions with `left-1/2 -translate-x-1/2` (centring is fine, but check nothing else on the element assumes left).
8. Guard. Add a vitest that runs the inventory and fails on any unmarked physical class. Add an ESLint rule only if it can be done without `any` and without slowing lint materially; otherwise the vitest is enough. Update the header comment in `I18nProvider.tsx` to describe the new state and the guard.

Verification for Part 1 (before writing any Arabic):
- Run the app with `document.documentElement.dir = 'rtl'` forced (add a dev-only query flag or just set it in the browser console) and walk every route at 1440px and 375px: `/`, `/chatbots`, each chatbot sub-page (overview, knowledge, experience, channels, launch), `/inbox`, `/leads`, `/journey`, `/analytics`, `/billing`, `/settings` and each settings section, `/account`, the command palette, the mobile rail drawer, at least one modal, one toast, one dropdown, one date picker, one table with sorting.
- On each, run a scripted check in the page: no element with `scrollWidth > clientWidth` inside a container that is not meant to scroll, no element whose bounding rect extends past the viewport on either side, and `document.documentElement.scrollWidth === window.innerWidth` (no horizontal page scroll).
- Save one screenshot per route per width into the PR description (upload as images). Look at every one of them yourself before moving on; a passing script does not mean the page looks right.

## Part 2: the Arabic dictionary

Goal: `app/src/i18n/locales/ar.ts` with exactly the key set of `en.ts`, every value in Arabic, placeholders intact, reviewed twice.

Method:

1. Generate the skeleton from `en.ts` with the same nesting and key order (use `scripts/i18n-write-ns.mjs` per namespace, or extend it). Do not hand-type keys.
2. Translate namespace by namespace. For each namespace, open the components that render its keys (the inventory script tells you where) and translate with the screen in mind: a button label is imperative and short, a hint is a sentence, a table header is a noun, an error explains what went wrong and what to do. Keep the same information the English carries; do not add or drop meaning. Respect the glossary. Keep `{placeholders}` exactly as in English, including their position where Arabic word order allows and moving them where it does not.
3. Length. Arabic is usually shorter than English but wider per glyph; still, check labels that sit in fixed-width chrome (rail items, tabs, badges, table headers, toggle labels) and prefer a shorter synonym over an ellipsis.
4. Punctuation and script: Arabic comma `،`, Arabic question mark `؟`, Arabic semicolon `؛` where used, ordinary full stop. Latin digits. No Latin letters left in a value except the never-translate list. No HTML entities. No em-dashes.
5. Review pass one (correctness): dump every `(key, English, Arabic)` triple to a file and go through it in order, checking meaning, register, glossary, placeholders, and punctuation. Fix as you go. Keep a log of what you changed and why; it goes in the PR.
6. Review pass two (fresh eyes): start a separate subagent with no memory of pass one, give it the same triples and the glossary, and ask it to flag anything wrong or inconsistent. Resolve every flag: fix it or write down why it is correct. Its findings and your resolutions go in the PR.
7. Tests. In `dictionary-parity.test.ts`: add `ar` to `DICTIONARIES`; add an Arabic mirror of the Hindi "no lowercase Latin prose left" test using `؀-ۿ`; add a test that every placeholder in an English value appears exactly once in the Arabic value; add a test that no Arabic value contains U+2013, U+2014, or a Latin comma directly followed by Arabic script where an Arabic comma belongs. `restoredLocale.test.ts` and `keys-exist.test.ts` must pass unchanged. Add `ar` to any test that enumerates supported languages.
8. Runtime wiring: `DICTIONARY_LOADERS.ar`, the picker entry in `LanguageSection.tsx`, the API `ADMIN_UI_LANGUAGES`, the replaced RTL contract test, and a `size-limit` entry for `dist/assets/ar-*.js` with a limit justified in its `name` the way the Hindi entry is (Arabic gzips smaller than Devanagari; measure and leave modest headroom).
9. Formatters: add `ar-AE` cases to `formatters.test.ts` for date, time, date-time, day label, number, currency (INR and USD), percent, relative time, and duration. Assert the calendar is Gregorian and the digits are Latin. Fix any formatter that special-cases `hi-IN` in a way that would skip Arabic.

Verification for Part 2:
- Switch the dashboard to Arabic through the picker (not by editing localStorage) and walk the same route list as Part 1 at both widths. Every visible string must be Arabic except the never-translate list. Use the inventory script's output to confirm nothing rendering on screen is missing from the dictionary.
- Cold load with the stored preference: the first paint must be Arabic, not English flipping to Arabic.
- Switch back to English and to Hindi; nothing may have regressed for them.
- Screenshots of every route in Arabic at both widths go in the PR, next to the RTL ones.

## Checks that must be green before the PR

Run from `app/`:

```bash
npm run lint
npx tsc --noEmit
npx vitest run
npm run build
npx size-limit
node scripts/i18n-orphans.mjs
node scripts/i18n-inventory.mjs
node scripts/rtl-physical-classes.mjs
npx playwright test --project=chromium
```

Run from `api/` for the contract change:

```bash
uv run ruff check .
uv run pytest tests/test_admin_ui_languages_contract.py -q
```

`i18n-orphans` must report 0. The RTL inventory must report 0 unmarked classes. Playwright must pass; add a Chromium run booted in Arabic (a project or an env var that seeds `oc_ui_locale`) that loads every route and asserts `document.dir === 'rtl'` and no horizontal overflow.

## Pull request

Target `development`. The description must contain:
- The glossary.
- The RTL conversion summary by area, the list of `rtl-ok` exceptions with their reasons, and the guard that prevents regression.
- Screenshots: every route at 1440px and 375px, in RTL-forced English (Part 1) and in Arabic (Part 2).
- The two review logs (your pass and the subagent's) with resolutions.
- Plural limitations, if any.
- The exact check output (counts, not "passed").

Do not merge. Do not push to `main`.

## Suggested commit order

1. `feat(app): RTL layout support behind a guard` (inventory script, conversions, `rtl-ok` markers, typography overrides, vitest guard, provider comment). Everything green with `dir` forced.
2. `feat(app): formatters and picker ready for ar-AE` (formatter tests, picker entry, `DICTIONARY_LOADERS.ar` pointing at an empty-but-valid skeleton so the loader test passes, size-limit entry).
3. `feat(api): Arabic joins the admin UI languages` (contract change and the replaced RTL test).
4. `feat(app): Arabic dictionary` (the full `ar.ts`, parity tests, review logs under `docs/i18n/`).
5. `test(app): Arabic route sweep` (the Playwright run in Arabic).

If any step cannot be completed to the standard above, stop at the previous green commit, and say exactly what is left and why in the PR. Partial Arabic must never reach `development` behind the picker; if the dictionary is incomplete, keep `ar` out of `ADMIN_UI_LANGUAGES` until it is.
