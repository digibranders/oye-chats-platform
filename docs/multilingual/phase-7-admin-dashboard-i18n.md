# Phase 7: Admin Dashboard i18n

## Why this document exists

The third language layer named in [README.md](README.md), *operator/dashboard
locale*, was described in the overview and then never scheduled. Phase 6 is
owned by Hardening, Testing & Production Rollout and explicitly ships no new
product surface; it is not, and must not become, the home for this work.

This plan is derived from an audit of the admin application performed against
`development` @ `6147418d`, after Phases 1 to 5 and the multilingual hardening
commits landed. Every measurement quoted below (string counts, the 160
formatting call sites, the 409 direction-dependent classes, the bundle figures)
was taken from the working tree at that commit and is reproducible from it. The
figures are restated inline here rather than referenced, so this document stands
on its own.

**This is a plan. No implementation has started.**

---

## Objective

Let a dashboard user read the admin application in their own language, without
disturbing any of the three language systems already shipped.

The unit of success is a **whole surface**: a screen is either localized or it
is not. A half-translated screen is worse than an English one, because it reads
as breakage rather than as a language the product does not yet speak.

---

## Scope

- A UI-language runtime for the admin SPA (`t()`, formatters, a provider).
- A language selector in Settings, persisted per device.
- An independent `admin_ui_translated` capability flag on the existing locale
  catalogue.
- Localization of the shell and the daily-operational surfaces (7B, 7C).
- A formatter layer covering the 160 date/number call sites that currently
  follow the browser rather than the app (7D).
- Localization of agent configuration and the pre-auth screens (7E, 7F).
- Test guards and browser verification for all of the above.

## Non-scope

Each of these is deferred deliberately, with the reason recorded. Promoting any
of them is a scope decision, not an implementation detail.

| Not built | Why |
|---|---|
| **RTL layout support** | 409 direction-dependent Tailwind classes, 0 logical equivalents, no `dir` handling anywhere in the admin. Both launch languages are LTR. See "RTL" below. |
| **Localized server error messages** | 375 `HTTPException detail="..."` strings in `api/app/api/`. Needs a backend error-code architecture. Separate project. |
| **`features/workspace`** (~535 strings) | Billing, invoices, GST, legal. Mistranslating a tax field is a liability, not a bug. Needs legal review, not translation. |
| **`context/upgradeIntents.ts`** (~107 strings) | Conversion copy, growth-owned and A/B tested. Freezing it into a dictionary fights its lifecycle. |
| **`features/launch-studio`** (~200 strings) | One-time onboarding. Lowest return per string in the application. |
| **`features/agents/advanced`** (~80 strings) | Deliberately technical. `app/CLAUDE.md` says never expose it during onboarding. |
| **Superadmin surfaces** | Internal only. Never localize. |
| **Database persistence of UI locale** | First release is `localStorage`. See "Data model decisions". |
| **Locale segments in URLs** | See "Routing". |
| **A runtime English dictionary** | See "Dictionary strategy". |
| **Machine translation of the admin UI** | The Phase 4 translation path is for *conversations*. Product UI needs reviewed, stable copy, not per-render inference. |

---

## Architectural rules (non-negotiable)

These carry the same weight as the existing rules in
[README.md](README.md) ("no per-language vector indexes", and the resolution
precedence order). A change to any of them is a plan change, not an
implementation choice.

1. **Dashboard UI locale is separate from `Operator.preferred_locale`.**
   They are never derived from each other, in either direction. See "Why the
   two must not merge" below.
2. **Locale metadata comes from `GET /locales`.** The backend's `KNOWN_LOCALES`
   remains the only locale registry. No second table, no second list.
3. **Do not reuse `ui_translated` for the admin.** It means *the widget's* UI is
   translated. Reusing it would offer customers a language one surface cannot
   render.
4. **Introduce an independent `admin_ui_translated`,** derived from its own
   `ADMIN_UI_LANGUAGES` constant, with its own drift-contract test.
5. **First release persists to `localStorage`, not the database.**
6. **No locale in URLs.**
7. **No runtime English dictionary.** English lives as inline fallbacks at the
   call sites.
