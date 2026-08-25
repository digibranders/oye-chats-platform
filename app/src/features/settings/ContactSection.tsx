import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Mail, Sparkles } from 'lucide-react';
import { Card, SectionHeader, buttonVariants, cn } from '../../design-system';
import { useTranslation } from '../../i18n/useTranslation';

/** Where bespoke requests land. Mirrors the platform's published contact address. */
const CONTACT_EMAIL = 'support@oyechats.com';
const MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Custom request')}`;

// ── Section ──────────────────────────────────────────────────────────────────

/**
 * ContactSection - "Need something custom?" surface. A direct line to the team
 * for bespoke integrations, custom pricing, or white-glove onboarding - things
 * that don't fit a self-serve flow. One copy-to-clipboard affordance and one
 * mailto, no ticket taxonomy.
 *
 * Feedback is inline (a transient "Copied" state on the button) rather than a
 * global toast, matching the rest of Settings.
 */
export function ContactSection(): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  // Hold the reset timer so an unmount (or a rapid re-copy) can clear it
  // instead of firing setState on a gone component.
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(async (): Promise<void> => {
    setCopyError('');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(CONTACT_EMAIL);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        setCopied(false);
        resetTimer.current = null;
      }, 2000);
    } catch {
      setCopyError(
        t('settings.contact.copyFailed') ||
          'Couldn’t copy - select the address above and copy it manually.',
      );
    }
    // `t` is intentionally omitted. It is a thin wrapper over the module-level
    // store and resolves against the CURRENT locale at call time, so a stale
    // closure still produces correctly localized text. Including it would
    // re-run this on every language change for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-labelledby="contact-heading" className="space-y-4">
      <SectionHeader
        title={<span id="contact-heading">{t('settings.contact.title') || 'Need something custom?'}</span>}
        description={
          t('settings.contact.description') ||
          'Bespoke integrations, custom pricing, or a feature built for your workspace.'
        }
      />
      <Card>
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]"
            >
              <Sparkles size={18} />
            </span>
            <p className="text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              {t('settings.contact.body') ||
                'Our team handles these directly rather than through the standard support queue. Reach out and we’ll get back to you.'}
            </p>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
            <span className="flex min-w-0 items-center gap-2.5">
              <Mail size={16} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
              <span className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                {CONTACT_EMAIL}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void handleCopy()}
              aria-label={
                copied
                  ? t('settings.contact.copied') || 'Email address copied'
                  : t('settings.contact.copyAddress', { email: CONTACT_EMAIL }) ||
                    `Copy ${CONTACT_EMAIL}`
              }
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                copied
                  ? 'text-[var(--ds-success)]'
                  : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
              )}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? t('settings.contact.copiedShort') || 'Copied' : t('settings.contact.copy') || 'Copy'}
            </button>
          </div>

          <div aria-live="polite" className="empty:hidden">
            {copyError && (
              <p role="alert" className="mt-2 text-[12px] text-[var(--ds-danger)]">
                {copyError}
              </p>
            )}
          </div>

          <div className="mt-5">
            <a href={MAILTO} className={cn(buttonVariants({ variant: 'primary' }))}>
              <Mail size={16} aria-hidden="true" />
              {t('settings.contact.emailUs') || 'Email us'}
            </a>
          </div>
        </div>
      </Card>
    </section>
  );
}
