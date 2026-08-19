import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
} from '../../../ui';
import { normalizeDomain } from './deployModel';

export interface SessionContinuitySectionProps {
  website: string | null;
  /** `Bot.session_share_domain` — a bare hostname, or null for auto-detect. */
  initialShareDomain: string | null;
  onSave: (patch: { session_share_domain: string }) => Promise<string | null>;
  saving: boolean;
}

/**
 * Keeping one conversation alive across a customer's subdomains.
 *
 * The widget stores a visitor's session id in `localStorage`, which the browser
 * partitions per origin, so a chat started on `acme.com` would start over on
 * `academy.acme.com`. It bridges that by mirroring the id into a cookie scoped to
 * the parent domain, which every subdomain can read.
 *
 * This is **already on**. With no value stored the widget detects the registrable
 * apex of whatever page it is running on and scopes the cookie there, so
 * continuity works with nothing configured. The field below is therefore an
 * override for the few owners who want to pin a specific parent — not a setup
 * step — and it is presented that way rather than as an off switch, because
 * presenting a working feature as unconfigured invites people to "fix" it.
 *
 * A wildcard is rejected on purpose: this value becomes a cookie `Domain`
 * attribute, which is a single parent domain and cannot be a pattern. The
 * backend raises on one (`_normalize_session_share_domain`); we say so before
 * the request instead of surfacing a 422.
 */
export function SessionContinuitySection({
  website,
  initialShareDomain,
  onSave,
  saving,
}: SessionContinuitySectionProps) {
  const [baseline, setBaseline] = useState((initialShareDomain ?? '').trim());
  const [value, setValue] = useState((initialShareDomain ?? '').trim());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const websiteApex = useMemo(() => normalizeDomain(website ?? ''), [website]);
  const trimmed = value.trim();
  const normalized = useMemo(() => normalizeDomain(trimmed), [trimmed]);
  const dirty = trimmed !== baseline;

  // A wildcard is a legitimate allow-list entry and an illegitimate cookie
  // domain, so it gets its own message rather than the generic one.
  const wildcard = trimmed.startsWith('*.');
  const invalid = trimmed.length > 0 && (wildcard || !normalized);

  const scope = normalized ?? websiteApex;

  async function commit() {
    if (invalid) return;
    setError(null);
    try {
      // An empty string clears the override server-side and returns the widget
      // to auto-detect. Continuity itself never turns off.
      const stored = await onSave({ session_share_domain: normalized ?? '' });
      const next = (stored ?? '').trim();
      setBaseline(next);
      setValue(next);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not save that domain.');
    }
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Across your subdomains"
        titleAs="h2"
        title="Continuing a conversation"
        description="A visitor who starts chatting on your homepage and moves to another part of your site keeps the same conversation."
        actions={<Badge tone="success">{baseline ? 'Pinned' : 'Automatic'}</Badge>}
      />
      <CardBody className="space-y-4">
        <Alert tone="success" title={baseline ? `Scoped to *.${baseline}` : 'On, with nothing to set up'}>
          {baseline
            ? `A chat started on ${baseline} continues on every subdomain of it — app.${baseline}, academy.${baseline}, and so on.`
            : scope
              ? `We detect ${scope} from the page the widget is running on and keep the conversation across all of its subdomains.`
              : 'We detect the parent domain from the page the widget is running on and keep the conversation across all of its subdomains.'}
        </Alert>

        <Field
          label="Pin a parent domain (optional)"
          hint="Leave this empty unless you need to scope narrower or wider than the address the widget is running on. No wildcard — this becomes a cookie domain, and a cookie domain is one parent, not a pattern."
          error={
            invalid
              ? wildcard
                ? 'A wildcard will not work here. Use the parent domain on its own, e.g. acme.com.'
                : 'That is not a domain. Use a hostname like acme.com.'
              : null
          }
        >
          <Input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setSaved(false);
              setError(null);
            }}
            placeholder={websiteApex ? `Detected automatically (${websiteApex})` : 'Detected automatically'}
            className="figure max-w-sm"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        {/* Continuity is not appearance. The most common misreading of this
            control is that turning it on puts the widget on the subdomains too. */}
        <Alert tone="neutral" title="This does not put the widget on those pages">
          It keeps the <strong>conversation</strong> going. For the chat to <strong>appear</strong>{' '}
          on <span className="figure">academy.{scope ?? 'acme.com'}</span>, that page needs the same
          snippet as every other — the one further up this page.
        </Alert>

        {error ? (
          <Alert tone="danger" live title="That did not save">
            {error}
          </Alert>
        ) : null}
        {saved && !dirty ? (
          <Alert tone="success" live>
            Saved. {baseline ? `Conversations now follow visitors across *.${baseline}.` : 'Back to detecting the parent domain automatically.'}
          </Alert>
        ) : null}
      </CardBody>
      <CardFooter>
        {trimmed ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              setValue('');
              setSaved(false);
              setError(null);
            }}
          >
            Back to automatic
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || invalid}
          loading={saving}
          onClick={() => void commit()}
        >
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}