8. **Non-English dictionaries are lazy-loaded** and never enter the main chunk.
9. **English remains the inline fallback** at every `t()` call site.
10. **`t()` returns `null` on a missing key,** never the key path.
11. **The formatter layer is first-class scope,** not a follow-up.
12. **RTL is explicitly deferred** and gated by `admin_ui_translated`.
13. **Server error localization is deferred.**
14. **Workspace/legal, launch studio, agents/advanced and superadmin remain
    deferred** unless explicitly promoted by a scope decision.

---

## Current state (measured, not assumed)

### No i18n infrastructure exists in the admin

No i18n library in `app/package.json`. No `t()`. No dictionary. No provider.

Three modules look like i18n and are not:

| Module | What it actually is |
|---|---|
| `app/src/services/localeCatalog.ts` | Registry of **other people's** language names and directions. Zero UI strings. |
| `app/src/hooks/useLocaleCatalog.ts` | Fetch/subscribe wrapper for the above. |
| `app/src/features/inbox/TranslationToggle.tsx` | Toggles **chat message** original/translated. Not UI language. |
| `app/src/features/inbox/OperatorLanguagePicker.tsx` | Sets the operator's **live-chat working language**. Not UI language. |

The working runtime to copy from is the widget's: `widget/src/i18n/i18n.js`,
`widget/src/i18n/formatters.js`, `widget/src/i18n/localeCatalog.js`,
`widget/src/i18n/seededCopy.js`. 441 lines total. Proven in production. Not
importable across the package boundary, so it is ported, not shared.

### The localization surface

A JSX-aware scan over 296 non-test files:

```
~2,260 strings in 224 of 296 files
```

| Strings | Files | Area | Phase |
|---:|---:|---|---|
| 681 | 55 | `features/agents` | 7E (minus `advanced`) |
| 535 | 37 | `features/workspace` | deferred |
| 200 | 20 | `features/launch-studio` | deferred |
| 144 | 16 | `features/inbox` | 7C |
| 123 | 13 | `features/analytics` | 7C |
| 122 | 9 | `context/`, `lib/`, misc | mostly deferred |
| 103 | 9 | `features/leads` | 7C |
| 88 | 6 | `features/settings` | 7B |
| 77 | 14 | `shell` | 7B |
| 69 | 7 | `features/affiliate` | deferred |
| 52 | 3 | `features/home` | 7C |
| 18 | 15 | `design-system` | 7B |

**This number carries a +/-20% error bar and must not be used for scheduling.**
On the widget, the first grep-based inventory found 7 strings where the real
count was roughly 170. A scanner is a scoping aid. Producing a trustworthy
inventory is the entire job of Phase 7A.

`design-system` holding only 18 strings is the single most useful finding here:
the component library is almost string-free, so this is page work, not
primitive work.

### Formatting is locale-blind today

160 call sites use `toLocaleDateString` / `toLocaleTimeString` /
`toLocaleString` / `Intl.*`. In 193 of 194 argument positions **no locale is
passed**, so they follow the *browser*, not the application.

Introducing an app UI locale without addressing this produces a screen whose
text is Hindi and whose dates are in whatever the browser prefers. This is
invisible to any string sweep, which is why it is its own phase (7D) rather
than a note.

### RTL is not viable in this phase

| Physical (do not flip) | Count | Logical (flip) | Count |
|---|---:|---|---:|
| `ml-` | 49 | `ms-` | 0 |
| `mr-` | 14 | `me-` | 0 |
| `pl-` | 39 | `ps-` | 0 |
| `pr-` | 32 | `pe-` | 0 |
| `left-` | 61 | `start-` | 6 |
| `right-` | 66 | `end-` | 3 |
| `text-left` | 65 | `text-start` | 0 |
| `text-right` | 17 | `text-end` | 0 |
| `border-l` | 8 | | |
| `border-r` | 58 | | |
| **409** | | **9** | |

There is no `dir` handling anywhere in the admin. Converting 409 classes is
mechanical but wide, with a real regression surface and no automated
verification short of visual diffing.

