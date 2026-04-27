import type { ReactElement } from 'react'

export interface OyeChatsWidgetProps {
  botKey: string
  src?: string
  strategy?: 'beforeInteractive' | 'afterInteractive' | 'lazyOnload' | 'worker'
  id?: string
}

export declare const OyeChatsWidget: (props: OyeChatsWidgetProps) => ReactElement
export default OyeChatsWidget
