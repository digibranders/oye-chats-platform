import { Alert } from '../../../ui';

/**
 * Custom copy is not translated — said on the surfaces where it is written.
 *
 * The widget ships a translated dictionary for every string it owns, and any
 * field the customer fills in wins over that dictionary. That precedence is
 * right: a greeting somebody wrote deliberately should not be swapped for a
 * generic translated default. The consequence is easy to miss, though — a
 * chatbot with multilingual on and an English greeting shows that English
 * greeting to a Hindi visitor, and nothing on the page said so.
 *
 * Worded as a fact rather than a warning, and toned `neutral` for the same
 * reason: writing custom copy is a legitimate thing to do, and the customer
 * only needs to know it travels unchanged. Rendered only when multilingual is
 * actually on, because on a single-language chatbot it is noise.
 */
export function CustomCopyNotice({ multilingual }: { multilingual: boolean }) {
  if (!multilingual) return null;
  return (
    <Alert tone="neutral" title="Custom text is shown unchanged in every language">
      Anything you write here replaces the built-in wording, which your chatbot would otherwise
      translate for each visitor. Leave a field empty to keep the translated default.
    </Alert>
  );
}