Both launch languages (English, Hindi) are LTR. RTL is deferred and **gated**:
no RTL locale may be added to `ADMIN_UI_LANGUAGES` until the conversion lands.
The flag makes that enforceable rather than aspirational.

### Bundle baseline

`app/dist/assets/` ships **one 2.14 MB chunk (589 KB gzipped)**, with only
LaunchStudio split out (48 KB raw, 13 KB gzipped). The build already emits
Vite's >500 KB warning.

**The admin has no size budget at all.** The widget has `size-limit` in
`widget/package.json`; the admin has nothing equivalent, so any bundle
regression is currently unguarded.

### Testing baseline

77 unit test files, 719 tests, 4 e2e specs in `app/tests/e2e/`, and
`app/playwright.config.ts` declares **Chromium only**. The widget suite runs
Chromium and WebKit; the admin does not.

---

## Why the two locales must not merge

`Operator.preferred_locale` (`api/app/db/models.py`) is documented in place:

> *The language this operator works in. Live chat translates incoming visitor
> messages INTO this locale and outgoing replies FROM it.*

Three independent reasons it must stay separate from dashboard UI locale:

1. **It spends money.** It drives `translation_service` calls billed to
   `CreditLedger` with reason `translation`. Changing a menu language must never
   start translating live chats and charging for them.
2. **It is resolved to match the socket.** `_language_target()` in
   `api/app/api/operator_routes.py` deliberately resolves the same Operator row
   the WebSocket path resolves, *"so the console and the socket [don't]
   translate into different languages for the same human."* A UI-locale field
   entering that resolution breaks the invariant.
3. **Clients do not have one, by design.** The same docstring: *"a Client row has
   no `preferred_locale`, because the preference is about reading live chat,
   which is an operator activity."* UI locale must exist for Clients too.

They are also legitimately different values. A Gujarati-speaking operator may
want the dashboard in English, because the technical vocabulary is English, while
reading visitor chats translated into Gujarati. Conflating them removes a choice
users will want.

---

## The four language slices

| Slice | Scope | Storage | Set by |
|---|---|---|---|
| Widget UI locale | One visitor, one browser | `localStorage` + `ChatSession.locale` | Visitor / host page / auto-detect |
| Conversation language | One chat session | `ChatSession.language_code` | Detection plus visitor choice |
| Operator working language | One operator, live chat | `Operator.preferred_locale` | Operator, in Inbox |
| **Dashboard UI locale** (new) | One dashboard user | `localStorage` | User, in Settings to Appearance |

The only thing they share is the locale registry. No slice defaults from another.

---

## Locale architecture

```
                    api/app/services/language_service.py
                              KNOWN_LOCALES
                    (the ONLY locale registry, 29 locales)
                                   |
                    +--------------+--------------+
                    |                             |
            WIDGET_UI_LANGUAGES           ADMIN_UI_LANGUAGES
              {en, hi}                       {en, hi}   <- new, independent
                    |                             |
             ui_translated                admin_ui_translated
                    |                             |
                    +--------- GET /locales ------+
                                   |
                    +--------------+--------------+
                    |                             |
        widget/src/i18n/localeCatalog.js   app/src/services/localeCatalog.ts
        (bundled copy, parity-tested)      (fetched, cached per session)
                    |                             |
        widget/src/i18n/locales/*.js       app/src/i18n/locales/*.ts
        221 keys, widget chrome            ~2,300 keys, admin chrome
                    |                             |
              DIFFERENT DICTIONARIES. NEVER MERGED.
```

The registry is shared. The dictionaries are not, and neither is derivable from
the other: they describe different user interfaces.

### The pre-auth constraint

`GET /locales` is **authenticated**
(`auth=Depends(get_current_client_or_operator)` in
`api/app/api/locale_routes.py`). Seven routes render before any credential
exists:

`/login`, `/register`, `/forgot-password`, `/verify-email`, `/auth/callback`,
`/invite/:token`, `/affiliate-invite`

