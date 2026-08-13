# OyeChats Feature: Widget Install, Branding & Customization

*Self-sufficient NotebookLM knowledge source on a single OyeChats feature. Evidence tags: [T1] = confirmed in code, [T2] = confirmed in product docs, [T3] = marketing positioning, [VERIFY] = unconfirmed, needs human check.*

---

## 1. What This Feature Is

OyeChats' AI agent isn't dropped onto a customer's website as a generic, boxy chat bubble. Two things happen at once: the widget goes live with **one line of code on almost any website platform** [T1], and it automatically **looks like it belongs to the business** — because its color and personality are extracted from the business's own site, not chosen from a generic template [T1].

This is two tightly linked capabilities:
- **Install** — a single `<script>` tag embed that works on plain HTML, WordPress, Shopify, Webflow, Next.js, React, Vue, Angular, Squarespace, Wix, Framer, Bubble, Astro, and sites using Google Tag Manager [T1, `app/src/design-system/icons/platformLogos.ts`].
- **Branding & Customization** — automatic brand-color and avatar detection during setup, plus a manual editor for brand color, message-bubble color, and launcher avatar [T1, `api/app/services/brand_color_extractor.py`, `favicon_extractor.py`, `app/src/features/launch-studio/steps/CustomizeStep.tsx`].

## 2. Who Cares & Why

- **Business owner / marketing lead** — cares that the chatbot doesn't look like an off-the-shelf plugin bolted onto their site. A widget that automatically matches brand color signals the product was built for *them*, not against a generic template [T3].
- **Developer / whoever installs it** — cares that install is genuinely one line, works regardless of their stack, and doesn't require a build step or SDK [T1].
- **Visitor** — never consciously notices "branding," but a widget with jarring, off-brand colors reads as untrustworthy; a matched one reads as native to the site.

## 3. How It Actually Works

