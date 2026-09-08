import { useEffect } from 'react';

/**
 * `(2) OyeChats` in the tab strip while visitors are waiting.
 *
 * The cheapest signal in this whole feature and the only one that reaches an
 * operator who is not looking at the console at all. A card, a chime and a
 * badge all assume the console is the window in front of them; an operator with
 * the dashboard in a background tab, working in a CRM, sees none of it. The tab
 * title is the one thing still on their screen.
 *
 * The count goes in front, in brackets, because that is the convention every
 * mail and chat client already taught them, and because a tab strip truncates
 * from the RIGHT: "OyeChats (2)" reads as "OyeCha…" at the width a tab actually
 * gets when six are open.
 */
export function useWaitingTitle(count: number): void {
  useEffect(() => {
    // Read at effect time rather than at module load: the title is set by the
    // document, and capturing it once at import would freeze whatever the very
    // first render happened to have.
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = count > 0 ? `(${count}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\)\s*/, '');
    };
  }, [count]);
}
