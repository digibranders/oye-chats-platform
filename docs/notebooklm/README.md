# OyeChats — NotebookLM Knowledge Package

This folder is a purpose-built documentation package for uploading into Google NotebookLM, which will later be used to generate a 1–2 minute cinematic OyeChats marketing video. **This package does not contain a video prompt or the video itself** — it is the source material NotebookLM should draw from so the video is accurate, on-brand, and free of invented claims.

It was built by auditing the actual OyeChats codebase and documentation (not just filenames) — including direct inspection of `CLAUDE.md`, `app/CLAUDE.md`, `docs/oyechats-technical-story.md`, `docs/oyechats-marketing-story.md`, live brand assets (verified via HTTP), several React/Vite source files (`OyeChatsMark.tsx`, `Launcher.jsx`, `OyeChatsLogo.jsx`, `platformLogos.ts`), the "Voltage Paper" theme's actual CSS, and frame-by-frame analysis of the reference video the team liked.

---

## Files in This Package

| File | Purpose |
|---|---|
| **`OYECHATS_MASTER_KNOWLEDGE.md`** | **Primary source.** The full product truth in business language — what OyeChats is, who it's for, its capabilities, journeys, outcomes, and product surfaces. Every claim is evidence-tagged. Start here. |
| `OYECHATS_MARKETING_STORY.md` | The approved marketing narrative, restructured into story beats (problem → turning point → new experience → value → differentiation → messaging). Not a copy of `docs/oyechats-marketing-story.md` — a transformation of it into narrative-order knowledge. |
| `OYECHATS_MARKETING_VIDEO_KNOWLEDGE.md` | Translates the above into what a **1–2 minute video specifically** needs: objective, viewer profile, a 90–120s narrative arc, which product/UI/human moments to show, and what to deliberately leave out. |
| `OYECHATS_REFERENCE_VIDEO_STYLE.md` | Creative-director analysis of the reference video's visual language (papercraft/origami diorama style) — cinematography, materials, lighting, color, UI/animation language, and explicit rules for adapting it to OyeChats (most importantly: re-key its gold glow accent to OyeChats' actual violet). |
| `OYECHATS_BRAND_GUIDELINES.md` | Brand identity, logo rules (including a resolved 4-way logo conflict — only one mark is confirmed live), exact colors/fonts, tone of voice, and things to avoid. Values are exact where sourced, and explicitly marked "not specified" where no source exists — nothing is approximated or invented. |
| `OYECHATS_NOTEBOOKLM_QUICK_CONTEXT.md` | A single, highly compressed executive-context document — everything above, condensed to its essentials. Use this if NotebookLM needs a fast-load overview alongside the deeper documents. |
| `OYECHATS_SOURCE_OF_TRUTH.md` | The claim-by-claim evidence matrix underlying every other document. This is what prevents NotebookLM from treating an unverified or conflicting detail as settled fact. If a claim in any other document looks surprising, check here first. |

---

## What to Upload to NotebookLM

**Upload all seven content files** (everything above except this README, which is navigation for humans, not source material for NotebookLM). NotebookLM handles multiple sources well and cross-references between them, so there's no need to pre-merge them into one file.

If a NotebookLM notebook has a source-count limit that forces prioritization, upload in this order:
1. `OYECHATS_MASTER_KNOWLEDGE.md` (must-have)
2. `OYECHATS_SOURCE_OF_TRUTH.md` (must-have — this is the guardrail)
3. `OYECHATS_MARKETING_VIDEO_KNOWLEDGE.md` (must-have — this is what shapes the actual video)
4. `OYECHATS_REFERENCE_VIDEO_STYLE.md` (must-have if visual style matters, which it does here)
5. `OYECHATS_BRAND_GUIDELINES.md`
6. `OYECHATS_MARKETING_STORY.md`
7. `OYECHATS_NOTEBOOKLM_QUICK_CONTEXT.md` (nice-to-have — a compressed backup if others are dropped)

## Primary Source

**`OYECHATS_MASTER_KNOWLEDGE.md`** is the primary source. Every other document either derives from it (marketing story, video knowledge) or supports a specific dimension of it (brand, reference-video style, source-of-truth evidence).

## How the Documents Relate