**Automatic brand-color extraction** [T1, `brand_color_extractor.py`]
- When a business's website is crawled, OyeChats does a *second*, purpose-built fetch of the homepage's raw HTML (the crawler's normal ingestion path converts pages to markdown, which strips CSS — so a dedicated pass is needed).
- It parses colors out of `<style>` blocks, inline `style=""` attributes, `<meta name="theme-color">`, and up to 4 linked stylesheets (hex, `rgb()`/`rgba()`, and `hsl()`/`hsla()` notations, including modern CSS Color Level 4 syntax).
- Colors are ranked by frequency of appearance, and near-white/near-black/low-saturation greys are filtered out so the result is genuinely brand colors, not UI chrome.
- The top-ranked colors become the **recommended color swatches** shown to the customer during setup — a starting point, not a forced choice.
- This is cheap and deterministic: no LLM call, no headless browser, a handful of HTTP `GET`s.

**Automatic avatar extraction (favicon pipeline)** [T1, `favicon_extractor.py`]
- The same crawl also discovers the site's declared favicon / Apple touch icon from its `<head>`, ranking Apple touch icons (built as filled square app icons) above generic favicons, and preferring larger declared sizes.
- The best candidate is downloaded, validated as a real decodable image, and run through the **same processing pipeline used for a manual logo upload** (square-crop, resize to 512×512 PNG) — so an auto-detected favicon and a manually uploaded logo end up identical in quality.
- This becomes the bot's default avatar *only if the customer hasn't already set one* — it never silently overwrites a deliberate choice.
- Every fetch (homepage and each icon candidate) goes through SSRF-safe fetch helpers with redirect re-validation — a defensive/security detail, not customer-facing, but relevant to describing "how it works" honestly without implying an insecure open-fetch mechanism.

**Automatic tone/personality matching** [T1, `brand_tone.py`]
- Separately from color, the crawl also classifies the site's voice into one of eight curated tone presets: **Professional, Friendly, Playful, Concise & Direct, Empathetic, Technical/Expert, Luxury/Premium, Bold/Confident**.
- The selected preset's text is injected into the AI's system prompt as `BRAND TONE: ...`, so the AI's actual conversational voice — not just the widget's paint job — matches the business.
- The customer can override with free-text tone instructions at any time; the preset is a starting point, not a lock-in.

**Manual customization (Customize step)** [T1, `app/src/features/launch-studio/steps/CustomizeStep.tsx`]
The customer can adjust, with a live preview:
- **Brand color** — a color picker plus swatches (the auto-extracted "recommended" colors shown first, then a curated preset palette including the platform's own violet `#7C3AED`).
- **User message-bubble color** — the color of the *visitor's own* chat bubbles (separate from the brand/agent color).
- **Avatar** — one of three types:
  - `upload` — the business's own logo/image (default; either manually uploaded or auto-populated from the favicon extraction above).
  - `orb` — a premium abstract orb rendered in a chosen color, no image needed.
  - `mascot` — a generic bot icon rendered on the brand color as a background.
- **Launcher name** — the short prompt text shown near the chat bubble before a visitor opens it (default: "Have Questions?").

**One-line install** [T1, root `CLAUDE.md`, `app/src/data/widgetEmbed.ts`]
- The full production embed is two tags:
  ```html
  <script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
  <a href="https://www.oyechats.com/?ref=bot-xxx&utm_source=widget&utm_medium=referral"
     rel="nofollow" style="font-size:11px;color:inherit;opacity:0.7;text-decoration:none">Powered by OyeChats</a>
  ```
- The script is a self-contained ~416KB IIFE bundle: it reads its own `data-bot-key` attribute, injects its CSS, creates its own DOM container, and mounts an isolated React app that talks to the backend via an `X-Bot-Key` header. No build step, no npm install, no SDK integration required on the customer's site.
- It genuinely works on any platform with a `<body>` tag — same integration pattern as Intercom, Crisp, or Drift [T1].
- Workspaces with a `branding_removable` entitlement (a paid-plan feature) get a variant snippet *without* the visible "Powered by OyeChats" attribution line [T1] — this is a real, code-level plan-gated capability; the snippet shown varies by plan.
- **Why the attribution line is a real `<a>` tag, not a rendered widget element:** the widget mounts into a shadow root from JavaScript after a visitor *clicks* the launcher — so anything the widget itself renders, including any in-widget "Powered by" mark, is invisible to search crawlers (non-rendering crawlers execute no JS; rendering ones don't click). The `<a>` tag sitting directly in the customer's served HTML is the only attribution surface that's actually crawlable.

## 4. What It Looks Like

- **During setup (Customize step):** a two-color picker (brand color, user-bubble color) with clickable swatches, plus an avatar selector showing three tabs/options (upload / orb / mascot), all reflected instantly in a **live preview pane** on the same screen — the customer sees the actual widget update in real time as they adjust settings, not a static mockup [T1].
- **The widget itself, once live:** a floating launcher button (bottom-right convention, matching Intercom/Crisp/Drift-style placement) [T1, root `CLAUDE.md`], carrying either the uploaded logo, the colored orb, or the mascot icon, in the chosen brand color. A greeting/prompt bubble ("Have Questions?" by default) appears near the launcher.
- **The install snippet UI:** shown as copyable code in the dashboard's Deploy step — a visible two-line block the customer copies into their site.

## 5. A Real Scenario Walkthrough

A skincare brand signs up for OyeChats and points the setup flow at their existing website.

1. While the AI is reading the site's pages to build its knowledge base, OyeChats *also* fetches the raw homepage HTML separately and pulls out the site's actual palette — say, a deep forest green and a soft cream — filtering out the incidental white/grey/black that shows up on every page.
2. It finds the site's Apple touch icon in the page `<head>`, downloads it, and processes it into a clean 512×512 avatar.
3. It classifies the site's copy tone as closest to "Luxury/Premium" and quietly sets that as the AI's starting personality.
4. When the business owner reaches the Customize step, they don't start from a blank template — the widget preview already shows their green, their icon, and a premium tone in the sample replies. They tweak the user-message-bubble color slightly and switch the avatar from "upload" to a colored "orb" instead because they'd rather not use their icon at chat scale.
5. At Deploy, they copy a two-line snippet and paste it into their Shopify theme's HTML.
6. The widget goes live immediately — recognizably *their* brand, not a generic AI chat plugin — with no design work required from them and no involvement from a developer beyond pasting one snippet.

## 6. Capabilities vs Limits

**Confirmed capable of:**
- Extracting brand colors from live CSS (inline styles, `<style>` blocks, up to 4 linked stylesheets), covering hex/`rgb()`/`hsl()` notations [T1].
- Extracting a usable avatar from a site's declared favicon/touch-icon, with graceful fallback to conventional icon paths [T1].
- Classifying site tone into 8 presets and injecting it into the AI's actual conversational behavior, not just cosmetic labeling [T1].
- Manual override of every auto-detected value at any time [T1].
- Genuine one-line install across a documented broad set of website platforms/frameworks [T1].
- Plan-gated attribution removal (`branding_removable` entitlement) [T1].

**Known limits / not claimed:**
- Brand color extraction is best-effort and silently returns nothing (falling back to defaults) on network failure, a fully JS-rendered SPA homepage with no static CSS signal, or an unreachable site — this is by design, not a bug; it does not *always* succeed.
- Favicon extraction only accepts raster-decodable formats the avatar pipeline can process; SVG favicons are explicitly skipped (Pillow-based processing can't rasterize SVG).
- No claim exists in code or docs about extracting brand *fonts* or *logos-as-vector* — only color and a raster avatar image. [VERIFY: confirm no separate font-matching feature exists elsewhere before assuming typography matching.]
- The Vite dev server build cannot be embedded cross-origin on external sites (developer-facing limitation, not customer-facing, noted here only for completeness).

## 7. Evidence & Open [VERIFY] Items

- All core mechanics (color extraction, favicon extraction, tone presets, manual customization UI, one-line install, platform breadth, plan-gated attribution removal) are [T1] — confirmed directly in `api/app/services/brand_color_extractor.py`, `favicon_extractor.py`, `brand_tone.py`, `app/src/features/launch-studio/steps/CustomizeStep.tsx`, `app/src/data/widgetEmbed.ts`, `app/src/design-system/icons/platformLogos.ts`, and root `CLAUDE.md`.
- **[VERIFY]** Whether brand-color/tone extraction happens automatically during the standard Launch Studio Train step for every new bot, or whether it requires an explicit action — the service modules confirm the *capability* exists and is wired to the crawl orchestrator, but this doc does not independently trace the exact trigger point in `crawl_orchestrator.py`.
- **[VERIFY]** No font/typography-matching capability was found in code — only color and a raster avatar are confirmed.
- Per this session's platform-wide brand guidance: never depict the widget's `branding_removable` attribution-free variant as the default for all customers — it is confirmed plan-gated, not universal.