They carry roughly 89 strings and **cannot read the catalogue**. Phase 7F must
resolve this with either a public catalogue subset or a build-time constant. It
is the first screen every user sees, so it cannot be left to improvisation.

---

## Dictionary strategy

```
app/src/i18n/
  i18n.ts               # t(), setLocale, subscribe. Port of widget/src/i18n/i18n.js
  formatters.ts         # dates and numbers bound to the active locale
  locales/en.ts         # canonical source; NOT loaded at runtime
  locales/hi.ts         # lazy dynamic import
```

Two decisions carried from the widget, both of which were learned the hard way:

**English ships no runtime dictionary.** Every call site carries
`t('key') || 'English default'`. Loading `en.ts` on top of that would send every
string twice to every user. It also makes "English output is unchanged" provable
rather than asserted, because the English text never leaves the component.

**`t()` returns `null` on a miss, never the key.** Returning `'settings.title'`
puts raw key paths in front of users and silently makes every `|| 'English'`
fallback dead code. The widget shipped the key-returning version first and the
fallbacks were unreachable until it was corrected.

`locales/en.ts` remains in the tree as the canonical source translators work
from and the file the parity tests assert against.

---

## Routing

**No change to `app/src/app/routes.tsx`.**

Do not add a locale segment (`/:locale/agents/...`). The admin is authenticated
and therefore not SEO-indexed, so locale-in-URL buys nothing; it is
single-user-context, so there are no locale-specific deep links worth sharing;
and the route table already carries legacy redirects that would each need
doubling. It would touch every route, every `<Navigate>`, every breadcrumb
`handle`, and all four e2e specs, for no user-visible benefit.

The only structural addition is a provider at the application root, alongside
the existing `ThemeProvider`, plus setting `lang` on `document.documentElement`.

---

## Where the selector lives

**Settings to Appearance** (`app/src/features/settings/AppearanceSection.tsx`).

That section already holds exactly this class of preference: Theme
(Light/Dark/System) and Contrast (Default/High), each rendered as a labelled
radiogroup with roving arrow-key focus. Language is a third row with the same
interaction and the same persistence.

**Not the Inbox.** `OperatorLanguagePicker` lives beside the availability toggle
in Support to Live chat, and its own docstring explains why: it is a personal
live-chat preference. Two language controls in one panel meaning different
things is a support ticket waiting to happen.

**Not the TopBar `ProfileMenu`.** Language is set once and rarely revisited; that
menu is for frequent actions.

---

## Data model and API decisions

### First release: no schema change

UI locale is stored in `localStorage`, following the precedent already working
in `app/src/design-system/theme/ThemeProvider.tsx`, which persists theme and
contrast the same way and applies them to `document.documentElement`. UI
language is the same class of preference: per-device presentation.

**Phases 7A to 7F require no migration.**

### If cross-device sync is later wanted

Only then, and as a separate decision:

```sql
ALTER TABLE clients   ADD COLUMN ui_locale VARCHAR(32) NULL;
ALTER TABLE operators ADD COLUMN ui_locale VARCHAR(32) NULL;
```

Both tables, because a dashboard user authenticates as **either** a Client
(`X-API-Key`) **or** an Operator (`X-Operator-Key`). Storing it on one leaves
half the users out.

Surfaced through the existing `GET /auth/me`, which already returns a
`kind: "client" | "operator"` discriminated payload
(`CurrentUserResponse` in `api/app/api/auth_routes.py`) and is already the
TopBar's data source. No new endpoint. A `PATCH` writes it.

**Never derived from, and never writing to, `Operator.preferred_locale`.**

Do not do this first. A migration that stores a preference the UI cannot yet
honour buys nothing and has to be maintained anyway.

### API change (7A)

`LocaleInfo` in `api/app/schemas/language.py` gains:

```
admin_ui_translated: bool = False
```

derived in `api/app/services/language_service.py` from a new
`ADMIN_UI_LANGUAGES` constant, the same way `ui_translated` is derived from
`WIDGET_UI_LANGUAGES`. Additive and non-breaking: existing consumers ignore it.

---

## Exact files and components affected

### New files

