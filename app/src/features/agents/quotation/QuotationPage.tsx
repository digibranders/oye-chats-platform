import { type ReactElement } from 'react';
import { Receipt } from 'lucide-react';
import { PageContainer, EmptyState } from '../../../design-system';
import { useAgent } from '../../../context/AgentContext';
import { QuotationCatalogSection } from '../advanced/QuotationCatalogSection';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * QuotationPage - the agent "Quotation" tab. Answers: *"What quote does my
 * AI offer a qualified visitor?"* Promoted out of Advanced into its own
 * primary tab so the pre-handoff quotation flow (services, BANT trigger,
 * per-service questions) gets a dedicated surface instead of living buried
 * among unrelated power-user knobs. `QuotationCatalogSection` already owns
 * its own loading, entitlement (Professional-plan) gating, and save flow -
 * this page only resolves the agent id and handles the "no chatbot" state.
 */
export function QuotationPage(): ReactElement {
  const { t } = useTranslation();
  const { agent, agentId, loading, error } = useAgent();

  if (!loading && agentId === null) {
    return (
      <div>
        <PageContainer>
          <EmptyState
            icon={Receipt}
            title={error ? t('agents.couldntLoadThisChatbot') || 'Couldn’t load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
            description={
              error
                ? t('agents.weCouldntLoadThisChatbot') || 'We couldn’t load this chatbot. Please try again.'
                : t('agents.pickAChatbotToConfigure') || 'Pick a chatbot to configure its quotation flow.'
            }
          />
        </PageContainer>
      </div>
    );
  }

  return (
    <div>
      <PageContainer>
        <QuotationCatalogSection botId={agent?.id ?? null} />
      </PageContainer>
    </div>
  );
}
