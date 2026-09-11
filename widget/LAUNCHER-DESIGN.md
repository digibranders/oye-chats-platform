# OyeChats launcher, 2026-09-11

## Design

Implement the supplied reference as a vector C-shaped chat mark with a circular
outer contour, a small speech-tail cutout and three centered dots. Place it in a
56px white rounded-square tile (18px corners), with a 42px SVG and generous clear
space. A satin-white surface, shallow bevel and layered contact/ambient shadows give depth.
Keep the mark recognizable at rest. On fine-pointer hover or keyboard focus,
lift the tile 3px, scale the mark 2.5%, and raise/pulse the three dots with the
thinking indicator's 1.2s cadence and 150ms stagger. The 2-unit SVG dot lift moves
only about 1.3 screen pixels at actual size. A 700ms light sweep plays once per
interaction, then disappears. Press compresses the tile. Reduced-motion
users see static states; touch users get press feedback without sticky hover.

## Research

Reviewed public pages and official docs on 2026-09-11:
- https://www.intercom.com/help/en/articles/6612589-set-up-and-customize-the-messenger
  documents circular launcher positioning, custom images and internal logo padding.
  The live homepage showed a white circular button with a dark padded chat mark.
- https://www.chatbase.co/ showed a black circular launcher with a small white symbol.
  https://www.chatbase.co/docs/user-guides/quick-start/your-first-agent describes the
  floating chat icon and appearance customization.
- https://www.livechat.com/chat-widget/ showed an orange circular launcher with a
  white speech bubble and a nearby message entry. Its product illustration uses
  a black circle with a padded white bubble.
  https://www.livechat.com/help/customize-your-chat/ documents minimized appearance.

These observations inform silhouette, contrast, padding and restrained depth.
Exact competitor hover timings were not verified; our motion is derived from
OyeChats' own typing indicator and the user's requested interaction.

## Scope and compatibility

The launcher is a fixed OyeChats product mark. Customers can update the assistant
avatar used in the greeting, transcript and identity badge, but no avatar setting or
legacy `launcher_logo` value can replace the launcher. Fetched favicons remain
avatar-only. The API still accepts and returns the legacy field for older clients,
but update handlers ignore it and never copy it into `bot_logo`.

## Implementation and verification plan

1. Add browser regressions to widget/tests/e2e/launcher.spec.js for fixed-mark
   isolation, avatar independence, hover/focus, reduced motion and click-to-open.
2. Add widget/src/components/LauncherMark.jsx containing the static SVG paths and
   three independently styled circles. Keep animation in widget/src/index.css.
3. Replace Launcher.jsx icon selection with the fixed mark. Reuse BotAvatar in the
   greeting and remove the obsolete circular pulse ring. Preserve names, greeting
   behavior and controls.
4. Build and inspect the real widget in desktop/mobile browsers. Run npm run lint,
   npm test, npm run build, the launcher and smoke browser suites, and npm run size.
5. Request independent code review, address material findings, and show the result
   in a local preview. No new runtime dependencies.
