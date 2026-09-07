import ReactMarkdown from 'react-markdown';
import { cn } from '../lib/cn';

/**
 * Markdown written by the AI, rendered as formatting rather than as asterisks.
 *
 * **Only for machine-authored text.** The chatbot's answers are generated as
 * markdown, so a surface that prints them verbatim shows a visitor-facing
 * answer as `**Clean Images**` to the operator reading it. Text a PERSON typed
 * — a visitor's message, an operator's reply — is rendered verbatim by its call
 * site instead, because reformatting somebody's own words is a different kind
 * of wrong: their asterisks were asterisks.
 *
 * The styling is here rather than at each call site because it was already
 * duplicated once, as a 12-class arbitrary-variant string in the leads drawer,
 * and a second copy in the inbox would have been the point where the AI's
 * answer started looking like two different things in two places.
 *
 * Block spacing is deliberately tight (`[&_p]:my-0`, lists at `my-1`): these
 * render inside chat bubbles and table cells, where the browser's default
 * paragraph margins open gaps the bubble was not sized for.
 */
export interface MarkdownProps {
  children: string;
  className?: string;
  /**
   * The text's own direction, when it differs from the surrounding page: a
   * translated Arabic message inside an English thread lays out right-to-left
   * whatever the console's own direction is.
   */
  dir?: 'ltr' | 'rtl' | 'auto';
}

export function Markdown({ children, className, dir }: MarkdownProps) {
  return (
    <div
      dir={dir}
      className={cn(
        'break-words',
        '[&_p]:my-0',
        '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:ps-4',
        '[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:ps-4',
        '[&_li]:my-0.5',
        '[&_strong]:font-semibold',
        '[&_code]:rounded-xs [&_code]:bg-surface-sunken [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-2xs',
        '[&_a]:text-accent-600 [&_a]:underline [&_a]:underline-offset-2',
        className,
      )}
    >
      {/* No `rehype-raw`: the input is a model's output, and enabling raw HTML
          here would make prompt-injected markup render as markup. */}
      <ReactMarkdown
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {label}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
