import { ABSENT, Disclosure } from '../../ui';
import type { Lead } from '../../types/domain';
import { LeadSection } from './LeadSection';
import { asRecord, buildJourney } from './leadSource';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * The pages they read before they typed.
 *
 * A `Disclosure`, collapsed, rather than a six-row preview plus a `Dialog`
 * holding the full list at `max-h-[60vh]` — an arbitrary viewport fraction, and
 * a modal is heavier than a list of URLs deserves. The "see all" threshold was
 * also a magic `6` written twice, once as the comparison and once as the slice.
 * Expanding in place keeps the record on screen behind it.
 *
 * "Before the chat" is a claim about `phase`, not about array length. The stored
 * journey spans the whole visit, so `buildJourney` keeps the pre-chat leg and
 * says whether the entries stated a phase at all; a lead whose entries predate
 * the field gets the weaker, true wording instead.
 */
export function LeadJourney({ lead }: { lead: Lead }) {
  const { t } = useTranslation();
  const source = asRecord(lead.source);
  const { steps, phased } = buildJourney(Array.isArray(source.journey) ? source.journey : []);
  if (steps.length === 0) return null;

  const pages = steps.length === 1 ? '1 page' : `${steps.length} pages`;

  return (
    <LeadSection title={t('leads.journey') || 'Journey'}>
      <Disclosure
        summary={
          phased
            ? t('leads.nBeforeTheChat', { pages }) || `${pages} before the chat`
            : t('leads.nVisited', { pages }) || `${pages} visited`
        }
        regionLabel={phased ? t('leads.pagesVisitedBeforeTheChat') || 'Pages visited before the chat' : t('leads.pagesVisited') || 'Pages visited'}
      >
        <ol>
          {steps.map((step, index) => (
            <li
              key={`${step.path}-${step.timestamp ?? index}`}
              className="flex items-start gap-2 border-t border-border py-1.5 text-xs first:border-t-0"
            >
              <span className="figure w-6 shrink-0 text-text-tertiary">{index + 1}</span>
              <span className="min-w-0 flex-1 break-all text-text-primary">
                {step.path || ABSENT}
              </span>
              {/* "opened the chat here" is only true of the last PRE-chat page.
                  Unphased entries may end on a page the visitor reached after
                  the conversation, so the last row is left unannotated. */}
              {step.last && phased ? (
                <span className="shrink-0 text-text-secondary">{t('leads.openedTheChatHere') || 'opened the chat here'}</span>
              ) : step.dwell ? (
                <span className="figure shrink-0 text-text-tertiary">{step.dwell}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-text-tertiary">
          {phased
            ? t('leads.oldestFirstTheChatOpened') || 'Oldest first; the chat opened on the last.'
            : t('leads.oldestFirstTheseEntriesDo') || 'Oldest first. These entries do not say which came before the chat.'}
        </p>
      </Disclosure>
    </LeadSection>
  );
}
