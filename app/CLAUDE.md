# OyeChats Console — the rebuild mandate

> This supersedes the "Admin Platform 2.0" mandate. That rebuild shipped a shell,
> a violet design system and a seven-step onboarding wizard, and a five-part
> audit of the result catalogued **235 defects**. It is not being iterated on; it
> is being replaced. The root `../CLAUDE.md` remains the **technical** reference
> — backend, APIs, DB models, auth, dev commands — and all of it still applies.

**Read [`DESIGN.md`](DESIGN.md) before writing anything visual.** Read
[`REBUILD.md`](REBUILD.md) for what is being built, in what order, and what must
not be lost on the way.

## What went wrong, so we do not repeat it

The 235 defects were not carelessness. They are what happens without a system:

- **Three parallel component libraries.** 71 of 465 modules were unreachable.
  Several dead components were *more capable* than the live ones — the unused
  data table sorted; the one every page rendered could not.
- **Two token layers that disagreed.** The most-used text colour was 2.56:1
  across 505 uses. Seven tokens were referenced and never defined, so table
  header rows rendered transparent. Two focus colours, three ring widths.
  Spacing and type tokens: zero uses, against 1,274 arbitrary `text-[Npx]`.
- **Primitives that did not exist, re-invented per page.** Seven toggles. Six
  chart palettes. Five drawers. Twelve copies of one loading block. 203 native
  `title` attributes standing in for a tooltip. `sonner` installed and a full
  toast system written — the provider never mounted.
- **Onboarding that removed the product in order to teach it.** A full-screen
  wizard outside the shell whose final step hard-blocked on a third-party ping
  with no skip, and whose every step was a degraded copy of a page that already
  existed.
- **Backend capability with no UI**, including roughly 110 super-admin endpoints
  with no console at all.

## Non-negotiables

1. **One design system: `src/ui/`.** A feature may not define a visual
   primitive. If a screen needs one that does not exist, it goes into `src/ui/`
   first, with a test for its keyboard contract and an entry in `/dev/ui`.
2. **Nothing is lost.** `REBUILD.md` carries a capability ledger of every
   backend endpoint and field the UI does not currently expose. Each item has an
   owner surface. Rebuilding a page means closing its ledger entries, not
   reproducing what was there.
3. **Every surface ships four states** — loading, empty, error, forbidden.
4. **WCAG 2.2 AA is a requirement, not a goal.** One focus ring, real roles, a
   keyboard path through every table and the inbox, live regions for async
   results, and a 24px minimum target in dense rows.
5. **Verify, do not assume.** Contrast is computed, not eyeballed. Dead code is
   proven dead by walking the import graph. A component is reviewed by looking
   at it in `/dev/ui`, not by reading its diff.
6. **`lint`, `typecheck`, `build` and the full test suite pass on every commit.**

## How to work

Analyse → plan → explain the trade-offs → build → review against `DESIGN.md` →
refactor. Do not implement a large surface in one pass. When a decision is
genuinely open, state the options and the recommendation rather than picking
silently.

Think like the team this product deserves: a principal product designer, a
principal frontend architect, and a senior engineer who has to maintain it.
Ask constantly whether Linear, Stripe or Intercom would build it this way — and
when the answer is no, say what they would do instead.
