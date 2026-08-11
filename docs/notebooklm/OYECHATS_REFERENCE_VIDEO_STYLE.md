# OyeChats — Reference Video Visual Language

*Creative-director analysis of the reference video `The_Active_Web__Engineering_Conversion_with_OyeChats.mp4` (supplied by the user, ~3:51 runtime, itself a prior NotebookLM output the team liked). Analysis is based on direct frame-by-frame inspection (15 frames extracted at 15-second intervals and visually reviewed), not a text summary of the video's spoken content. This document describes visual language only — it is a style reference for future generation, not a claim about OyeChats product features.*

---

## Overall Creative Direction

A tactile, handcrafted **papercraft/origami diorama** aesthetic applied to digital/AI subject matter. Every element — UI, devices, speech bubbles, icons, and even human characters — is rendered as if physically cut, folded, and embossed from thick craft paper, then shot as a miniature tabletop scene with a macro lens. The core creative tension is deliberate: analog, warm, handmade materials telling a story about a very modern AI product. This is what keeps it from reading as generic 3D-render "AI slop" — the medium itself is a visual metaphor (see Visual Metaphors below).

---

## Cinematography

- **Camera movement:** Slow, controlled push-ins and gentle pans; no whip pans, no shake, no handheld feel. Movement is deliberate and unhurried, consistent with a premium/considered brand tone.
- **Lens feel:** Macro/tabletop-photography framing — the camera sits close on one hero object per shot rather than using wide establishing shots. Emulates product/food photography more than motion-graphics compositing.
- **Framing:** Tight, off-center compositions favoring a single subject with generous soft-focus surroundings (e.g., a close crop on one glowing button with other UI cards receding into blur).
- **Shot duration:** Each concept gets its own dedicated shot rather than rapid intercutting — pacing is measured, not frenetic.
- **Camera transitions:** Cuts between distinct dioramas/objects rather than continuous camera travel through one large scene; each shot is its own self-contained vignette.
- **Depth of field:** Consistently shallow — the hero object is crisp, everything else (background paper sheets, secondary UI cards) is visibly soft, reinforcing the macro-photography read.
- **Composition:** Rule-of-thirds-style off-center placement, with the glowing/highlighted element as the clear focal anchor in nearly every frame.
- **Pacing:** Calm and confident, not hyperactive — consistent with the brand tone principle of "trusts the product to be impressive on its own" (see `docs/oyechats-marketing-story.md` Brand Guidelines).

---

## 3D Design Language

- **Object types observed:** Folded-paper website/app UI mockups (nav bars, buttons, cards, dropdowns), a folded-paper smartphone held in paper hands, folded-paper speech bubbles, a fanned stack of paper app-icon cards, a paper "User Profile" card, folded-paper humans, and a distinct geometric robot mascot.
- **Materials:** Thick craft-paper stock with visible fiber/grain texture, soft die-cut rounded edges, and embossed (raised) or engraved (recessed) surface detail for lettering and icons — never a flat printed decal look. One recurring exception: the robot mascot and some structural edges use a metallic gold/silver foil-like material for contrast against the matte paper.
- **Scale:** Consistently miniature/diorama scale — objects read as desk-sized props (a UI mockup the size of a greeting card, a phone the size of a real handheld phone) rather than architectural or abstract-infinite scale.
- **Realism:** Stylized-realistic — believable paper physics (layered depth, soft shadows between layers, visible fold seams on character limbs) rather than flat cartoon or hyperrealistic CG.
- **Environments:** Neutral studio surfaces — soft gray tabletop for UI/object shots, warm wood-grain desk for character-driven shots (e.g., a person on a phone). Backgrounds are minimal, uncluttered, and never busy.
- **Physical metaphors:** A phone notification is a small glowing paper speech-bubble tag; "data/analysis" is represented as a stack of embossed paper pill-labels (QUERIES, ANALYSIS, INSIGHTS, DATA) arranged like index cards; qualification/scoring is implied through fanned stacks of small UI cards.
- **Object movement:** Gentle, physically plausible — cards fan out, a bubble settles into place — never rigid/robotic keyframe snapping.

---

## Lighting

