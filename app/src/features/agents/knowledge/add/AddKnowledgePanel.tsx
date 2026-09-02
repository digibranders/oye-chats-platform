import { useState } from 'react';
import { Card, CardHeader, SegmentedControl } from '../../../../ui';
import type { KnowledgeSource } from '../../../../types/domain';
import type { Allowance } from '../knowledge-model';
import { DocumentsFlow } from './DocumentsFlow';
import { WebsiteFlow } from './WebsiteFlow';
import { useTranslation } from '../../../../i18n/useTranslation';

type AddMode = 'website' | 'documents';

export interface AddKnowledgePanelProps {
  agentId: number;
  agentName: string;
  /** The chatbot's own stored website, captured when it was created. */
  agentWebsite: string | null;
  sources: readonly KnowledgeSource[];
  /**
   * Plan allowance for uploaded documents, workspace-wide on both sides.
   * `null` when the plan payload states no document ceiling, which is not the
   * same as a spent one and never locks the flow.
   */
  documentAllowance: Allowance | null;
  /** Website pages this chatbot has stored. Its own count, not the workspace's. */
  pagesTrainedHere: number;
  /**
   * The plan's website-page ceiling: `-1` unlimited, `null` when unstated.
   * Deliberately not an `Allowance`: the server publishes no workspace-wide
   * page counter, so there is no numerator that shares this ceiling's scope.
   */
  pageLimit: number | null;
  /**
   * Knowledge-base size allowance, in characters. `null` when the plan payload
   * does not report the limit at all — which is not the same as a full one.
   */
  characterAllowance: Allowance | null;
  planName: string;
  /** True while entitlements are still resolving; nothing locks until then. */
  planLoading: boolean;
  /** Called after anything lands, so the page can refetch its sources. */
  onChanged: () => void;
  /** Softer heading while the chatbot has nothing to answer from. */
  empty: boolean;
}

/**
 * The one place a chatbot learns something new.
 *
 * A mode switch and two flows, which is all this component ever was. It used to
 * be 861 lines holding a crawl discovery→budget→selection→start→cancel state
 * machine with eleven pieces of state and two effects, an upload→price→confirm→
 * poll flow with six more, and a seventeen-prop `WebsiteFlow` whose fourteen
 * crawl props were the `useCrawl()` context this file had already imported,
 * flattened out and handed down one field at a time. The two flows share
 * nothing but the `Card` shell, so the `Card` shell is what stayed here.
 */
export function AddKnowledgePanel({
  agentId,
  agentName,
  agentWebsite,
  sources,
  documentAllowance,
  pagesTrainedHere,
  pageLimit,
  characterAllowance,
  planName,
  planLoading,
  onChanged,
  empty,
}: AddKnowledgePanelProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AddMode>('website');

  return (
    <Card>
      <CardHeader
        eyebrow="Add knowledge"
        title={empty ? t('agents.teachThisChatbotSomething') || 'Teach this chatbot something' : t('agents.addMoreKnowledge') || 'Add more knowledge'}
        titleAs="h2"
        // No description: the segmented control beside it says "Website /
        // Documents", which is the whole of what a description would have said.
        actions={
          <SegmentedControl<AddMode>
            label={t('agents.whatToAdd') || 'What to add'}
            size="sm"
            value={mode}
            onChange={setMode}
            items={[
              { value: 'website', label: t('agents.website') || 'Website' },
              { value: 'documents', label: t('agents.documents') || 'Documents' },
            ]}
          />
        }
      />

      {mode === 'website' ? (
        <WebsiteFlow
          agentId={agentId}
          agentName={agentName}
          agentWebsite={agentWebsite}
          sources={sources}
          pagesTrainedHere={pagesTrainedHere}
          pageLimit={pageLimit}
          planName={planName}
          planLoading={planLoading}
          onChanged={onChanged}
        />
      ) : (
        <DocumentsFlow
          agentId={agentId}
          documentAllowance={documentAllowance}
          characterAllowance={characterAllowance}
          planName={planName}
          planLoading={planLoading}
          onChanged={onChanged}
        />
      )}
    </Card>
  );
}
