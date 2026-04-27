import type { ReactElement } from 'react'
import type { OyeChatsApi, OyeChatsVisitor } from '../../../types/oyechats'

export interface OyeChatsWidgetProps {
  botKey: string
  src?: string
  asyncInit?: boolean
  onReady?: () => void
}

export interface UseOyeChatsResult {
  ready: boolean
  isOpen: boolean
  open(): void
  close(): void
  send(text: string): void
  identify(visitor: OyeChatsVisitor): void
  shutdown(): void
  boot(visitor: OyeChatsVisitor): void
}

export declare const OyeChatsWidget: (props: OyeChatsWidgetProps) => ReactElement | null
export declare const useOyeChats: () => UseOyeChatsResult
export type { OyeChatsApi, OyeChatsVisitor }
