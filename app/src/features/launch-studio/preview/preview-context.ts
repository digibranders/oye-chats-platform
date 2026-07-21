import { createContext, useContext } from 'react';
import type { AvatarType } from '../customize/AvatarPicker';

export interface PreviewMessage {
  role: 'user' | 'bot';
  text: string;
  sources?: string[];
}

/** The live widget-preview config, shared between steps and the preview pane. */
export interface PreviewState {
  primaryColor: string;
  userBubbleColor: string;
  avatarType: AvatarType;
  orbColor: string;
  botLogo: string | null;
  /** Live conversation (Test step). Empty → the widget shows its welcome screen. */
  messages: PreviewMessage[];
  /** Bot is answering — shows the typing indicator. */
  pending: boolean;
}

export interface PreviewContextValue {
  preview: PreviewState;
  setPreview: (patch: Partial<PreviewState>) => void;
}

export const PreviewContext = createContext<PreviewContextValue | null>(null);

/** Subscribe to the live widget preview. Must be inside a `<PreviewProvider>`. */
export function usePreview(): PreviewContextValue {
  const ctx = useContext(PreviewContext);
  if (!ctx) {
    throw new Error('usePreview must be used within a PreviewProvider');
  }
  return ctx;
}