- **Direction:** A single dominant soft key light, typically from above/behind, consistent with studio product photography.
- **Contrast:** Low-to-moderate overall contrast on the paper surfaces themselves (soft, diffused), punched up locally by one bright glowing accent per shot.
- **Shadows:** Soft, realistic, cast between paper layers to sell physical depth (a card floating slightly above another visibly shadows it).
- **Volumetric atmosphere:** Present but subtle — a soft warm haze/bloom around the glow sources, not heavy fog or dramatic god-rays.
- **Highlights:** The signature device — nearly every shot has exactly one object glowing warm-amber/gold from *within* (a button, a speech bubble, a phone screen), functioning as the "this is the important thing" cue.
- **Reflections:** Minimal — paper is matte by nature; only the metallic robot/foil elements show any specular reflection.

---

## Color System

*(Hex values below are OyeChats' own documented brand colors, cross-referenced against what the reference video's palette family visually resembles — the reference video itself was not source-code-inspectable for exact hex values, so no exact hex is asserted for the video itself beyond this qualitative match.)*

- **Background colors:** Warm cream/ivory/beige paper tones and soft neutral studio grays dominate every frame — this directly matches OyeChats' own "Paper" neutral (`#FAFAF7` family, see `OYECHATS_BRAND_GUIDELINES.md`).
- **Primary UI colors:** Paper-white and warm taupe/tan for the "canvas" objects themselves (cards, phone bodies, speech bubbles).
- **Accent colors:** A single warm gold/amber glow is the reference video's own accent choice — this does **not** match OyeChats' actual brand accent (Volt violet `#7C3AED`). See Adaptation Rules below for the required correction.
- **Highlight colors:** Reserved exclusively for the "important thing" in a shot (a button, a bubble, a screen) — never used as a background wash.
- **Semantic color use:** A small number of muted secondary colors appear only on functional icons (a dusty-rose folder icon, a muted blue circular icon) — color is used sparingly, purely for iconographic differentiation, never as a mood-setting wash.

---

## UI Design Language

- **Panel treatment:** UI chrome (nav bars, cards, browser frames, phone bezels) is rendered as layered, stacked paper cutouts with soft drop shadows between layers — real physical depth standing in for what would normally be flat 2D screenshot compositing.
- **Typography:** In-scene lettering is engraved/debossed directly into the paper surface, generally set in small caps or all caps for labels (MENU, SERVICES, USER PROFILE, QUERIES, ANALYSIS) — a stationery/print-shop feel rather than a digital UI font rendering.
- **Borders:** Soft, rounded, die-cut paper edges function as the border language — no hard digital strokes or drop-shadow-as-css-effect look.
- **Cards:** Raised paper cards with embossed labels and soft shadow separation; sometimes fanned in a stack to suggest a data set or option list.
- **Buttons:** Raised paper tabs/pills with engraved text, occasionally glowing from within when active/highlighted.
- **Data visualization:** Represented abstractly via stacked labeled paper pills rather than literal charts/graphs.
- **Motion in UI:** Elements settle, fan, or glow into view with gentle easing rather than snapping or sliding aggressively.
- **Hierarchy:** Achieved almost entirely through focus (sharp vs. blurred) and glow (lit vs. unlit), not through color-coding or size extremes.
- **Density:** Low — one idea per shot, generous negative space, never a cluttered dashboard-style composition.
- **Realism:** UI is stylized as a physical object, not as a rendered screen — this is the single most distinctive design choice in the reference.

---

## Animation Language

- **Easing:** Soft, gentle ease-in/ease-out throughout — nothing linear or mechanical.
- **Speed:** Unhurried; elements take their time settling into frame.
- **Transitions:** Cut-based between distinct vignettes rather than complex whip transitions or match-cuts; when movement carries across a cut, it's simple (a light sweeping across a scene).
- **Object movement:** Cards fan open, bubbles rise into place, a hand naturally lifts a phone — physically plausible, not keyframe-robotic.
- **UI motion:** Glows pulse gently; labels don't "type on" character by character, they simply resolve into focus.
- **Data flow:** Implied through spatial arrangement (cards fanning from a source point) rather than literal animated arrows/lines/particles.
- **Camera-to-UI transitions:** The camera moves to reveal UI as a physical object coming into focus, rather than UI elements flying onto a flat 2D plane in front of the camera.

