# Integrate OyeChats with Next.js

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
