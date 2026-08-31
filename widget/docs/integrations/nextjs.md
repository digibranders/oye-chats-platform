# Integrate OyeChats with Next.js

> **Branded plans must also include the "Powered by OyeChats" anchor** next to the script
> tag. It is not decoration: the widget mounts into a shadow root from JS after the visitor
> clicks, so its in-widget badge is invisible to crawlers, and this anchor is the only
> attribution that reaches the served HTML. Copy the exact snippet your dashboard shows on
> the Deploy page — workspaces with the `branding_removable` entitlement get a variant
> without it.


## App Router (recommended)

```tsx
// app/layout.tsx
import Script from 'next/script'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script
          src="https://cdn.oyechats.com/oyechats-widget.js"
          data-bot-key="bot-xxx"
          strategy="lazyOnload"
        />
      </body>
    </html>
  )
}
```

`strategy="lazyOnload"` waits for browser idle — no impact on LCP/CLS, no fight with the hero image for bandwidth. Switch to `afterInteractive` only if you need `OyeChats.on('ready')` handlers to fire earlier.

## With `@oyechats/next` package

> **Availability unverified.** This wrapper exists in the platform repo at
> `widget/packages/next` (version `0.1.0`), but whether it is published to npm has not been
> confirmed. If `npm i @oyechats/next` fails, use the plain `<Script>` install above — it is
> the supported path and the wrapper adds nothing you cannot do with it.

```tsx
import { OyeChatsWidget } from '@oyechats/next'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <OyeChatsWidget botKey="bot-xxx" />
      </body>
    </html>
  )
}
```

## Identifying the logged-in user

```tsx
'use client'
import { useEffect } from 'react'
import { useSession } from 'next-auth/react'

export function OyeChatsIdentify() {
  const { data } = useSession()
  useEffect(() => {
    if (!data?.user) return
    // Wait for loader to install OyeChats on window.
    const id = setInterval(() => {
      if (window.OyeChats) {
        clearInterval(id)
        window.OyeChats.identify({
          name: data.user.name,
          email: data.user.email,
        })
      }
    }, 50)
    return () => clearInterval(id)
  }, [data])
  return null
}
```

## Pages Router

```tsx
// pages/_document.tsx
import { Html, Head, Main, NextScript } from 'next/document'
import Script from 'next/script'

export default function Document() {
  return (
    <Html>
      <Head />
      <body>
        <Main />
        <NextScript />
        <Script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx" strategy="lazyOnload" />
      </body>
    </Html>
  )
}
```