| File | Phase |
|---|---|
| `app/src/i18n/i18n.ts` | 7A |
| `app/src/i18n/formatters.ts` | 7A |
| `app/src/i18n/locales/en.ts` | 7A |
| `app/src/i18n/locales/hi.ts` | 7A |
| `api/tests/test_admin_ui_languages_contract.py` | 7A |
| `app/tests/e2e/admin-language.spec.ts` | 7B |

### Modified: infrastructure (7A, 7B)

| File | Change |
|---|---|
| `api/app/schemas/language.py` | Add `admin_ui_translated` to `LocaleInfo` |
| `api/app/services/language_service.py` | Add `ADMIN_UI_LANGUAGES`; derive the flag |
| `app/src/services/localeCatalog.ts` | Parse `admin_ui_translated`; expose `isAdminUiTranslated` |
| `app/src/hooks/useLocaleCatalog.ts` | Surface the new predicate |
| `app/src/app/App.tsx` | Mount the i18n provider beside `ThemeProvider` |
| `app/src/features/settings/AppearanceSection.tsx` | Add the language radiogroup |
| `app/playwright.config.ts` | Add the WebKit project |
| `app/package.json` | Add a size budget |

### Modified: surfaces

"Files with strings" is the number the scanner flagged. "Files in tree" is every
non-test source file in that directory, recursively. The gap matters: it is the
share of each directory that is already string-free and needs no work.

| Phase | Directories | Files with strings | Files in tree |
|---|---|---:|---:|
| 7B | `app/src/shell/` | 14 | 19 |
| 7B | `app/src/features/settings/` | 6 | 7 |
| 7B | `app/src/design-system/` | 15 | 44 |
| 7C | `app/src/features/home/` | 3 | 3 |
| 7C | `app/src/features/inbox/` | 16 | 18 |
| 7C | `app/src/features/leads/` | 9 | 9 |
| 7C | `app/src/features/analytics/` | 13 | 15 |
| 7D | 160 call sites across the above and their helpers | n/a | n/a |
| 7E | `app/src/features/agents/` excluding `advanced/` | 55 (incl. advanced) | 52 |
| 7F | `app/src/pages/` (5 pre-auth screens) | 5 | 5 |

### Explicitly not touched

`app/src/app/routes.tsx` (no locale routing), `api/app/db/models.py` (no
migration in this phase), every superadmin surface, and everything listed under
Non-scope.

---

## Phase breakdown

### Phase 7A: Inventory and foundation (GATING)

**Ships no localized page.**

1. Build a JSX-aware inventory: parse text nodes, multi-line JSX, localizable
   attributes, template literals and sentence-shaped literals. Grep is not
   sufficient and has already produced a 20x undercount once on this feature.
2. Classify every hit: visitor-facing / accessibility / internal / dynamic user
   data / deferred-area.
3. Port `i18n.ts` and `formatters.ts` from the widget.
4. Add `ADMIN_UI_LANGUAGES`, `admin_ui_translated`, and the drift contract test.
5. Mount the provider. Add the size budget. Add the WebKit project.

**Exit criteria:** a per-surface string count that a schedule can be built on,
and a runtime with nothing wired to it yet.

> **7A is gating. Do not estimate 7B to 7F until the real inventory is
> complete.** Every downstream number in this document is a scanner estimate
> with a +/-20% error bar, and the deferred/localized split will move once the
> classification pass is done.

### Phase 7B: Selector and shell (~183 strings)

`shell` (77), `features/settings` (88), `design-system` (18).

Ships the first thing a user can actually see: a language control that changes
the frame around every page. Settings must be localized in the same phase, or
the feature appears broken at the moment it is discovered.

### Phase 7C: Operational surfaces (~422 strings)

`features/home` (52), `features/inbox` (144), `features/leads` (103),
`features/analytics` (123).

The daily-use product. `inbox` is the highest-value surface here: it is where
non-English operators spend their time, and it is already the home of the
operator translation feature.

### Phase 7D: Formatters (160 call sites)

Route every `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` /
`Intl.*` call through `app/src/i18n/formatters.ts`, bound to the active UI
locale.

