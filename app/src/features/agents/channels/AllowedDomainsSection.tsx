import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Field,
  TagInput,
} from '../../../ui';
import {
  MAX_DOMAINS,
  domainNotice,
  entriesForWebsite,
  normalizeDomain,
  ownSiteRisk,
} from './deployModel';

export interface DomainSettings {
  allowed_domains: string[];
  domain_check_enabled: boolean;
}

export interface AllowedDomainsSectionProps {
  website: string | null;
  initialDomains: readonly string[];
  initialEnabled: boolean;
  /**
   * Persist and hand back what the server actually stored.
   *
   * The return value matters: `PATCH /bots/{id}` normalises what it keeps —
   * `https://WWW.Acme.com/pricing` comes back as `acme.com` — so adopting the
   * response is the only way the chips on screen stay the rules being enforced.
   */
  onSave: (patch: DomainSettings) => Promise<DomainSettings>;
  saving: boolean;
}

/**
 * Who is allowed to embed this chatbot.
 *
 * The embed key is public — it is in the page source of every site that runs the
 * widget — so this list is the only thing stopping a stolen key from spending
 * the customer's credits somewhere else. It is also, by a wide margin, the
 * fastest way for a customer to take their own widget offline, which is why
 * saving it is guarded rather than merely accepted.
 *
 * The guard exists because of one exact asymmetry in the backend. It normalises
 * a stored entry by stripping `www.` (`normalize_domain_input`), but it reads
 * the browser's `Origin` header **without** stripping it (`extract_hostname`).
 * So a site served at `www.acme.com` and an allow-list of `acme.com` do not
 * match, and enforcement rejects every request from the customer's own homepage.
 * `*.acme.com` is the only entry that admits it. That is not something anyone
 * should have to discover from a support ticket, so this checks the chatbot's
 * own website against the list it is about to save and refuses to pass it by in
 * silence.
 *
 * The enable flag is a `Checkbox`, not a `Switch`: it is saved with the list, and
 * a switch means "this takes effect the moment you touch it". Mixing the two is
 * how someone flips a security control and then wonders why Save did nothing.
 */
export function AllowedDomainsSection({
  website,
  initialDomains,
  initialEnabled,
  onSave,
  saving,
}: AllowedDomainsSectionProps) {
  // The last known server state, which is what "Discard changes" returns to.
  // Seeded from props and replaced by every successful save, so discarding after
  // a save goes back to what was saved rather than to what the page loaded with.
  const [baseline, setBaseline] = useState<DomainSettings>({
    allowed_domains: [...initialDomains],
    domain_check_enabled: initialEnabled,
  });
  const [domains, setDomains] = useState<string[]>([...initialDomains]);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const notice = useMemo(
    () => domainNotice({ website, domains, enabled }),
    [website, domains, enabled],
  );
  const risk = useMemo(
    () => ownSiteRisk({ website, domains, enabled }),
    [website, domains, enabled],
  );

  const suggestions = useMemo(() => entriesForWebsite(website), [website]);
  const missing = suggestions.filter((entry) => !domains.includes(entry));

  function change(next: { domains?: string[]; enabled?: boolean }) {
    if (next.domains) setDomains(next.domains);
    if (next.enabled !== undefined) setEnabled(next.enabled);
    setDirty(true);
    setSaved(false);
    setError(null);
  }

  async function commit() {
    setError(null);
    try {
      const stored = await onSave({ allowed_domains: domains, domain_check_enabled: enabled });
      setBaseline(stored);
      setDomains(stored.allowed_domains);
      setEnabled(stored.domain_check_enabled);
      setDirty(false);
      setSaved(true);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not save your domains.');
      setConfirming(false);
    }
  }

  function requestSave() {
    if (risk) {
      setConfirming(true);
      return;
    }
    void commit();
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Who can embed it"
        titleAs="h2"
        title="Allowed domains"
        description="Your embed key is public. This is what stops someone copying it onto their own site and spending your credits."
      />
      <CardBody className="space-y-4">
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>

        {/* `aria-label` alongside the visible `label` on purpose. `Checkbox`
            associates its visible label through `htmlFor={fieldProps.id}`, and
            outside a `Field` there is no id — so the control ships with no
            accessible name at all. Reported as a `src/ui` defect; this is the
            call-site guard until it is fixed there. */}
        <Checkbox
          checked={enabled}
          onCheckedChange={(next) => change({ enabled: next === true })}
          label="Only allow the domains listed below"
          aria-label="Only allow the domains listed below"
          description="Requests from anywhere else are rejected before they reach your chatbot. An empty list allows everything, so this only starts protecting you once you add one."
        />

        <Field
          label="Domains"
          hint={`Enter, comma or Tab adds one. Start an entry with *. to cover every subdomain — *.acme.com covers www, shop and blog, but not acme.com itself, so most sites want both. Up to ${MAX_DOMAINS}.`}
        >
          <TagInput
            values={domains}
            onValuesChange={(next) => change({ domains: next })}
            label="Allowed domains"
            placeholder="acme.com"
            maxValues={MAX_DOMAINS}
            disabled={saving}
            // Normalise the way the backend will, so the chip the customer sees
            // is the value that actually gets stored — an entry typed as
            // `https://www.acme.com/pricing` is saved as `acme.com`, and showing
            // it any other way would be showing them a rule that is not the one
            // being enforced.
            normalize={(value) => normalizeDomain(value) ?? value.trim().toLowerCase()}
            validate={(value) =>
              normalizeDomain(value)
                ? null
                : `${value} is not a domain. Use a hostname like acme.com or *.acme.com.`
            }
          />
        </Field>

        {missing.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => change({ domains: [...domains, ...missing].slice(0, MAX_DOMAINS) })}
            iconLeft={<Plus aria-hidden className="h-3.5 w-3.5" />}
          >
            Add {missing.join(' and ')}
          </Button>
        ) : null}

        {error ? (
          <Alert tone="danger" live title="That did not save">
            {error}
          </Alert>
        ) : null}
        {saved && !dirty ? (
          <Alert tone="success" live>
            Saved. {enabled && domains.length > 0
              ? 'Only these domains can load your chatbot now.'
              : 'Your chatbot accepts requests from anywhere.'}
          </Alert>
        ) : null}
      </CardBody>
      <CardFooter>
        <Button
          variant="ghost"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => {
            setDomains([...baseline.allowed_domains]);
            setEnabled(baseline.domain_check_enabled);
            setDirty(false);
            setError(null);
          }}
        >
          Discard changes
        </Button>
        <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={requestSave}>
          Save domains
        </Button>
      </CardFooter>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="This will block your own website"
        description={
          risk
            ? `Your chatbot is set up for ${risk.host}, and that address does not match anything on this list. Save it and the widget will stop loading there — visitors will see nothing at all. Adding ${risk.suggestions.join(' and ')} fixes it.`
            : ''
        }
        confirmLabel="Save anyway"
        cancelLabel="Go back and fix it"
        destructive
        onConfirm={commit}
      />
    </Card>
  );
}