```
OYECHATS_SOURCE_OF_TRUTH.md  ───────────────┐  (evidence backbone — every other doc cites this)
                                              │
OYECHATS_MASTER_KNOWLEDGE.md  ◄──────────────┘  (primary source — product truth in business language)
        │
        ├──► OYECHATS_MARKETING_STORY.md            (product truth → narrative story beats)
        │           │
        │           └──► OYECHATS_MARKETING_VIDEO_KNOWLEDGE.md   (story beats → 90–120s video arc)
        │
        └──► OYECHATS_BRAND_GUIDELINES.md            (product truth → visual/verbal identity rules)
                    │
                    └──► OYECHATS_REFERENCE_VIDEO_STYLE.md   (brand rules + reference video → adaptation rules)

OYECHATS_NOTEBOOKLM_QUICK_CONTEXT.md  =  compressed summary of all of the above
```

## Unresolved [VERIFY] Items

These were identified during the audit and are **not silently resolved** — they're flagged so a human can close them before the video ships. Full detail in `OYECHATS_SOURCE_OF_TRUTH.md`, "Summary of Open [VERIFY] Items":

1. **Dashboard navigation/IA conflict** — `docs/oyechats-technical-story.md` and the active `app/CLAUDE.md` build mandate describe two different sidebar structures for the same admin dashboard. Neither was confirmed against a live screenshot in this pass. **Action before showing specific nav labels on screen:** check the actually-deployed dashboard.
2. ~~Logo inconsistency across surfaces~~ — **RESOLVED.** Checked the live production HTML directly (not just repo files): the marketing website's actual current logo is `oyechats-wordmark.png`/`oyechats-wordmark-light.png` — a wordmark that embeds the exact same ring-with-dots glyph as the Admin dashboard's `logo-light.png`/`logo-dark.png`. The two surfaces already agree. The apparent conflict was a stale local checkout of the website repo (2 commits behind `origin/development`; `origin/main` already has `5a9bca8 feat(logo): implemented new logo`) — its local `Logo.tsx` and `oyechats-mark.png` are simply outdated. The live wordmark files have been pulled into the local repo's `public/` folder for future reference.
3. **Terminology rollout completeness** — "Bot → AI Agent" and "Session → Conversation" are confirmed as the intended current direction (evidenced in `app/CLAUDE.md` and, for "Train," directly in `docs/oyechats-technical-story.md`'s own step naming), but full rollout across every customer-facing surface was not independently re-audited file-by-file.
4. **Qualification-chip default-off behavior** — confirmed via product documentation, not re-verified against the raw `qualification_service.py` source in this pass.

None of these block using the package — they're flagged precisely so they can be resolved deliberately rather than guessed at silently inside a generated video.

## The Logo, Resolved: One Glyph, Two Live Forms, Three Rejected Explorations

The audit found four logo-adjacent assets in the codebase. Two are confirmed live in production and turn out to be **the same glyph**, not competing concepts:

- **Icon form** (Admin Dashboard): `logo-light.png`/`logo-dark.png`, confirmed via `app/src/shell/OyeChatsMark.tsx`.
- **Wordmark form** (Marketing Website): `oyechats-wordmark.png`/`oyechats-wordmark-light.png`, confirmed by checking the live production HTML directly — the "C" in "chats" is the exact same ring-with-dots glyph as the icon form above. These files didn't exist in the local website repo checkout (it was 2 commits behind), so they've been downloaded from the live URLs and added to `oyechats-website/public/`.

Two more are confirmed **dead code**, worth flagging explicitly since they're exactly the kind of thing that would otherwise get uploaded by mistake: `docs/logos/_logo-workspace.html` (an indigo/blue "signal arc" concept, dated April 2026, no live consumer anywhere in the codebase) and `widget/src/components/OyeChatsLogo.jsx` (an orange/terracotta glyph, not imported anywhere else in the widget). A third, `oyechats-mark.png` (navy bubble), isn't dead exactly — it's just what the *local* website repo still points to because it hasn't caught up to production yet. All are documented in `OYECHATS_BRAND_GUIDELINES.md` and `OYECHATS_SOURCE_OF_TRUTH.md` as **do not use** — so if any surfaces again later, there's already a paper trail explaining why.
