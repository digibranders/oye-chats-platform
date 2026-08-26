import { Fragment, type ReactElement, type ReactNode } from 'react';
import { template } from './i18n';
import { useTranslation } from './useTranslation';

/**
 * `{name}` - the same placeholder syntax `t()` substitutes.
 *
 * Split, not exec: a capturing split needs no `lastIndex`, so the pattern
 * carries no state between renders. A global regex mutated inside a component
 * is shared across every concurrent render of it, which the React Compiler
 * correctly refuses.
 */
const PLACEHOLDER = /\{(\w+)\}/;

export interface TransProps {
  /** Dictionary key. */
  k: string;
  /** English source text, placeholders included. Used when the key misses. */
  fallback: string;
  /** Placeholder name -> the node to render in its place. */
  values: Record<string, ReactNode>;
}

/**
 * A sentence with React elements interpolated into it.
 *
 * `t()` covers every string that renders as text. It cannot cover a sentence
 * that wraps part of itself in an element - "type <b>{name}</b> in the box
 * below" - because the element has to survive substitution. Splitting the
 * sentence into a prefix key and a suffix key instead is the trap: it bakes
 * English word order into the markup, and Hindi does not share it. The whole
 * sentence stays one translatable unit and the placeholder moves with it.
 *
 * Reads the locale through useTranslation so a language switch re-renders it,
 * the same as every other localized surface.
 */
export function Trans({ k, fallback, values }: TransProps): ReactElement {
  // Subscribed for the re-render; the template is read fresh below so this
  // stays correct when the dictionary lands after the locale is already set.
  useTranslation();
  const source = template(k) ?? fallback;

  // A capturing split interleaves the literal text with the captured names:
  // even indices are text, odd indices are placeholder names.
  const segments = source.split(new RegExp(PLACEHOLDER.source, 'g'));
  const parts: ReactNode[] = segments.map((segment, i) => {
    if (i % 2 === 0) return segment;
    // An unknown placeholder renders literally rather than vanishing, so a
    // dictionary bug is visible instead of silently dropping a value.
    return segment in values ? values[segment] : `{${segment}}`;
  });

  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}
