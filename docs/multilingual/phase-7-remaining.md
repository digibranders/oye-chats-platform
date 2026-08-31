# Admin dashboard i18n: what is left

Companion to [`phase-7-admin-dashboard-i18n.md`](phase-7-admin-dashboard-i18n.md),
written after the localization sweep of 2026-08-28. That document is the design;
this one is the outstanding work, and why each item is outstanding.

Re-measure at any time with:

```bash
cd app && node scripts/i18n-inventory.mjs
```

## Where it stands

Every "now" figure below is a re-measurement taken **2026-08-31** with the
command above. They drift as unrelated work lands, so re-run it before quoting
them; the shape of what is left is the durable part, not the arithmetic.

| | at the start | now (2026-08-31) |
|---|---:|---:|
| `t()` call sites | 30 | **1,616** |
| Strings still unlocalized | 5,348 | **1,461** |
| Files consuming i18n | 28 | 189 |
| `hi.ts` | 2,003 lines | 3,333 lines |

Of the 1,461 remaining, **823 are `dev/UiGallery.tsx`** — an internal component
gallery that is never shipped to a customer — and the rest divide as below.

## 1. The long tail: 638 strings

These are the three shapes `i18n-codemod.mjs` deliberately refuses, because a
wrong edit is a silent rendering bug rather than a compile error. Every one
needs the same judgement a human applied to the others.

| Directory | Strings |
|---|---:|
| `features/leads` | 92 |
| `features/agents/experience` | 74 |
| `shell` (excluding `shell/feedback`) | 65 |
| `features/inbox` | 63 |
| `features/agents/knowledge` (excluding `add`) | 53 |
| `features/agents/quotation` | 37 |
| `features/agents/knowledge/add` | 37 |
| `pages` | 34 |
| `features/analytics` | 33 |
| `features/agents/channels` | 27 |
| `shell/feedback` | 20 |
| `features/settings` | 20 |
| `app/errors` | 19 |
| everything else | ~64 |

### The three shapes, and how each is handled

**Interpolated templates** — `` `Quality score: ${n} out of 100` ``. Becomes a
key with a placeholder: `t('leads.qualityScore', { score }) || …`.

**Sentences that wrap an element** — "New to OyeChats? *Create an account*".
Use `<Trans>`, never a prefix key plus a suffix key. Hindi does not share
English word order, and splitting bakes that order into the markup. `Trans`'s
own docblock explains this; `auth.byCreatingAccount` is a worked example with
two placeholders.

**Module-level tables** — a `const` evaluated at import, before any locale
exists. Carry the KEY beside the English and resolve where it is rendered.
Worked examples: `shell/nav.ts`, `features/home/greeting.ts`,
`pages/auth/authFlow.ts`'s `PASSWORD_RULES`, and the quotation status map in
`features/leads/LeadQuotation.tsx`.

> The inventory cannot see the third shape. It recognises the one-line
> `t('k') || 'English'` idiom and nothing else, so a key/text pair inside an
> object still counts as unlocalized. Some of the 610 are already done. Assert
> on the rendered output instead, the way `shell/navLanguage.test.tsx` does.

## 2. Deliberately deferred, ~1,496 strings

Not a backlog. Each was deferred with a reason in the Phase 7 plan's Non-scope
table, and `i18n-inventory.mjs` enforces the list in `DEFERRED_DIRS`. Promoting
any of them is a **scope decision, not an implementation detail**.

| Directory | Why |
|---|---|
| `features/workspace` | Billing, invoices, GST, legal. Mistranslating a tax field is a liability, not a bug. Needs legal review, not translation. |
| `context/upgradeIntents.ts` | Conversion copy, growth-owned and A/B tested. Freezing it into a dictionary fights its lifecycle. |
| `features/agents/advanced` | Deliberately technical. `app/CLAUDE.md` says never expose it during onboarding. |
| `features/affiliate` | Partner-facing, low traffic. |
| `features/feedback` | Internal feedback capture. |
| `dev/UiGallery.tsx` | Never shipped. Excluded from every count above. |

`features/launch-studio` is also on the deferral list but no longer exists: the
redesign replaced it with `onboarding/`, which IS localized.

