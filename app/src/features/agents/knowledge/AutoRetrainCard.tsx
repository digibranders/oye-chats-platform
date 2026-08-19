import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  ConfirmDialog,
  DataTable,
  DefinitionList,
  EmptyState,
  ErrorState,
  LoadingRows,
  LockedState,
  Switch,
  buttonClass,
  formatDate,
  formatNumber,
  formatRelative,
  type Column,
} from '../../../ui';
import { keys } from '../../../query/keys';
import { errorMessage, setAutoRecrawl, type RecrawlRun, type RecrawlStatus } from './knowledge-api';
import type { Section } from './useKnowledgeData';

export interface AutoRetrainCardProps {
  agentId: number;
  section: Section<RecrawlStatus | null>;
  planName: string;
}

/**
 * The weekly refresh, and what it has actually been doing.
 *
 * The run history is the point. A schedule with no record is a promise, and the
 * customer's real question about an automatic job is not "is it on?" but "did it
 * work, and what did it change?" — which the backend has always written and
 * nothing has ever shown.
 */
export function AutoRetrainCard({ agentId, section, planName }: AutoRetrainCardProps) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingOff, setConfirmingOff] = useState(false);

  const status = section.data;

  async function commit(enabled: boolean) {
    setSaving(true);
    setActionError(null);
    try {
      const updated = await setAutoRecrawl(agentId, enabled);
      client.setQueryData(keys.agents.recrawl(agentId), updated);
      setConfirmingOff(false);
    } catch (cause) {
      setActionError(errorMessage(cause, 'We could not change the weekly retrain.'));
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<RecrawlRun>[] = [
    {
      key: 'ranAt',
      header: 'Run',
      // Every figure in the console is mono, timestamps included.
      render: (row) => (
        <span className="figure">{row.ranAt ? formatDate(row.ranAt) : '—'}</span>
      ),
    },
    {
      key: 'unchanged',
      header: 'Unchanged',
      align: 'right',
      width: '8rem',
      render: (row) => formatNumber(row.unchanged),
    },
    {
      key: 'changed',
      header: 'Re-read',
      align: 'right',
      width: '8rem',
      render: (row) => formatNumber(row.changed),
    },
    {
      key: 'failed',
      header: 'Failed',
      align: 'right',
      width: '8rem',
      render: (row) =>
        row.failed > 0 ? (
          <Badge tone="warning">{formatNumber(row.failed)}</Badge>
        ) : (
          formatNumber(0)
        ),
    },
  ];

  return (
    <Card>
      <CardHeader
        eyebrow="Weekly"
        title="Keep this knowledge up to date"
        titleAs="h2"
        description="Once a week we check every trained website and re-read only the pages whose content changed. Unchanged pages cost nothing."
        actions={
          status && status.featureAvailable ? (
            <Switch
              checked={status.enabled}
              disabled={saving || section.loading}
              hideLabel
              label="Weekly auto-retrain"
              onCheckedChange={(next) => {
                if (next) {
                  void commit(true);
                  return;
                }
                setConfirmingOff(true);
              }}
            />
          ) : undefined
        }
      />

      {section.loading ? (
        <CardBody>
          <LoadingRows rows={2} />
        </CardBody>
      ) : section.forbidden ? (
        <CardBody>
          <EmptyState
            title="Not yours to change"
            description="Your seat can read this chatbot's knowledge but not its training schedule. An owner or admin can change it."
          />
        </CardBody>
      ) : section.error ? (
        <ErrorState
          title="We could not load the weekly retrain"
          description={section.error}
          onRetry={section.retry}
        />
      ) : status === null ? (
        <CardBody>
          <EmptyState
            title="Nothing to show"
            description="This chatbot has no retrain schedule yet."
          />
        </CardBody>
      ) : !status.featureAvailable ? (
        <CardBody>
          <LockedState
            compact
            title="Weekly auto-retrain is on Standard and above"
            description={`Your ${planName} plan re-trains when you ask it to. On Standard and above it happens every week on its own, and only pages that actually changed are read or charged.`}
            action={
              <Link to="/billing" className={buttonClass('primary', 'md')}>
                See plans
              </Link>
            }
          />
        </CardBody>
      ) : (
        <>
          <CardBody>
            <DefinitionList
              items={[
                {
                  label: 'Schedule',
                  value: status.enabled ? (
                    <Badge tone="success" dot>
                      Every {status.cadenceDays} days
                    </Badge>
                  ) : (
                    <Badge tone="neutral" dot>
                      Off
                    </Badge>
                  ),
                },
                {
                  label: 'Websites in the set',
                  value:
                    status.sourcesCount > 0
                      ? `${formatNumber(status.sourcesCount)} trained website${status.sourcesCount === 1 ? '' : 's'}`
                      : undefined,
                },
                {
                  label: 'Last check',
                  value: status.lastRecrawlAt ? formatRelative(status.lastRecrawlAt) : undefined,
                },
                {
                  label: 'Next check',
                  value:
                    status.enabled && status.nextRecrawlAt
                      ? formatRelative(status.nextRecrawlAt)
                      : undefined,
                },
              ]}
            />
            {status.sourcesCount === 0 ? (
              <Alert tone="neutral" className="mt-4">
                There are no trained websites to refresh yet. Uploaded documents are not re-read —
                they only change when you replace them.
              </Alert>
            ) : null}
            {actionError ? (
              <Alert tone="danger" live className="mt-4">
                {actionError}
              </Alert>
            ) : null}
          </CardBody>

          {status.history.length > 0 ? (
            <CardSection>
              <DataTable
                columns={columns}
                rows={status.history}
                rowKey={(row) => row.ranAt ?? 'unknown'}
                caption="Recent weekly retrains"
              />
            </CardSection>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title="Turn off the weekly retrain?"
        description="This chatbot keeps everything it knows, but stops picking up changes to your website — so its answers drift out of date as your site moves. Turning it back on starts a fresh seven-day countdown."
        confirmLabel="Turn it off"
        cancelLabel="Leave it on"
        onConfirm={() => commit(false)}
      />
    </Card>
  );
}
