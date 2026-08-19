import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { Alert, Button, Dialog, Field, Input, Spinner, normalizeUrl, validateUrl } from '../../../ui';
import { getBotPreviewUrl } from '../../../services/api';

/**
 * The widget on the customer's own website.
 *
 * The frame loads an OyeChats-hosted demo page, which overlays the live widget
 * on top of the URL given — so it is never blocked by the *customer's*
 * `X-Frame-Options`. Their site can still refuse to render inside our demo
 * page, which is why the demo posts a ready message and this dialog degrades to
 * "open in a new tab" rather than leaving a blank rectangle and no explanation.
 *
 * It shows the SAVED widget, because it loads the real one by bot key. That is
 * stated on the dialog rather than discovered by a user wondering why the
 * colour they just picked is not there.
 */

/** How long to wait for the demo page's ping before offering the fallback. */
const READY_TIMEOUT_MS = 8000;

const READY_MESSAGE = 'oyechats:preview-ready';

export interface WebsitePreviewDialogProps {
  open: boolean;
  onClose: () => void;
  botKey: string | null;
  website: string | null;
}

export function WebsitePreviewDialog({
  open,
  onClose,
  botKey,
  website,
}: WebsitePreviewDialogProps): ReactElement | null {
  const [url, setUrl] = useState(() => website ?? '');
  const [error, setError] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!loadedUrl) return undefined;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | null;
      if (data && typeof data === 'object' && data.type === READY_MESSAGE) setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadedUrl]);

  // Cleared by `ready` flipping, so a healthy preview never trips the warning.
  useEffect(() => {
    if (!loadedUrl || ready) return undefined;
    const timer = window.setTimeout(() => setSlow(true), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadedUrl, ready]);

  const load = useCallback((): void => {
    const reason = validateUrl(url);
    if (reason) {
      setError(reason);
      return;
    }
    const normalized = normalizeUrl(url);
    setError(null);
    setUrl(normalized);
    setFrameLoaded(false);
    setReady(false);
    setSlow(false);
    setLoadedUrl(normalized);
  }, [url]);

  if (!botKey) return null;

  const src = loadedUrl ? getBotPreviewUrl(botKey, loadedUrl, { edit: true }) : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Preview on my website"
      description="Loads the live widget over your own site. It shows your saved settings, so save first."
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Website address"
            hint="Any page on your site. A staging URL works too."
            error={error}
            className="min-w-0 flex-1"
          >
            <Input
              value={url}
              placeholder="https://your-website.com"
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  load();
                }
              }}
            />
          </Field>
          <Button onClick={load} disabled={url.trim().length === 0}>
            {loadedUrl ? (
              <RefreshCw aria-hidden className="h-4 w-4" />
            ) : (
              <Globe aria-hidden className="h-4 w-4" />
            )}
            {loadedUrl ? 'Reload' : 'Load preview'}
          </Button>
        </div>

        {src ? (
          <div className="flex flex-col gap-2">
            <div className="relative overflow-hidden rounded-md border border-border bg-surface-sunken">
              {!frameLoaded ? (
                <p className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-text-secondary">
                  <Spinner />
                  Loading your site…
                </p>
              ) : null}
              <iframe
                key={src}
                src={src}
                title="Your website with the chat widget"
                onLoad={() => setFrameLoaded(true)}
                className="h-120 w-full"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            </div>

            {slow && !ready ? (
              <Alert
                tone="warning"
                title="Your site may block being embedded"
                action={
                  <a
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-accent-600 hover:underline"
                  >
                    Open in a new tab
                    <ExternalLink aria-hidden className="h-3 w-3" />
                  </a>
                }
              >
                The widget still works on the live site once it is installed — this is only about
                showing it inside this window.
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
