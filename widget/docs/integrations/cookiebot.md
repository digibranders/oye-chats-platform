# GDPR consent with Cookiebot / OneTrust

> **Branded plans must also include the "Powered by OyeChats" anchor** next to the script
> tag. It is not decoration: the widget mounts into a shadow root from JS after the visitor
> clicks, so its in-widget badge is invisible to crawlers, and this anchor is the only
> attribution that reaches the served HTML. Copy the exact snippet your dashboard shows on
> the Deploy page — workspaces with the `branding_removable` entitlement get a variant
> without it.


OyeChats supports deferred init so the widget only mounts after the visitor accepts cookies.

## 1. Set the deferred-init flag BEFORE the loader script

```html
<script>
  // CRITICAL: must run BEFORE the OyeChats loader.
  window.OYECHATS_ASYNC_INIT = true;
</script>

<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

When `OYECHATS_ASYNC_INIT === true`, the loader registers `window.OyeChats` but does NOT mount the widget yet.

## 2. Mount on consent

### Cookiebot

```html
<script>
  window.addEventListener('CookiebotOnAccept', function () {
    if (Cookiebot.consent.statistics) {
      window.OyeChats.init();
    }
  });
</script>
```

### OneTrust

```html
<script>
  function onConsentChange() {
    var consent = OnetrustActiveGroups || ''; // e.g. ",C0001,C0002,C0003,"
    if (consent.indexOf(',C0003,') >= 0) {  // C0003 = functional
      window.OyeChats.init();
    } else {
      window.OyeChats.destroy();
    }
  }
  if (window.OneTrust) {
    OneTrust.OnConsentChanged(onConsentChange);
  }
</script>
```

### Custom consent banner

```html
<button id="accept-cookies">Accept</button>
<script>
  document.getElementById('accept-cookies').addEventListener('click', function () {
    window.OyeChats.init();
    document.getElementById('accept-cookies').remove();
  });
</script>
```

## 3. Tear down on revoke

```js
// User revokes consent — remove the widget cleanly.
window.OyeChats.destroy();
```

`destroy()` unmounts React, removes the shadow DOM container, and clears the visitor identity. The loader stays in memory so a future `init()` re-mounts without another network round-trip.
