import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { ExternalLink, Globe, Loader2, RefreshCw } from 'lucide-react';
import { Button, Input, SectionHeader } from '../../../design-system';
import { getBotPreviewUrl } from '../../../services/api';

export interface WebsitePreviewPanelProps {
  /** The agent's public bot key, needed to build the hosted preview URL. Null hides the panel. */
  botKey: string | null;
  /** The agent's configured website, used to prefill the URL field. */
  website: string | null;
}

/** How long to wait for the hosted preview's ready ping before warning it may be blocked. */
const READY_TIMEOUT_MS = 8000;

/** The message the hosted demo page posts once it (and the overlaid widget) are up. */
const READY_MESSAGE = 'oyechats:preview-ready';

/** Prefix a bare host with https:// so the hosted preview always gets an absolute URL. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * WebsitePreviewPanel - a real "preview on my website" affordance. Loading a URL
 * renders the OyeChats-hosted demo page in an iframe; that page overlays the live
 * widget on top of the customer's site. Because the frame is our own hosted page
 * (not the customer's site directly), it is never blocked by the customer's
 * X-Frame-Options - but the customer's site CAN refuse to render inside the demo
 * page, so we listen for the demo page's ready ping and, if it never arrives,
 * surface a graceful "open in a new tab" fallback instead of a broken frame.
 */
export function WebsitePreviewPanel({ botKey, website }: WebsitePreviewPanelProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  // Agent (and its website) is resolved before this panel mounts, so a lazy
  // initial value is stable - no prefill effect (and its sync setState) needed.
  const [urlInput, setUrlInput] = useState<string>(() => website ?? '');
  const [loadedUrl, setLoadedUrl] = useState('');
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);

  // Listen for the hosted demo page's ready ping while a preview is loaded.
  useEffect(() => {
    if (!loadedUrl) return undefined;
    const onMessage = (event: MessageEvent): void => {
      if (
        event.data &&
        typeof event.data === 'object' &&
        (event.data as { type?: unknown }).type === READY_MESSAGE
      ) {
        setReady(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadedUrl]);

  // Warn (non-fatally) if the demo page never signals ready - the overlaid site
  // is likely refusing to embed. Once `ready` flips true this effect re-runs and
  // clears the pending timer, so a healthy preview never trips the warning.
  useEffect(() => {
    if (!loadedUrl || ready) return undefined;
    const timer = window.setTimeout(() => setSlow(true), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadedUrl, ready]);

  const handleLoad = useCallback((): void => {
    if (!botKey) return;
    const normalized = normalizeUrl(urlInput);
    if (normalized.length === 0) return;
    setUrlInput(normalized);
    setFrameLoaded(false);
    setReady(false);
    setSlow(false);
    setLoadedUrl(normalized);
  }, [botKey, urlInput]);

  if (!botKey) return null;

  const previewSrc = loadedUrl ? getBotPreviewUrl(botKey, loadedUrl, { edit: true }) : '';

  return (
    <section className="rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5">
      <SectionHeader
        title="Preview on my website"
        description="See the widget on your own site. It shows your saved settings - save first, then reload."
        actions={
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            <Globe size={14} />
            {open ? 'Hide preview' : 'Open preview'}
          </Button>
        }
      />

      {open && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={urlInput}
              placeholder="https://your-website.com"
              aria-label="Website URL to preview"
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLoad();
              }}
            />
            <Button
              onClick={handleLoad}
              disabled={urlInput.trim().length === 0}
              className="shrink-0"
            >
              {loadedUrl ? <RefreshCw size={15} /> : <Globe size={15} />}
              {loadedUrl ? 'Reload' : 'Load preview'}
            </Button>
          </div>

          {previewSrc && (
            <div className="space-y-2">
              <div className="relative overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]">
                {!frameLoaded && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                    <Loader2 size={16} className="animate-spin" />
                    Loading preview…
                  </div>
                )}
                <iframe
                  key={previewSrc}
                  src={previewSrc}
                  title="Website preview with the chat widget"
                  onLoad={() => setFrameLoaded(true)}
                  className="h-[600px] w-full"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              </div>

              {slow && !ready && (
                <p
                  role="status"
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2 text-[12px] text-[var(--ds-text-muted)]"
                >
                  Your site may block being embedded. The widget still works on the live site once
                  installed.
                  <a
                    href={previewSrc}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-[var(--ds-accent)] hover:underline"
                  >
                    Open preview in a new tab
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
