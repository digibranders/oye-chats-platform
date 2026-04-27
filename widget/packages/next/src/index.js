'use client'
import Script from 'next/script'

const DEFAULT_CDN = 'https://cdn.oyechats.com/oyechats-widget.js'

/**
 * <OyeChatsWidget botKey="bot-xxx" />
 *
 * Drop into any layout (Pages or App router). Uses Next.js's recommended
 * `lazyOnload` strategy by default — won't compete with hero image / fonts
 * for first-paint bandwidth.
 */
export const OyeChatsWidget = ({
  botKey,
  src = DEFAULT_CDN,
  strategy = 'lazyOnload',
  id = 'oyechats-widget-script',
}) => (
  <Script
    id={id}
    src={src}
    strategy={strategy}
    data-bot-key={botKey}
  />
)

export default OyeChatsWidget