Sequenced after 7C because that is where the highest concentration of dates
lives (inbox timestamps, lead capture times, analytics axes), and doing it
earlier means touching those files twice.

### Phase 7E: Agent configuration (~600 strings)

`features/agents` excluding `advanced/`.

The largest single localized block. Its size is the reason it comes after the
operational surfaces rather than before: it is configuration a customer touches
occasionally, not daily.

### Phase 7F: Pre-auth (~89 strings)

`app/src/pages/Login.jsx` and the other six pre-auth routes, **after** resolving
the authenticated-catalogue constraint described above.

Last because it is blocked on an API decision, not because it matters least. It
is arguably the highest-visibility surface in the product.

---

## Testing guards

Every guard below exists and is proven in `widget/src/i18n/i18n.test.js`. They
are ported, not invented.

| Guard | What it proves |
|---|---|
| Dictionary parity | `en` and `hi` expose exactly the same key set |
| Placeholder parity | Every `{token}` survives translation. A translator dropping `{email}` renders a sentence with a hole, and no key-parity check catches it |
| Bare-attribute guard | No `placeholder=` / `aria-label=` / `title=` / `alt=` literal escapes `t()` |
| Bare-sentence guard | No visitor-facing sentence is built without `t()`, with an allowlist that must carry a reason and is itself checked for stale entries |
| Unused-key guard | No dictionary key exists that nothing renders |
| Key-existence guard | Every `t()` key used in a component exists in the dictionary |
| Drift contract | `ADMIN_UI_LANGUAGES` matches the dictionaries actually shipped, in both directions |
| Formatter tests | Dates and numbers follow the app locale, not the browser's |

**Every guard must be bite-checked**: revert the fix, confirm the test fails,
restore. On this feature that practice has already caught three tests that
passed for the wrong reason, including one that wrongly condemned three live
keys because its source list was hand-maintained and incomplete.

The bare-sentence guard is the one that matters most at this scale. On the
widget it caught four visitor-facing strings that two hand inventories and a
grep sweep had all missed.

---

## Browser testing

Unit tests prove a translation exists and that a component asks for it. Neither
proves the string reaches the screen.

`app/tests/e2e/admin-language.spec.ts` drives the real application in Hindi and
asserts, for each surface in the current phase:

1. The Hindi copy is **present**.
2. The English original is **absent**.

The second assertion is the one that matters. A test that only looks for Hindi
passes happily while the English fallback renders beside it.

Add the **WebKit project** to `app/playwright.config.ts`. It currently declares
Chromium only; the widget suite already runs both, and layout differences
between engines are exactly what a language change surfaces.

Reuse `app/tests/e2e/mockBackend.ts`, which already serves `GET /locales` and
accepts a bot override.

---

## Size budget

The admin currently has **no size budget**. Add one in 7A, to
`app/package.json`, mirroring `widget/package.json`'s `size-limit` block.

| Item | Expected |
|---|---|
| Runtime (`i18n.ts` plus `formatters.ts`) | ~2 KB gzipped |
| English strings | 0. Already in the bundle as inline fallbacks |
| Hindi dictionary | ~35 to 45 KB gzipped, extrapolated from the widget's 221 keys at 7 KB |

**The Hindi dictionary must be a lazy chunk**, loaded only when a non-English
locale is active. English users pay nothing.

The existing 589 KB monolith is a pre-existing problem. Phase 7 must not be
asked to fix it, and must not be allowed to make it worse. A budget is how that
is enforced rather than hoped for.

---

## Rollout strategy

1. **7A lands invisibly.** Runtime present, nothing wired, no user-visible
   change. Verifiable by the bundle being unchanged in size.
2. **7B behind an entitlement or a flag**, enabled for internal workspaces
   first. The selector appearing in Settings is the whole user-visible change.
3. **Hindi offered only once 7B and 7C are both complete.** Until then
   `ADMIN_UI_LANGUAGES` stays `{en}` and the selector has one option, or is
   hidden. A customer must never reach a language that covers the shell but not
   the Inbox.