## 3. The Hindi needs a native review

Roughly 1,100 strings were written in one sweep, consistent with the existing
dictionary's terminology (चैटबॉट, लीड, वर्कस्पेस, फ़ॉलो-अप) and register. That
is engineering consistency, not editorial sign-off. Product copy — plan names,
billing wording, anything a customer might quote back at support — should be
read by a Hindi speaker before it is treated as final.

Six values are Latin **on purpose** and must stay that way: `Acme Inc.`,
`example.com`, `Next.js`, `Powered by OyeChats`, and two sample URLs. The parity
guard exempts them by rule (uppercase, digits or punctuation).

## 4. Bundle budget

`hi.ts` is 62.8 KB gzipped against a 70 KB `size-limit` budget, raised from 40 KB
when the dictionary's coverage changed. It is lazy and loads only for a reader
who has chosen Hindi; the English initial load is untouched.

**If it approaches 70 KB again, split the dictionary per surface rather than
moving the line again.** The loader in `i18n.ts` already keys on base language,
so a per-namespace split is a change to `DICTIONARY_LOADERS` and `ensureDictionary`.

## 5. Adding a third language

`ADMIN_UI_LANGUAGES` is a contract with the backend, enforced by
`api/tests/test_admin_ui_languages_contract.py`. Adding a language means a new
dictionary, a new `DICTIONARY_LOADERS` entry, and the backend list.

**Not an RTL language.** `I18nProvider` pins `dir="ltr"` and says why: the admin
carries hundreds of physical direction-dependent Tailwind classes against a
handful of logical ones, so flipping `dir` would mirror padding, borders and
icon positions with no automated way to verify the result. That conversion is
its own project.

## Tooling

All under `app/scripts/`, and all used for the sweep above:

| Script | Does |
|---|---|
| `i18n-inventory.mjs` | AST-based count. `--dir`, `--list unlocalized`, `--json`. |
| `i18n-codemod.mjs` | Applies `t('k') \|\| 'English'`. `--dir --ns --apply`. Refuses anything ambiguous. |
| `i18n-wire-hooks.mjs` | Adds the hook to the function that actually calls `t()`, including inner components; rewrites plain modules to `translateNow`. |
| `i18n-extract-pairs.mjs` | Reads pairs back out of source, to stdout. |
| `i18n-write-ns.mjs` | Merges pairs into a dictionary. Never overwrites an existing value. |
| `i18n-orphans.mjs` | Dictionary keys nothing asks for. |
| `i18n-remove-keys.mjs` | Deletes keys by path from every dictionary at once. |

### Traps the sweep hit, all of which will recur

**A default parameter is not `??`.** Moving `t()` out of a signature into the
body must use `x === undefined ? … : x`. `??` also swallows an explicit `null`,
and callers pass `null` to opt out — `Button` does exactly that with `Spinner`'s
`label`, and `??` put "Loading" into a confirm button's accessible name.

**Key collisions with nested blocks.** The codemod derives a key from the
English, and several collided with existing nested objects (`agents.status`,
`analytics.outcome`, `shell.feedback`, `ds.select`). `t()` then resolves an
object, not a string. `keys-exist.test.ts` catches every one.

**Stale dependency arrays.** A memo or effect written before i18n existed gains
`t()` calls and keeps its old deps, freezing that value in the language the
screen first mounted in. ESLint's `exhaustive-deps` catches it; do not silence it.

**Double translation.** `useBreadcrumbs`'s `label()` already resolves through
`app.crumb.*`. Wrapping its argument in `t()` translates once and then looks the
*result* up as a key.

## The bug worth remembering

`preloadDictionary` loaded the dictionary and never notified subscribers, so a
**restored** language never re-rendered: a reader who chose Hindi and reloaded
saw English until some unrelated state change flushed the tree. `setLocale`
always notified after its own fetch, which is why the picker appeared to work
and a reload appeared not to — and why nothing caught it, since every test
exercised the switch and none the restore.

Covered now by `i18n/restoredLocale.test.ts`. That test needed two attempts: the
first subscribed after `setLocale` and saw `setLocale`'s own async notify, so it
passed against the bug. **Canary any i18n guard in both directions.**
