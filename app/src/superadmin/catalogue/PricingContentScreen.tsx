import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  LoadingRows,
  LockedState,
  Section,
  Stack,
  Textarea,
  formatNumber,
  toast,
} from '../../ui';
import { platform } from '../client';
import { usePlatformResource } from '../usePlatform';
import {
  CONTENT_BLOBS,
  MAX_PRICING_ITEMS,
  changedBlobs,
  parseBlob,
  serialiseContent,
  type ContentDrafts,
} from './content-model';
import type { JsonValue, PricingContent } from './types';

/**
 * The public pricing page's copy.
 *
 * Four JSONB lists behind `GET/PUT /superadmin/pricing-content`, each rendered
 * on oyechats.com. The item shape is content, not contract, so this is an honest
 * JSON editor rather than a form pretending to know fields the server does not
 * define — and everything it does add is in `content-model.ts`, where it can be
 * tested: parse before send, send only what changed, confirm before publishing.
 */
export function PricingContentScreen() {
  const content = usePlatformResource<PricingContent>('/pricing-content');
  const [drafts, setDrafts] = useState<ContentDrafts>(() => serialiseContent(null));
  const [original, setOriginal] = useState<ContentDrafts>(() => serialiseContent(null));
  const [errors, setErrors] = useState<Partial<Record<keyof PricingContent, string>>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncedFrom, setSyncedFrom] = useState<PricingContent | null>(null);

  // Adjusted during render rather than in an effect. An effect would paint the
  // empty editor first and replace it a frame later, which is a flash of an
  // empty array where the operator's copy is about to appear; this is React's
  // documented pattern for state derived from a changing prop.
  if (content.data && content.data !== syncedFrom) {
    const next = serialiseContent(content.data);
    setSyncedFrom(content.data);
    setDrafts(next);
    setOriginal(next);
    setErrors({});
  }

  const changed = changedBlobs(drafts, original);

  function attemptSave(): void {
    const nextErrors: Partial<Record<keyof PricingContent, string>> = {};
    for (const key of changed) {
      const parsed = parseBlob(drafts[key]);
      if (!parsed.ok) nextErrors[key] = parsed.error;
    }
    setErrors(nextErrors);
    setSaveError(null);
    if (Object.keys(nextErrors).length > 0) return;
    setConfirmOpen(true);
  }

  async function commit(): Promise<void> {
    const payload: Partial<Record<keyof PricingContent, JsonValue[]>> = {};
    for (const key of changed) {
      const parsed = parseBlob(drafts[key]);
      if (parsed.ok) payload[key] = parsed.value;
    }
    try {
      await platform.put('/pricing-content', payload);
      setConfirmOpen(false);
      toast.success('Pricing page copy published.');
      content.reload();
    } catch (error) {
      setConfirmOpen(false);
      setSaveError(error instanceof Error ? error.message : 'The copy could not be published.');
    }
  }

  if (content.forbidden) {
    return (
      <LockedState
        title="You cannot read the pricing page copy"
        description="Your super-admin account is not permitted to load this content. Nothing was published."
      />
    );
  }

  if (content.error && !content.data) {
    return (
      <Alert
        tone="danger"
        title="The pricing copy could not be loaded"
        action={
          <Button size="sm" onClick={content.reload}>
            Try again
          </Button>
        }
      >
        {content.error}
      </Alert>
    );
  }

  return (
    <Stack>
      <Alert tone="neutral" title="This is the public site, not the product">
        Nothing on this screen changes what a customer is charged or what they may do — that is the plan
        catalogue and the credit pricing. What it changes is what the pricing page says, live, with no
        staging step in between.
      </Alert>

      {saveError ? (
        <Alert tone="danger" live title="Nothing was published">
          {saveError}
        </Alert>
      ) : null}

      {content.loading && !content.data ? (
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      ) : (
        <Section
          title="Pricing page copy"
          description="Each blob is a JSON array. The shape of an item is defined by the marketing site, not by the API."
          actions={
            <Button variant="primary" size="sm" disabled={changed.length === 0} onClick={attemptSave}>
              {changed.length === 0
                ? 'No changes'
                : `Publish ${formatNumber(changed.length)} change${changed.length === 1 ? '' : 's'}`}
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            {CONTENT_BLOBS.map((blob) => {
              const parsed = parseBlob(drafts[blob.key]);
              return (
                <Card key={blob.key}>
                  <CardHeader
                    titleAs="h3"
                    title={blob.label}
                    description={blob.description}
                    actions={
                      <span className="figure text-2xs text-text-tertiary">
                        {parsed.ok ? `${formatNumber(parsed.value.length)} items` : 'does not parse'}
                      </span>
                    }
                  />
                  <CardBody>
                    <Field
                      label={`${blob.label} JSON`}
                      hideLabel
                      error={errors[blob.key]}
                      hint={`Sent only if it changes. At most ${MAX_PRICING_ITEMS} items.`}
                    >
                      <Textarea
                        rows={10}
                        className="figure"
                        spellCheck={false}
                        value={drafts[blob.key]}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [blob.key]: event.target.value }))
                        }
                      />
                    </Field>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        </Section>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Publish to the pricing page?"
        confirmLabel="Publish"
        onConfirm={commit}
        description={
          <>
            {changed.map((key) => CONTENT_BLOBS.find((blob) => blob.key === key)?.label ?? key).join(', ')}{' '}
            will be replaced wholesale on oyechats.com. Blobs you did not touch are not sent and stay as they
            are.
          </>
        }
      />
    </Stack>
  );
}
