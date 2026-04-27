# GDPR consent with Cookiebot / OneTrust

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
