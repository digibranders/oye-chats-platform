# Integrate OyeChats with WordPress

> **Branded plans must also include the "Powered by OyeChats" anchor** next to the script
> tag. It is not decoration: the widget mounts into a shadow root from JS after the visitor
> clicks, so its in-widget badge is invisible to crawlers, and this anchor is the only
> attribution that reaches the served HTML. Copy the exact snippet your dashboard shows on
> the Deploy page — workspaces with the `branding_removable` entitlement get a variant
> without it.


## Option A — Theme footer (most common)

In your theme's `footer.php`, just before `</body>`:

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

Save. Reload any page. Done.

## Option B — Code Snippets / WPCode plugin

If you don't want to edit theme files (or you're on a hosted plan that locks them):

1. Install the **WPCode** or **Code Snippets** plugin.
2. Add a new snippet, type **HTML**, location **Site Wide Footer**.
3. Paste the script tag above.
4. Save and activate.

## Option C — As a plugin

Drop this into `wp-content/plugins/oyechats/oyechats.php`:

```php
<?php
/*
Plugin Name: OyeChats Widget
*/
add_action('wp_footer', function () {
  echo '<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>';
});
```

Activate via Plugins → OyeChats Widget.

## Pre-fill the visitor when logged in (WooCommerce)

```php
add_action('wp_footer', function () {
  $user = wp_get_current_user();
  if ($user && $user->ID) {
    $name  = esc_js($user->display_name);
    $email = esc_js($user->user_email);
    echo "<script>
      window.addEventListener('load', function() {
        var t = setInterval(function() {
          if (window.OyeChats) {
            clearInterval(t);
            window.OyeChats.identify({ name: '$name', email: '$email' });
          }
        }, 50);
      });
    </script>";
  }
});
```
