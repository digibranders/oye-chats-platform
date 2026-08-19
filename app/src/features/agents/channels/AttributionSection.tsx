import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
  LockedState,
  Skeleton,
  buttonClass,
  validateUrl,
} from '../../../ui';
import { ATTRIBUTION_TEXT } from '../../../data/widgetEmbed';

const DEFAULT_TEXT = ATTRIBUTION_TEXT;
const DEFAULT_URL = 'https://www.oyechats.com';
/** `Name` in `api/app/schemas/validators.py` — `MAX_NAME = 200`. */
const MAX_TEXT = 200;

export interface AttributionSectionProps {
  /** `feature_flags.branding_removable` on the workspace's plan. */
  entitled: boolean;
  entitlementsLoading: boolean;
  initialText: string | null;
  initialUrl: string | null;
  onSave: (patch: { branding_text: string; branding_url: string }) => Promise<void>;
  saving: boolean;
}

/**
 * The credit line inside the chat window.
 *
 * Distinct from the anchor in the snippet, and the page says so, because they
 * are two different things that the same entitlement controls and customers
 * routinely conflate them. The anchor lives in the HTML the customer's server
 * sends and is the only attribution a crawler can see. This is the small line at
 * the bottom of the open chat window, which a visitor sees and a crawler never
 * does.
 *
 * It lives on Deploy rather than on Experience — where the rest of the widget's
 * appearance is configured — because the backend gates it on exactly the
 * entitlement that also decides which snippet this page emits
 * (`bot_routes.py` forces both `branding_text` and `branding_url` back to the
 * defaults for any plan without `branding_removable`). Splitting the two halves
 * of one entitlement across two screens is how a customer ends up on a paid plan
 * with a white-labelled badge and an OyeChats link still in their footer.
 *
 * Anything typed here on an unentitled plan would be silently overridden on
 * every widget load, so the fields are not merely disabled — they are not
 * offered at all, and the reason is named.
 */
export function AttributionSection({
  entitled,
  entitlementsLoading,
  initialText,
  initialUrl,
  onSave,
  saving,
}: AttributionSectionProps) {
  const [text, setText] = useState(initialText?.trim() || DEFAULT_TEXT);
  const [url, setUrl] = useState(initialUrl?.trim() || DEFAULT_URL);
  const [baseline, setBaseline] = useState({
    text: initialText?.trim() || DEFAULT_TEXT,
    url: initialUrl?.trim() || DEFAULT_URL,
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const urlProblem = url.trim() ? validateUrl(url.trim()) : 'Enter a web address.';
  const textProblem =
    text.trim().length === 0
      ? 'Enter the words to show, or leave the default.'
      : text.trim().length > MAX_TEXT
        ? `Keep it to ${MAX_TEXT} characters or fewer.`
        : null;
  const dirty = text.trim() !== baseline.text || url.trim() !== baseline.url;

  async function commit() {
    if (urlProblem || textProblem) return;
    setError(null);
    try {
      // The backend takes an `HttpUrlStr`: an http(s) scheme is mandatory and a
      // bare host is rejected, so it is added here rather than surfaced as a 422.
      const nextUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      await onSave({ branding_text: text.trim(), branding_url: nextUrl });
      setBaseline({ text: text.trim(), url: nextUrl });
      setUrl(nextUrl);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not save your branding.');
    }
  }

  if (entitlementsLoading) {
    return (
      <Card>
        <CardHeader
          eyebrow="Branding"
          titleAs="h2"
          title="The credit line in the chat window"
          description="Checking what your plan includes…"
        />
        <CardBody aria-busy className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-80" />
        </CardBody>
      </Card>
    );
  }

  if (!entitled) {
    return (
      <LockedState
        title="White-label branding is on Standard and above"
        description={`Your chat window shows “${DEFAULT_TEXT}” at the bottom, and your snippet carries the matching credit link. Plans with white-label branding let you replace both with your own wording and link — or remove them entirely.`}
        action={
          <Link to="/billing" className={buttonClass('primary', 'sm')}>
            Compare plans
          </Link>
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Branding"
        titleAs="h2"
        title="The credit line in the chat window"
        description="The small line at the bottom of the open chat. Your plan lets you make it yours."
      />
      <CardBody className="space-y-4">
        <Alert tone="neutral" title="This is not the link in your snippet">
          This line lives inside the chat window, which only exists after a visitor clicks — no
          crawler ever sees it. Whether your snippet carries the separate, crawlable credit link is
          decided by the same plan, and on yours it does not.
        </Alert>

        <Field label="Wording" hint="Shown at the bottom of the chat window." error={textProblem}>
          <Input
            value={text}
            maxLength={MAX_TEXT}
            onChange={(event) => {
              setText(event.target.value);
              setSaved(false);
              setError(null);
            }}
            className="max-w-sm"
          />
        </Field>

        <Field
          label="Where it links to"
          hint="Visitors who click the line go here. Your own site is a reasonable choice."
          error={url.trim() ? urlProblem : null}
        >
          <Input
            value={url}
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setUrl(event.target.value);
              setSaved(false);
              setError(null);
            }}
            className="figure max-w-md"
          />
        </Field>

        {error ? (
          <Alert tone="danger" live title="That did not save">
            {error}
          </Alert>
        ) : null}
        {saved && !dirty ? (
          <Alert tone="success" live>
            Saved. New conversations show your wording.
          </Alert>
        ) : null}
      </CardBody>
      <CardFooter>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || (text.trim() === DEFAULT_TEXT && url.trim() === DEFAULT_URL)}
          onClick={() => {
            setText(DEFAULT_TEXT);
            setUrl(DEFAULT_URL);
            setSaved(false);
            setError(null);
          }}
        >
          Reset to default
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || Boolean(urlProblem) || Boolean(textProblem)}
          loading={saving}
          onClick={() => void commit()}
        >
          Save branding
        </Button>
      </CardFooter>
    </Card>
  );
}
