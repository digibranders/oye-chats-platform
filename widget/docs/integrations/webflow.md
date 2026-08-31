# Integrate OyeChats with Webflow

> **Branded plans must also include the "Powered by OyeChats" anchor** next to the script
> tag. It is not decoration: the widget mounts into a shadow root from JS after the visitor
> clicks, so its in-widget badge is invisible to crawlers, and this anchor is the only
> attribution that reaches the served HTML. Copy the exact snippet your dashboard shows on
> the Deploy page — workspaces with the `branding_removable` entitlement get a variant
> without it.


## Site-wide install

1. Open your project → **Site Settings** → **Custom Code**.
2. In the **Footer Code** box, paste:

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

3. Click **Save Changes** → **Publish** the site.

The widget appears on every published page within seconds.

## Per-page install

If you only want the widget on certain pages (e.g. landing pages but not the blog):

1. Open the page → **Page Settings** (gear icon) → **Custom Code**.
2. Paste the script tag in the **Before `</body>` tag** box.
3. Save and republish.

## Open chat from a Webflow button

1. Add an **Embed** element where you want the trigger button.
2. Paste:

```html
<button onclick="window.OyeChats.open()">Need help?</button>
```

3. Style the button with Webflow classes as you would any other element.

## Hide the floating launcher (use only your own trigger)

> ⚠️ **There is currently no supported way to do this.** A previous version of this page
> gave a `oyechats-widget-root::part(launcher)` rule. That snippet cannot work, for two
> independent reasons: `oyechats-widget-root` is the **`id` of a `<div>`**, not a custom
> element, so as a type selector it matches nothing (`#oyechats-widget-root` would be the
> selector); and `::part()` only reaches shadow content that has been given an explicit
> `part=` attribute — the widget's shadow tree exposes **no parts at all**. Verified against
> `widget/src/app-entry.jsx` and the component tree on 2026-08-31.
>
> `hideLauncher` appears in `widget/types/oyechats.d.ts` as a field of
> `OyeChatsRuntimeConfig`, but nothing in the widget reads it, so
> `OyeChats.update({ hideLauncher: true })` type-checks and does nothing.
>
> `#oyechats-widget-root { display: none }` is **not** a workaround — it hides the panel
> along with the launcher, so your own trigger opens something invisible.
>
> If you need a launcher-less install, ask before shipping one: it needs either a `part=`
> on the launcher or a real `hideLauncher` implementation, and both are small changes to the
> widget rather than something a customer can CSS their way around.

Until then, use the widget's own launcher, and add your own button as an *additional* way in
(see the section above) rather than a replacement.
