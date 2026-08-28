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
import { useTranslation } from '../../../i18n/useTranslation';

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
  const { t } = useTranslation();
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
      setActionError(errorMessage(cause, t('agents.weCouldNotChangeThe') || 'We could not change the weekly retrain.'));
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<RecrawlRun>[] = [
    {
      key: 'ranAt',
      header: t('agents.run') || 'Run',
      // The one column that must not give: a truncated date is unreadable,
      // while a truncated count is at least still a number. The three counts
      // share whatever is left of the 24rem aside.
      width: '8rem',
      // Every figure in the console is mono, timestamps included.
      render: (row) => (
        <span className="figure">{row.ranAt ? formatDate(row.ranAt) : '—'}</span>
      ),
    },
    {
      key: 'unchanged',
      header: t('agents.unchanged') || 'Unchanged',
      align: 'right',
      render: (row) => formatNumber(row.unchanged),
    },
    {
      key: 'changed',
      header: 'Re-read',
      align: 'right',
      render: (row) => formatNumber(row.changed),
    },
    {
      key: 'failed',
      header: t('agents.failed') || 'Failed',
      align: 'right',
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
        title={t('agents.keepThisKnowledgeUpTo') || 'Keep this knowledge up to date'}
        titleAs="h2"
        description={t('agents.onlyPagesThatChangedAre') || 'Only pages that changed are re-read, and only those are charged.'}
        actions={
          status && status.featureAvailable ? (
            <Switch
              checked={status.enabled}
              disabled={saving || section.loading}
              hideLabel
              label={t('agents.weeklyAutoRetrain') || 'Weekly auto-retrain'}
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
            title={t('agents.notYoursToChange') || 'Not yours to change'}
            description={t('agents.onlyAnOwnerOrAdmin') || 'Only an owner or admin can change the schedule.'}
          />
        </CardBody>
      ) : section.error ? (
        <ErrorState
          size="panel"
          title={t('agents.weCouldNotLoadThe') || 'We could not load the weekly retrain'}
          description={section.error}
          onRetry={section.retry}
        />
      ) : status === null ? (
        <CardBody>
          <EmptyState
            size="panel"
            title={t('agents.nothingToShow') || 'Nothing to show'}
            description={t('agents.thisChatbotHasNoRetrain') || 'This chatbot has no retrain schedule yet.'}
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
                {t('agents.seePlans') || 'See plans'}
              </Link>
            }
          />
        </CardBody>
      ) : !status.enabled && status.pageCount === 0 ? (
        /* Off, with nothing it could refresh. The full card below reserves
           space for facts that cannot exist yet: four definition rows that all
           read "—", and a run table for a schedule that cannot run. Rendered in
           full it measured 622px, which made this dormant control the largest
           single card on the page — taller than the Add-knowledge panel that is
           the page's actual job. The switch in the header and the reason below
           are the whole card until there is a website to refresh. */
        <CardBody>
          <Alert tone="neutral">
            There are no trained websites to refresh yet. Uploaded documents are not re-read — they
            only change when you replace them.
          </Alert>
          {actionError ? (
            <Alert tone="danger" live className="mt-4">
              {actionError}
            </Alert>
          ) : null}
        </CardBody>
      ) : (
        <>
          <CardBody>
            <DefinitionList
              items={[
                {
                  label: t('agents.schedule') || 'Schedule',
                  value: status.enabled ? (
                    <Badge tone="success" dot>
                      Every {status.cadenceDays} days
                    </Badge>
                  ) : (
                    <Badge tone="neutral" dot>
                      {t('agents.off') || 'Off'}
                    </Badge>
                  ),
                },
                {
                  // Pages, not websites. The count is every crawled URL, which
                  // is what the weekly job iterates — and what this card's own
                  // subtitle already promises ("Only pages that changed are
                  // re-read"). Saying "websites" made one site of 20 pages
                  // read as 20 sites.
                  label: t('agents.pagesInTheSet') || 'Pages in the set',
                  value:
                    status.pageCount > 0
                      ? `${formatNumber(status.pageCount)} page${status.pageCount === 1 ? '' : 's'}`
                      : undefined,
                },
                {
                  label: t('agents.lastCheck') || 'Last check',
                  value: status.lastRecrawlAt ? formatRelative(status.lastRecrawlAt) : undefined,
                },
                {
                  label: t('agents.nextCheck') || 'Next check',
                  value:
                    status.enabled && status.nextRecrawlAt
                      ? formatRelative(status.nextRecrawlAt)
                      : undefined,
                },
              ]}
            />
            {status.pageCount === 0 ? (
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

          {/* Rendered whenever a run is possible or has happened, so a
              newly-enabled schedule does not silently grow by 250px after its
              first run. `DataTable` ships an `empty` slot precisely so a table
              can hold its shape. It is NOT rendered for a switched-off schedule
              that has never run: holding 250px for rows that cannot arrive is
              not holding shape, it is padding — and in a 24rem rail it was a
              third of the card. Seated and flush,
              because a table inside a `CardSection` sits its border 20px inside
              the card's and its first cell 37px from the card edge, against a
              header title at 20. */}
          {status.enabled || status.history.length > 0 ? (
          <CardBody flush>
            <DataTable
              seated
              // `fit`: this card is the `aside` of a `Columns` split — 24rem, so
              // about 344px of table. Four columns at their natural widths come
              // to well over that, and the default would scroll them sideways
              // behind a 6px bar under 44px rows. The three counts share what is
              // left after the date, which is the column that must not give.
              fit
              columns={columns}
              rows={status.history}
              rowKey={(row) => row.ranAt ?? 'unknown'}
              rowNoun="run"
              caption={t('agents.recentWeeklyRetrains') || 'Recent weekly retrains'}
              empty={
                <EmptyState
                  size="inline"
                  title={t('agents.noRunsYet') || 'No runs yet'}
                  description={t('agents.theFirstWeeklyCheckRuns') || 'The first weekly check runs in seven days.'}
                />
              }
            />
          </CardBody>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title={t('agents.turnOffTheWeeklyRetrain') || 'Turn off the weekly retrain?'}
        description={t('agents.itKeepsWhatItKnows') || 'It keeps what it knows but stops picking up website changes. Turning it back on restarts the seven-day countdown.'}
        confirmLabel="Turn it off"
        cancelLabel="Leave it on"
        onConfirm={() => commit(false)}
      />
    </Card>
  );
}
