import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  CardBody,
  ConfirmDialog,
  FigureList,
  FigureRow,
  FileDrop,
  LockedState,
  Meter,
  Progress,
  buttonClass,
  formatNumber,
} from '../../../../ui';
import { previewUploadCost, uploadDocuments } from '../../../../services/api';
import type { UploadCostPreview } from '../../../../services/api';
import { IngestionProgress } from '../IngestionProgress';
import { errorMessage } from '../knowledge-api';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_EXTENSIONS,
  charactersAsWords,
  uploadSkipReason,
  type Allowance,
} from '../knowledge-model';
import { useTranslation } from '../../../../i18n/useTranslation';

export interface DocumentsFlowProps {
  agentId: number;
  /** Plan allowance for uploaded documents — workspace-wide. */
  documentAllowance: Allowance;
  /**
   * Knowledge-base size allowance, in characters. `null` when the plan payload
   * does not report the limit at all — which is not the same as a full one.
   */
  characterAllowance: Allowance | null;
  planName: string;
  /** True while entitlements are still resolving; nothing locks until then. */
  planLoading: boolean;
  onChanged: () => void;
}

/**
 * Upload documents a chatbot can answer from.
 *
 * **An upload reports honest progress.** `POST /ingest` returns 202 with a
 * `job_id` and the reading, chunking and embedding all happen afterwards, so the
 * spinner this replaces stopped a long way before the document was answerable.
 * The job is polled, and while it is moving the surface shows motion rather than
 * a coloured "processing" pill — this system has no hue for in-progress.
 *
 * The two workspace-wide quotas are `Meter`s here, which is why the knowledge
 * page no longer carries a 260px card restating them: a customer on that page
 * was reading their document quota four times.
 */
