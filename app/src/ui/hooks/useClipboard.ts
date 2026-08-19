import { useCallback, useEffect, useRef, useState } from 'react';

export type ClipboardState = 'idle' | 'copied' | 'failed';

/**
 * Copy to the clipboard, with an honest outcome.
 *
 * `navigator.clipboard` rejects on an insecure origin, without permission, and
 * when the document is not focused. The previous app called it from eight places
 * and swallowed the rejection in most of them, so the button simply never said
 * "Copied" and the user had no way to tell whether anything had happened. This
 * reports the failure so the caller can tell them to select the text instead.
 */
export function useClipboard(resetAfter = 2000) {
  const [state, setState] = useState<ClipboardState>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      if (timer.current) window.clearTimeout(timer.current);
      try {
        await navigator.clipboard.writeText(text);
        setState('copied');
      } catch {
        setState('failed');
      }
      timer.current = window.setTimeout(() => setState('idle'), resetAfter);
    },
    [resetAfter],
  );

  return { state, copy };
}
