import { useEffect, useState } from 'react';
import { FileText, CheckCircle2 } from 'lucide-react';
import { Card, StatusBadge, Skeleton, EmptyState } from '../../../design-system';
import { getDocuments } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';
import type { DocumentSummary } from '../../../types/domain';

/**
 * Step 5 — Knowledge Review. Shows what the agent actually learned (real
 * documents from getDocuments), so the user can confirm coverage before testing.
 * NEW vs. legacy, which showed only a page count.
 */
export function ReviewStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  // `null` = not loaded yet. Loading is derived (no setState-in-effect).
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const loading = Boolean(selectedBot) && docs === null;
  const sources = docs ?? [];

  useEffect(() => {
    if (!selectedBot) return;
    let cancelled = false;
    getDocuments(selectedBot.id)
      .then((data) => {
        if (!cancelled) setDocs(data);
      })
      .catch(() => {
        if (!cancelled) setDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBot]);

  return (
    <StepShell
      title="What your AI learned"
      description="A quick look at your agent's knowledge before you test it."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
    >
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No sources yet"
          description="Once training finishes, the pages your agent learned from will appear here."
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
            <CheckCircle2 size={16} />
            <span className="font-medium">
              Trained on {sources.length} source{sources.length === 1 ? '' : 's'}
            </span>
          </div>
          <Card className="divide-y divide-[var(--ds-border)]">
            {sources.slice(0, 12).map((doc) => (
              <div key={doc.id} className="flex items-center gap-3 px-4 py-3">
                <FileText size={16} className="shrink-0 text-[var(--ds-text-subtle)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                    {doc.title || doc.source_url || `Source #${doc.id}`}
                  </p>
                  {doc.chunk_count != null && (
                    <p className="text-[12px] text-[var(--ds-text-subtle)]">
                      {doc.chunk_count} section{doc.chunk_count === 1 ? '' : 's'} learned
                    </p>
                  )}
                </div>
                <StatusBadge tone="success" dot>
                  Ready
                </StatusBadge>
              </div>
            ))}
          </Card>
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Missing something? You can add more sources anytime from your agent's Knowledge tab.
          </p>
        </div>
      )}
    </StepShell>
  );
}
