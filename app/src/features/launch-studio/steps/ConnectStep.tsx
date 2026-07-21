import { useState } from 'react';
import { Globe, Upload, Loader2, FileCheck2 } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { updateBot, uploadDocuments, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useCrawl } from '../../../context/CrawlContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * Step 3 — Connect Website. Saves the website and kicks off a real crawl
 * (monitored on AI Training). Or upload documents instead — a real fallback for
 * sites we can't crawl (JS-rendered / no site), which also lets the user proceed.
 */
export function ConnectStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { crawl, startCrawl } = useCrawl();
  const [url, setUrl] = useState(selectedBot?.website ?? '');
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (fileList: FileList) => {
    if (!selectedBot || fileList.length === 0) return;
    setUploadingDocs(true);
    setError(null);
    try {
      const files = Array.from(fileList);
      await uploadDocuments(files, selectedBot.id);
      setUploadedCount((count) => count + files.length);
      void recordActivationEvent('documents_uploaded', { botId: selectedBot.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploadingDocs(false);
    }
  };

  const handleContinue = async () => {
    if (!selectedBot) {
      setError('Create your agent first.');
      return;
    }
    const trimmed = url.trim();

    // Documents-only path — already uploading/ingesting, just proceed.
    if (!trimmed && uploadedCount > 0) {
      props.onContinue();
      return;
    }
    if (!trimmed) return;

    const site = normalizeUrl(trimmed);
    setSubmitting(true);
    setError(null);
    try {
      await updateBot(selectedBot.id, { website: site });
      const alreadyRunning =
        crawl.botId === selectedBot.id && (crawl.status === 'running' || crawl.status === 'done');
      if (!alreadyRunning) {
        await startCrawl({
          url: site,
          botId: selectedBot.id,
          botName: selectedBot.name,
          mode: 'full',
        });
        void recordActivationEvent('crawl_started', { botId: selectedBot.id });
      }
      props.onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const canContinue =
    (url.trim().length > 0 || uploadedCount > 0) && !submitting && !uploadingDocs;

  return (
    <StepShell
      title="Connect your website"
      description="Your AI learns from your website. Drop in your address and we'll do the rest."
      onBack={props.onBack}
      onContinue={handleContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={canContinue}
      continueLabel={submitting ? 'Starting…' : undefined}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Website address
          </span>
          <div className="relative">
            <Globe
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="yourcompany.com"
              className="pl-9"
              autoFocus
            />
          </div>
        </label>

        <div className="flex items-center gap-3 text-[12px] text-[var(--ds-text-subtle)]">
          <span className="h-px flex-1 bg-[var(--ds-border)]" />
          or
          <span className="h-px flex-1 bg-[var(--ds-border)]" />
        </div>

        <label className="block cursor-pointer">
          <Card className="flex items-center gap-3 p-4 transition-colors hover:border-[var(--ds-accent)]">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
              {uploadingDocs ? (
                <Loader2 size={17} className="animate-spin" />
              ) : uploadedCount > 0 ? (
                <FileCheck2 size={17} className="text-[var(--ds-success)]" />
              ) : (
                <Upload size={17} />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--ds-text)]">
                {uploadedCount > 0
                  ? `${uploadedCount} document${uploadedCount === 1 ? '' : 's'} added — add more or continue`
                  : 'No website? Upload documents'}
              </p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">
                PDFs, docs or text — a fallback for sites we can't crawl.
              </p>
            </div>
          </Card>
          <input
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.md,image/*"
            className="hidden"
            disabled={uploadingDocs}
            onChange={(event) => {
              if (event.target.files) handleFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>

        {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}
      </div>
    </StepShell>
  );
}