---

## Visual Metaphors

- **"The website is made of paper, and the AI reads it"** — the entire UI-as-paper conceit visually literalizes "reading a website" as physically handling paper documents, which maps precisely onto OyeChats' actual ingestion behavior (reading pages, PDFs, brochures) — a strong, honest metaphor rather than a decorative one.
- **The glow = "this is the meaningful moment"** — used consistently as the sole cue for importance across very different subjects (a button, a message, a notification), giving the video a unified visual grammar without needing on-screen text callouts.
- **The origami robot vs. paper humans** — a deliberate material contrast (cold folded-metal geometry vs. warm soft paper) visually separates "the AI" from "the people," which maps well onto OyeChats' own human-AI positioning (see `OYECHATS_MASTER_KNOWLEDGE.md` Section 10 — AI assists, humans decide/close).

---

## AI-Slop Avoidance

What makes this reference read as premium rather than generic AI-generated content, and what to explicitly protect against when generating new material in this style:

- **Avoid:** glassy/glossy plastic 3D-render look (the common "generic AI SaaS explainer" material finish) — the reference deliberately uses matte, textured, physically-grained paper instead.
- **Avoid:** neon/oversaturated gradients as scene-dominant color — the reference keeps color minimal and purposeful; a wash of gradient color across a whole frame would break the premium read immediately.
- **Avoid:** hyperactive camera movement or rapid-fire cutting — the calm, macro-photography pacing is load-bearing to the "premium/handcrafted" feel; speeding it up reads as generic motion-graphics filler.
- **Avoid:** literal, cliché AI iconography (glowing brains, circuit-board patterns, floating binary code) — none of these appear in the reference; the "AI" is represented through the geometric origami robot instead, which is more original and on-brand.
- **Avoid:** text-heavy UI screens crammed with data — the reference's low-density, one-idea-per-shot approach is part of why it feels crafted rather than templated.
- **Protect:** the tactile paper-grain texture and soft physical shadows — if regenerated without visible paper texture/grain, the concept collapses into generic flat 3D and loses the entire premise.

---

## OyeChats Adaptation Rules

How this reference style should be adapted for OyeChats specifically, without copying unrelated content or misrepresenting the brand:

1. **Keep the papercraft/diorama medium, macro cinematography, and lighting approach wholesale** — this is the strongest, most distinctive, most "premium" part of the reference and requires no correction.
2. **Re-key the glow accent from warm gold to OyeChats' actual Volt violet** (`#7C3AED` on light paper, `#A78BFA` on darker paper) — the reference's gold-glow choice is not an OyeChats brand color; swapping only this one variable is what turns "a nice papercraft AI video" into "an unmistakably OyeChats video." Reserve gold, if used at all, for a one-off non-recurring metaphor (e.g., a trophy/coin), never as the repeated highlight color.
3. **Keep the dominant neutral field as warm paper/cream tones** — this already matches OyeChats' own "Voltage Paper" theme almost exactly; no correction needed here.
4. **Do not depict specific real OyeChats dashboard screens inside the paper-diorama style** — the reference's UI mockups are generic/abstract (a browser bar labeled "Services," a "User Profile" card). Real OyeChats UI (leads list, chat window, widget) should be evoked abstractly in the same paper-craft language, not reproduced as literal screenshots pasted into a paper frame — that would visually clash with the handcrafted medium.
5. **Use the origami-robot-vs-paper-human material contrast specifically in the handoff moment** — it is the single best available visual for "AI qualifies, human closes" (see `OYECHATS_MARKETING_VIDEO_KNOWLEDGE.md` Human Moments), and it is already present and well-executed in the reference.
6. **Do not import unrelated reference-video content** (e.g., any specific spoken claim, statistic, or on-screen text from the reference video) into OyeChats material — this document analyzes visual style only; product claims must come exclusively from `OYECHATS_MASTER_KNOWLEDGE.md` and `OYECHATS_SOURCE_OF_TRUTH.md`.
