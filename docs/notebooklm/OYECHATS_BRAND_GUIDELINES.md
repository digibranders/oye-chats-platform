# OyeChats — Brand Guidelines

*Extracted and organized from live brand source files, actively-rendering application code, and the approved marketing narrative. Where a value is exact (hex, font name, file path), it is preserved exactly — never approximated. Where something is not specified anywhere in inspected sources, this document says so explicitly rather than inventing a value. See `OYECHATS_SOURCE_OF_TRUTH.md` for full evidence citations.*

---

## Brand Identity

**Name:** OyeChats.

**Tagline (approved, verbatim):** "OyeChats. You only talk to buyers." **[T3 — live site title/meta, `oyechats-website/src/app/layout.tsx`]**

**Positioning line (approved, verbatim):** "AI chatbot that qualifies every visitor with BANT scoring before your sales reps see them. RAG-grounded answers, live handoff, webhooks, and analytics." (site meta description — technical terms like "BANT" and "RAG-grounded" belong on the technical/site-meta surface; for buyer-facing/video material use the plain-language equivalent in `OYECHATS_MARKETING_STORY.md`'s Final Brand Message instead.) **[T3]**

**Theme name:** "Voltage Paper" — a named design theme confirmed directly in the website's own stylesheet comments. **[T1 — `oyechats-website/src/app/globals.css`]**

---

## Brand Personality

Not specified as an explicit personality/archetype document anywhere in inspected sources. What can be reliably inferred from consistent evidence across the tone guidance and visual system:

- Confident, direct, plain-spoken — "trusts the product to be impressive on its own; it doesn't oversell it." **[T3 — `docs/oyechats-marketing-story.md` Brand Guidelines]**
- Premium and warm rather than cold/clinical — the "Voltage Paper" theme is explicitly framed against "generic dark-mode SaaS tool" and "neon/gamer-purple" as things it is *not*. **[T3]**
- Honest over impressive — the product's own architecture (relevance gate, honest refusals, groundedness auditing) reflects a brand value of not overstating what the AI knows; this is a product-level, not just copywriting-level, trait. **[T1/T2 — `docs/oyechats-technical-story.md` Part 6.6]**

This is a synthesized inference, not a quoted personality statement — treat as directionally reliable, not as an approved verbatim brand-personality document.

---

## Brand Positioning

**Approved positioning (verbatim tagline):** "You only talk to buyers." — the product exists to filter/qualify so a business's human time is spent only on visitors worth it. **[T3]**

**Not specified:** a formal positioning statement (e.g., "For [audience], who [need], OyeChats is the [category] that [benefit], unlike [alternative]") does not exist in any inspected source. Do not invent a category comparison or named-competitor positioning.

---

## Logo Rules

**⚠️ Several logo concepts exist in the codebase. Two are confirmed live in production (an icon mark and a full wordmark, which share the same glyph and are consistent with each other); two more are confirmed dead. This section documents all findings so nothing is silently merged or guessed at.**

### The authoritative, current icon mark (Admin Dashboard)

- **File paths (code):** `app/public/logo-light.png` (solid near-black, for light backgrounds) and `app/public/logo-dark.png` (solid white, for dark backgrounds).
- **Live URLs (confirmed HTTP 200):** `https://app.oyechats.com/logo-light.png`, `https://app.oyechats.com/logo-dark.png`.
- **Confirmed live rendering:** `app/src/shell/OyeChatsMark.tsx` renders both files as the Admin Dashboard's sidebar brand glyph, theme-aware via Tailwind `dark:` variant, `object-contain`, explicitly "no invert/crop" per the component's own code comment. **[T1 — direct source inspection]**
- **Shape description:** A rounded, bold "C"-shaped ring reading simultaneously as the OyeChats initial and a speech bubble, with three dots inside (an active "typing…" indicator) and a small chat-tail notch where the ring breaks at the bottom.
- **Color rule:** Strictly single-color — pure near-black on light backgrounds, pure white on dark backgrounds. **Never rendered in Volt violet or any other color.**
- **Related assets:** cropped/square favicon `app/public/oye_favicon_cropped.png`; small favicons `favicon-32.png`, `favicon-192.png`.

### The authoritative, current full wordmark (Marketing Website)

- **Live URLs (confirmed HTTP 200):** `https://www.oyechats.com/oyechats-wordmark.png` (solid near-black glyph, for light backgrounds) and `https://www.oyechats.com/oyechats-wordmark-light.png` (white/transparent glyph, confirmed via pixel inspection, for dark backgrounds).
- **Now also present in the local repo** at `oyechats-website/public/oyechats-wordmark.png` and `oyechats-wordmark-light.png` — copied down directly from the live production URLs above, since the local working copy was 2 commits behind `origin/development` and did not have them. The commit that introduces this wordmark, `5a9bca8 feat(logo): implemented new logo`, is already merged into `origin/main`; a `git pull` on `development` would bring the source-level change in properly, but was not run here because the local checkout has pre-existing uncommitted changes to unrelated files (`HomeContent.tsx`, `layout.tsx`, `Analytics.tsx`, `HeroDemo.tsx`, `seo.ts`) — copying the asset files directly avoids touching that in-progress work. **Recommend the team runs `git pull` on `oyechats-website` (development branch) once those uncommitted changes are resolved, so `src/components/site/Logo.tsx` itself is updated too** — see note below.
- **Shape description:** A full wordmark reading "Oyechats" — "Oye" set in a flowing cursive/script face, "chats" set in a bold sans face — where **the "C" of "chats" is rendered as the exact same ring-with-three-dots speech-bubble glyph as the Admin Dashboard's icon mark above.** This is the detail that matters most: the two live marks are not competing concepts, they are the same glyph used two ways (standalone icon vs. embedded in a wordmark).
- **Important — the local repo's source code has not caught up to this asset yet:** `oyechats-website/src/components/site/Logo.tsx` (as checked out locally) still renders `/oyechats-mark.png` (the older navy chat-bubble icon, see "Rejected" below) with its own code comment: *"OyeChats brand, the navy chat-bubble mark + wordmark."* That comment is now stale — the actual production homepage does not render `oyechats-mark.png` at all (confirmed 404 on `https://www.oyechats.com/oyechats-mark.png`); it renders the wordmark files above via Next.js image optimization. **[VERIFY]** exactly which component in the *current* `origin/main` source (post `5a9bca8`) replaced `Logo.tsx`'s old image reference — not independently re-read in this pass, only inferred from the live HTML output and the commit message.

### Rejected / superseded concepts (do not use)

1. **`oyechats-website/public/oyechats-mark.png`** (navy chat-bubble icon) — present in the local repo and still referenced by the local copy of `Logo.tsx`, but **confirmed 404 on the live production site** (`https://www.oyechats.com/oyechats-mark.png` no longer resolves) — production has moved on to the wordmark above. Status: **superseded in production; local repo checkout simply hasn't caught up yet. Do not use for new material.**
2. **`docs/logos/_logo-workspace.html`** — a programmatic SVG generator exploring a completely different concept: three concentric "signal arc" sweeps (a WiFi/broadcast-signal motif) in an indigo-to-electric-blue gradient (`#4F46E5` → `#2563EB` light mode, `#818CF8` → `#60A5FA` dark mode), paired with an "OyeChats" wordmark in Inter Bold. Git history shows this file dates to April 2026, months before either current mark. **No live consumer of this asset was found anywhere in the codebase.** Status: **dead design exploration — do not use.**
3. **`widget/src/components/OyeChatsLogo.jsx`** — a React component rendering a blocky white glyph on an orange/terracotta (`#E0A98F`/`#E8A87C`) background, entirely unrelated to any other brand color in the system. A repo-wide search confirms **this component is not imported or rendered anywhere else in the widget** — it is orphaned/dead code, not a real product surface. Status: **dead code — do not use, and do not treat its colors as brand colors.**

### Logo usage

- **For an icon-only mark** (favicon, avatar, square placements): use `logo-light.png` / `logo-dark.png` from the Admin Dashboard.
- **For a full lockup with the wordmark** (video title cards, website-style placements): use `oyechats-wordmark.png` (light backgrounds) / `oyechats-wordmark-light.png` (dark backgrounds).
- Both are the same glyph system and may be mixed on the same project — icon alone for tight spaces, full wordmark for hero/title placements.
- Do not attempt to recolor either file; use the correct pre-made light/dark variant instead.
- Do not apply gradients, drop shadows, or color tints to either mark.
- Not specified in provided brand guidelines: minimum clear-space rules, minimum size rules, or a formal logo-misuse gallery. If a video generator needs a hard clear-space rule, none is available to cite — leave generous, unforced whitespace around the mark as a safe default rather than inventing a numeric rule.

---

## Colors

Exact hex values, confirmed directly in `oyechats-website/src/app/globals.css` (the "Voltage Paper" theme) unless noted:

| Role | Hex | Notes |
|---|---|---|
| Paper (primary background) | `#FAFAF7` | Warm off-white; the dominant field, never pure white |
| Canvas | `#FFFFFF` | Cards/surfaces on top of Paper |
| Ink (primary text) | `#0A0A0A` | Near-black, not pure black |
| Ink-2 (secondary text) | `#3F3F46` | |
| Muted text | `#71717A` | |
| Line / hairline borders | `#E7E5DE` | Warm-toned, not cool gray |
| Dark section background | `#14101E` | Has a violet undertone, not neutral black |
| Dark section text | `#F5F1FA` | |
| **Volt (primary brand accent)** | **`#7C3AED`** | The signature color — CTAs, highlights, key emphasis. A single accent, not a background wash. |
| Volt hover/pressed | `#6D28D9` | |
| Volt on dark surfaces | `#A78BFA` | |
| Volt tint (light accent fill) | `#FDF4FF` | |
| Volt hairline | `#DDD6FE` | |
| Volt ink (accent text on light) | `#5B21B6` | |
| Success | `#0B7A45` (text) / `#0F9D58` (graphics/icons) | |
| Warning | `#B45309` | |
| Danger/error | `#B91C1C` | |

**Cross-check:** the Admin dashboard's separate "Enterprise Purple" design-system theme (`design-system/README.md`) independently arrives at the same violet lineage, finalized at `#7C3AED` primary / `#A78BFA` on dark — the accent color is corroborated across two independent design surfaces, strengthening confidence in it as the true brand accent. **[T1]**

**Explicitly not brand colors, despite appearing in the codebase:** the indigo/blue gradient (`#4F46E5`→`#2563EB`) from the rejected `_logo-workspace.html`, and the orange/terracotta (`#E0A98F`/`#E8A87C`) from the dead `OyeChatsLogo.jsx` — both are unused explorations, not approved palette.

---

## Typography

Confirmed via `next/font/google` imports in `oyechats-website/src/app/layout.tsx`:

- **Headings / display:** Geist
- **Body text:** Inter
- **Monospace (code, technical labels):** Geist Mono
- **Editorial accent (pull-quotes, testimonials only):** Fraunces, italic — used sparingly, never for UI or body copy

**Conflict note:** the rejected `_logo-workspace.html` wordmark exploration used plain Inter Bold for an "OyeChats" logotype text. Since that file is a dead exploration (see Logo Rules above), this does not override the confirmed Geist/Inter/Geist Mono/Fraunces system — it is noted only for completeness.

**Not specified in provided brand guidelines:** a formal type scale (specific heading sizes/weights), or rules for type pairing beyond the four roles above.

---

## UI Principles

Sourced from the Admin Platform 2.0 build mandate (`app/CLAUDE.md`), which governs the current dashboard rebuild:

- Visual language: "Premium · Elegant · Professional · Minimal." Focus on hierarchy, whitespace, typography, spacing, motion, information density, consistency.
- Explicitly to avoid: "giant gradients, neon glows, overly rounded cards, glassmorphism everywhere, purple overload, or random decorative effects." **[T1 — direct quote, `app/CLAUDE.md`]**
- Progressive disclosure preferred over long forms/settings overload; show value before asking for configuration; explain loading/progress/success states; avoid technical language where possible.

**Note the internal tension worth flagging:** the mandate explicitly warns against "purple overload" in UI, while the brand's own signature accent color *is* violet (`#7C3AED`). Read together, the intended balance is: violet as a **deliberate, restrained accent** (buttons, highlights, key moments) — never as a dominant wash across a screen. This matches the "single accent, not a background" rule already stated in the Colors section, and should be treated as the same principle applied consistently across both the marketing site and the product UI.

---

## Imagery Principles

Not specified as a formal photography/illustration style guide anywhere in inspected brand sources. The one concrete, evidenced imagery direction available is the reference video's papercraft/origami style, fully documented separately in `OYECHATS_REFERENCE_VIDEO_STYLE.md` — treat that document as the imagery-style authority for any generated video/marketing visuals, since no separate static imagery guideline exists.

---

## Visual Tone

- Warm, editorial, premium print/stationery feel over clinical SaaS-dashboard feel — explicit in the "Voltage Paper" theme naming and its stated contrast against "generic dark-mode SaaS tool." **[T1/T3]**
- Restrained color use: one accent color, used deliberately, against warm neutral fields — consistent across the website theme, the admin design system, and the UI-principles mandate above.

---

## Motion Principles

Not specified in provided brand guidelines as a formal motion-design document. The only evidenced motion-adjacent guidance is the UI-principles mandate's inclusion of "motion" as a dimension to get right without specifying exact easing/duration values, and the reference video's own animation language (documented in `OYECHATS_REFERENCE_VIDEO_STYLE.md` — gentle easing, unhurried pacing, physically plausible movement). Use the reference video's animation language as the closest available guidance for any generated motion content.

---

## Tone of Voice

- Confident, direct, plain-spoken — short declarative sentences.
- No hype-adjective stacking ("revolutionary," "game-changing," "cutting-edge").
- No filler; trusts the product to be impressive without oversell.
- Mirrors the tagline's own economy: "You only talk to buyers." — six words, no adjectives, a clear customer benefit stated plainly. **[T3 — `docs/oyechats-marketing-story.md` Brand Guidelines, "Tone for narration/voiceover"]**

---

## Messaging Principles

- **Preserve actual product terminology where it reflects the current standardized language:** "AI Agent" (not "bot," in customer-facing contexts), "Conversation" (not "session"), "Operator" (not "agent," which is reserved for the AI/AI Agent — a deliberate disambiguation), "Lead" (not "contact"), "Train"/"Training" (not "crawl," in customer-facing contexts). See `OYECHATS_SOURCE_OF_TRUTH.md` for the full terminology-mapping evidence and status.
- **Distinguish product truth from marketing framing explicitly** — every claim in future material should be traceable to either an implemented capability or a clearly-labeled positioning choice, per the evidence-tier system used throughout this documentation package.
- **Never state a number that isn't sourced** — no ROI, conversion-rate, customer-count, or revenue claim exists in any inspected source; do not introduce one.

---

## Things to Avoid

- Do not use the navy `oyechats-mark.png`, the indigo/blue signal-arc concept, or the orange/terracotta `OyeChatsLogo.jsx` glyph as the OyeChats logo in any new material — only `logo-light.png`/`logo-dark.png` is confirmed current and live.
- Do not use violet as a background wash — it is a single accent color by explicit design intent (both the theme's own naming and the UI mandate's "avoid purple overload" instruction agree on this).
- Do not use generic AI-hype language in copy or narration.
- Do not invent a formal brand-personality archetype, a positioning statement against named competitors, minimum logo clear-space/size rules, a type scale, or a motion-design spec — none exist in inspected sources; if any of these are needed, they must be authored and approved as new brand work, not inferred here.