4. **7D before any wide rollout.** Hindi text with browser-locale dates is a
   visible defect.
5. **7E and 7F extend coverage** without changing the offered language set.
6. **Adding a language later** is a dictionary file, a loader entry, and one
   line in `ADMIN_UI_LANGUAGES`. The contract test refuses the combination where
   one exists without the others.

The rollback story at every step is the same: remove the locale from
`ADMIN_UI_LANGUAGES`. The selector stops offering it, `t()` returns null, and
every call site renders its inline English default. No data is stranded, because
nothing is persisted server-side.

---

## Dependencies on previous phases

Phase 7 depends on Phase 5's locale catalogue (`GET /locales`,
`app/src/services/localeCatalog.ts`) and on the `ui_translated` precedent it
established.

It has **no dependency on Phase 6** and does not block it. The two are
independent and may run in either order or in parallel: Phase 6 hardens the
conversation-language feature, Phase 7 localizes the dashboard chrome around it.

It must not modify anything Phases 1 to 5 own. In particular it must not touch
`Operator.preferred_locale`, `ChatSession.language_code`,
`ChatMessage.source_language`, or the widget's dictionaries.

---

## Acceptance criteria

- [ ] 7A produces a classified, JSX-aware inventory with a per-surface count.
- [ ] `ADMIN_UI_LANGUAGES` and `admin_ui_translated` exist and are independent of
      `WIDGET_UI_LANGUAGES` / `ui_translated`.
- [ ] A drift contract test fails in both directions.
- [ ] A dashboard user can select a UI language in Settings to Appearance.
- [ ] The selection persists across reloads on the same device.
- [ ] Selecting a language does not alter `Operator.preferred_locale`, and
      changing `Operator.preferred_locale` does not alter the UI language.
- [ ] English output is byte-identical to before the phase, on every surface.
- [ ] No English UI chrome renders on a localized surface in Hindi, asserted in a
      browser.
- [ ] Dates and numbers follow the UI locale, not the browser (after 7D).
- [ ] The Hindi dictionary is a lazy chunk and does not enter the main bundle.
- [ ] A size budget exists and passes.
- [ ] The admin Playwright suite runs Chromium and WebKit.
- [ ] No migration was required.
- [ ] No locale appears in any URL.
- [ ] Deferred areas remain untouched and are still English.

---

## Risks and edge cases

| Risk | Severity | Mitigation |
|---|---|---|
| **Inventory undercount** | High | Already happened once on this feature (7 found, ~170 real). Parse, don't grep. Gate all estimates on 7A. |
| **`ui_translated` reused for the admin** | High | Silently offers a language one surface cannot render. Separate flag plus contract test. |
| **160 formatting sites missed** | Medium-High | Invisible to string sweeps. 7D exists for exactly this. |
| **RTL attempted opportunistically** | Medium-High | 409 classes, wide regression surface, no automated verification. Gated on `ADMIN_UI_LANGUAGES`. |
| **Selector confused with the operator picker** | Medium | Different pages, different wording, explicit copy in both. |
| **Bundle regression** | Medium | Already a 589 KB monolith with no budget. Lazy dictionaries plus a budget in 7A. |
| **Half-localized screens** | Medium | Ship by whole surface. The browser sweep asserts English *absent*, not merely Hindi present. |
| **Translation quality in deferred areas** | Medium | Deferred by design; promoting any of them requires the review that made it deferred. |
| **A language offered before its surfaces are done** | Medium | `ADMIN_UI_LANGUAGES` stays `{en}` until 7B and 7C are both complete. |

---

## Rollback considerations

Every phase is independently revertible, because nothing is persisted
server-side and English is never removed from the code.

| Phase | Rollback |
|---|---|
| 7A | Revert the commits. No user-visible change to undo. |
| 7B to 7F | Remove the locale from `ADMIN_UI_LANGUAGES`. Every `t()` returns null and the inline English default renders. The selector stops offering it. |
| Any partial state | Same as above. There is no half-migrated data, because there is no migration. |

If server persistence is ever added, its rollback is a nullable column left in
place and ignored, which is the same pattern every prior phase used.
