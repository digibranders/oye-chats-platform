import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ABSENT,
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
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
      // A `Badge` in one branch and a bare number in the other broke the
      // column's baseline and its right edge — the cell is `figure text-right`,
      // and a 20px inline-flex pill is neither. Colour plus the column head
      // carries the meaning, and an absent value is an em dash, never a zero.
      render: (row) =>
        row.failed > 0 ? (
          <span className="text-danger">{formatNumber(row.failed)}</span>
        ) : (
          ABSENT
        ),
    },
  ];

  return (
    <Card>
      <CardHeader
        eyebrow="Weekly"
        title="Keep this knowledge up to date"
        titleAs="h2"
        description="Only pages that changed are re-read, and only those are charged."
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
            size="panel"
            title="Not yours to change"
            description="Only an owner or admin can change the schedule."
          />
        </CardBody>
      ) : section.error ? (
        <ErrorState
          size="panel"
          title="We could not load the weekly retrain"
          description={section.error}
          onRetry={section.retry}
        />
      ) : status === null ? (
        <CardBody>
          <EmptyState
            size="panel"
            title="Nothing to show"
            description="This chatbot has no retrain schedule yet."
          />
        </CardBody>
      ) : !status.featureAvailable ? (
        <CardBody>
          {/* `size="panel"` frames nothing: inside a `CardBody` inside a `Card`,
              `LockedState`'s own `rounded-lg border` was a second hairline 20px
              inside the first, with two concentric 10px radii. */}
          <LockedState
            size="panel"
            title={`Weekly auto-retrain is on Standard and above`}
            description={`On Standard and above this runs weekly, charging only for pages that changed. Your ${planName} plan re-trains when you ask it to.`}
            action={
              <Link to="/billing" className={buttonClass('primary', 'sm')}>
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

          {/* Always rendered, so a newly-enabled schedule does not silently
              grow by 250px after its first run. `DataTable` ships an `empty`
              slot precisely so a table can hold its shape. Seated and flush,
              because a table inside a `CardSection` sits its border 20px inside
              the card's and its first cell 37px from the card edge, against a
              header title at 20. */}
          <CardBody flush>
            <DataTable
              seated
              columns={columns}
              rows={status.history}
              rowKey={(row) => row.ranAt ?? 'unknown'}
              rowNoun="run"
              caption="Recent weekly retrains"
              empty={
                <EmptyState
                  size="inline"
                  title="No runs yet"
                  description="The first weekly check runs in seven days."
                />
              }
            />
          </CardBody>
        </>
      )}

      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title="Turn off the weekly retrain?"
        description="It keeps what it knows but stops picking up website changes. Turning it back on restarts the seven-day countdown."
        confirmLabel="Turn it off"
        cancelLabel="Leave it on"
        onConfirm={() => commit(false)}
      />
    </Card>
  );
}
