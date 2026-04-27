# Integrate OyeChats with Webflow

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

Add this CSS in **Site Settings → Custom Code → Head Code**:

```html
<style>
  oyechats-widget-root::part(launcher) { display: none !important; }
</style>
```

Then trigger via your own button as shown above.