export function DocumentsFlow({
  agentId,
  documentAllowance,
  characterAllowance,
  planName,
  planLoading,
  onChanged,
}: DocumentsFlowProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<File[] | null>(null);
  const [quote, setQuote] = useState<UploadCostPreview | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      setLanded(null);
      setQuoting(true);
      try {
        // The cost preview extracts and counts words server-side without saving
        // anything or touching the ledger, so the customer sees the price before
        // a single credit moves. When it is unavailable we say so rather than
        // uploading anyway — an unpriced charge is not a confirmation.
        const preview = await previewUploadCost(files, agentId);
        if (!preview) {
          setError(
            t('agents.weCouldNotPriceThese') || 'We could not price these documents just now, so we have not uploaded them. Try again in a moment.',
          );
          return;
        }
        setPending(files);
        setQuote(preview);
      } catch (cause) {
        setError(errorMessage(cause, t('agents.weCouldNotReadThose') || 'We could not read those files. Please try again.'));
      } finally {
        setQuoting(false);
      }
    },
    [agentId, t],
  );

  async function upload() {
    if (!pending) return;
    const files = pending;
    setUploading(true);
    setError(null);
    try {
      const result = (await uploadDocuments(files, agentId)) as {
        job_id?: string;
        credits_charged?: number;
      } | null;
      // `job_id` is present only when the API runs with the ARQ worker. Without
      // it, ingestion happens inline and there is nothing to poll — which the
      // progress component says plainly rather than spinning for ever.
      setJobId(typeof result?.job_id === 'string' ? result.job_id : null);
      setLanded(
        `${files.length} document${files.length === 1 ? '' : 's'} uploaded${
          typeof result?.credits_charged === 'number' && result.credits_charged > 0
            ? ` · ${formatNumber(result.credits_charged)} credits charged`
            : ''
        }.`,
      );
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, t('agents.thatUploadDidNotGo') || 'That upload did not go through. Please try again.'));
    } finally {
      // The confirmation closes either way. A failure explained behind a modal
      // the customer cannot see is the same as no explanation at all.
      setPending(null);
      setQuote(null);
      setUploading(false);
    }
  }

  if (documentAllowance.atLimit && !planLoading) {
    return (
      <CardBody>
        <LockedState
          size="panel"
          title={`${planName}: no documents left`}
          description={`This plan covers ${formatNumber(documentAllowance.limit)} documents across this workspace. Remove one below, or move up.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              {t('agents.seePlans') || 'See plans'}
            </Link>
          }
        />
      </CardBody>
    );
  }

  if (characterAllowance !== null && characterAllowance.atLimit && !planLoading) {
    return (
      <CardBody>
        <LockedState
          size="panel"
          title={`${planName}: no knowledge base left`}
          description={`This plan holds ${formatNumber(characterAllowance.limit)} characters. Remove something below, or move up.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              {t('agents.seePlans') || 'See plans'}
            </Link>
          }
        />
      </CardBody>
    );
  }

  const skipped = quote?.per_file.filter((file) => file.reason) ?? [];
  const billable = quote?.per_file.filter((file) => !file.reason) ?? [];
  // The confirm only opens when confirming would actually do something. A dialog
  // whose primary button is inert because the balance is short teaches people
  // that the button is a suggestion; an unaffordable quote is answered on the
  // page, beside the files, with the way to fix it.
  const affordable = quote !== null && quote.sufficient && quote.total_credits > 0;

  function clearPending() {
    setPending(null);
    setQuote(null);
  }

  return (
    <>
      <CardBody className="space-y-4">
        {planLoading ? null : documentAllowance.unlimited ? (
          <p className="text-xs text-text-secondary">
            No document limit on {planName} — uploads are charged in credits, by length.
          </p>
        ) : (
          // The scope is the `Meter`'s `hint` now. It was folded into the label
          // — "Documents across this workspace" — because the primitive had
          // nowhere else to put it, which made the name of the quota four words
          // long and pushed the figure it is read against off to the right.
          <Meter
            label={t('agents.documents') || 'Documents'}
            hint={t('agents.acrossThisWorkspaceNotJust') || 'Across this workspace, not just this chatbot.'}
            used={documentAllowance.used}
            limit={documentAllowance.limit}
            tone="plan"
          />
        )}

        {characterAllowance && !planLoading ? (
          <Meter
            label={t('agents.knowledgeBase') || 'Knowledge base'}
            hint={`About ${formatNumber(charactersAsWords(characterAllowance.used))} words of text stored.`}
            used={characterAllowance.used}
            limit={characterAllowance.limit}
            unit="chars"
            tone="plan"
          />
        ) : null}

        <FileDrop
          label={t('agents.dropDocumentsHereOrChoose') || 'Drop documents here, or choose files'}
          hint={t('agents.anythingAVisitorMightAsk') || 'Anything a visitor might ask about.'}
          accept={UPLOAD_EXTENSIONS}
          maxSizeBytes={MAX_UPLOAD_BYTES}
          maxFiles={MAX_UPLOAD_FILES}
          disabled={quoting || uploading || pending !== null}
          onFiles={(files) => void handleFiles(files)}
        />

        {quoting ? (
          <Progress value={null} label={t('agents.workingOutWhatTheseDocuments') || 'Working out what these documents will cost'} />
        ) : null}

        {quote !== null && !affordable ? (
          <Alert
            tone="plan"
            title={
              quote.total_credits === 0
                ? t('agents.thereIsNothingToUpload') || 'There is nothing to upload here'
                : t('agents.notEnoughCreditsForThese') || 'Not enough credits for these documents'
            }
            action={
              quote.total_credits === 0 ? (
                <Button size="sm" onClick={clearPending}>
                  {t('agents.chooseOtherFiles') || 'Choose other files'}
                </Button>
              ) : (
                <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                  {t('agents.topUp') || 'Top up'}
                </Link>
              )
            }
          >
            {quote.total_credits === 0 ? (
              <>
                None of these files had readable text — most often a scanned PDF. Nothing was
                uploaded and nothing was charged.
              </>
            ) : (
              <>
                These cost <span className="figure">{formatNumber(quote.total_credits)}</span>{' '}
                credits and you have{' '}
                <span className="figure">{formatNumber(quote.current_balance)}</span>. Nothing has
                been uploaded or charged.
              </>
            )}
          </Alert>
        ) : null}

        {jobId !== null || landed !== null ? (
          <IngestionProgress
            jobId={jobId}
            title={t('agents.readingYourDocuments') || 'Reading your documents'}
            detail={landed ?? (t('agents.uploaded') || 'Uploaded')}
            onFinished={onChanged}
          />
        ) : null}

        {error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={pending !== null && affordable}
        onOpenChange={(open) => {
          if (!open) clearPending();
        }}
        title={`Upload ${pending?.length ?? 0} document${(pending?.length ?? 0) === 1 ? '' : 's'}?`}
        description={
          quote ? (
            <>
              This charges <span className="figure">{formatNumber(quote.total_credits)}</span>{' '}
              credit{quote.total_credits === 1 ? '' : 's'} from a balance of{' '}
              <span className="figure">{formatNumber(quote.current_balance)}</span>. Documents are
              priced by length.
            </>
          ) : null
        }
        confirmLabel={`Upload for ${formatNumber(quote?.total_credits ?? 0)} credits`}
        onConfirm={upload}
      >
        {/* The per-file breakdown is the dialog's own block, not part of its
            description. `description` renders inside a `<p>`, and a `<dl>` in a
            `<p>` is invalid — React logs "cannot contain a nested <dl>" and the
            browser closes the paragraph early, so the list escaped the block it
            was written into. `ConfirmDialog` takes children now. */}
        {quote ? (
          <FigureList className="max-h-48 overflow-y-auto">
            {billable.map((file) => (
              <FigureRow
                key={file.filename}
                label={file.filename}
                value={`${formatNumber(file.credits)} credits`}
                hint={`${formatNumber(file.words)} words`}
              />
            ))}
            {skipped.map((file) => (
              <FigureRow
                key={file.filename}
                label={file.filename}
                value="Free"
                hint={uploadSkipReason(file.reason) ?? undefined}
              />
            ))}
          </FigureList>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
