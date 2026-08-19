import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { MessageSquareQuote, Plus, Sparkles, Trash2, Volume2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Textarea,
  Tooltip,
  cn,
} from '../../../ui';
import { detectTone, errorMessage, fetchTonePresets, sampleTone, type TonePreset } from './experience-api';
import {
  LIMITS,
  type DraftErrors,
  type ExperienceDraft,
  type ExperienceMeta,
  type ServiceEntry,
  type SmartLink,
} from './experience-model';

/**
 * How the chatbot sounds, and what it is allowed to sound off about.
 *
 * The tone controls are three different things and the page keeps them apart,
 * because conflating them is what left a dead endpoint in the client:
 *
 * - **Detect** reads the crawled site and *writes* the tone it infers, so its
 *   result is committed to the baseline and is not an unsaved edit.
 * - **Hear it** takes the tone currently in the box — unsaved — and returns a
 *   sample sentence written in it. This is `POST /bots/{id}/brand-tone/preview`,
 *   which shipped in the API client with no caller at all: the page instead
 *   streamed a real reply from the *saved* record and told the user to save
 *   first, which is the one thing a preview is supposed to save you from.
 * - The **preview panel's** conversation is a real answer from the saved
 *   chatbot, and says so when the draft has moved on.
 */

/** The marker the tone field carries once its text matches no preset. */
const CUSTOM_PRESET = 'custom';

export interface VoiceSectionProps {
  draft: ExperienceDraft;
  meta: ExperienceMeta;
  errors: DraftErrors;
  agentId: number | null;
  readOnly: boolean;
  onChange: (patch: Partial<ExperienceDraft>) => void;
  /** Commit a value the server has already stored, without it reading as an edit. */
  onServerCommit: (patch: Partial<ExperienceDraft>) => void;
}

export function VoiceSection({
  draft,
  meta,
  errors,
  agentId,
  readOnly,
  onChange,
  onServerCommit,
}: VoiceSectionProps): ReactElement {
  const [presets, setPresets] = useState<TonePreset[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detected, setDetected] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [sample, setSample] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  // Presets are an enhancement: the free-text field and detection both work
  // without them, so a failure renders no chips rather than an error.
  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      try {
        const loaded = await fetchTonePresets();
        if (active) setPresets(loaded);
      } catch {
        /* Chips are optional. */
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const onToneText = useCallback(
    (value: string): void => {
      setDetected(false);
      const matched = presets.find((preset) => preset.text === value);
      onChange({
        brandTone: value,
        brandTonePreset: value.trim() === '' ? null : (matched?.key ?? CUSTOM_PRESET),
      });
    },
    [onChange, presets],
  );

  const detect = useCallback(async (): Promise<void> => {
    if (agentId === null || detecting) return;
    setDetecting(true);
    setDetectError(null);
    setSample(null);
    try {
      const result = await detectTone(agentId);
      onServerCommit({ brandTone: result.brandTone, brandTonePreset: result.brandTonePreset });
      setDetected(true);
    } catch (cause) {
      setDetectError(errorMessage(cause, 'We could not read a tone from your website.'));
    } finally {
      setDetecting(false);
    }
  }, [agentId, detecting, onServerCommit]);

  const hear = useCallback(async (): Promise<void> => {
    if (agentId === null || sampling) return;
    setSampling(true);
    setSampleError(null);
    setSample(null);
    try {
      const text = await sampleTone(agentId, draft.brandTone);
      setSample(text || 'The chatbot did not have anything to say in that tone.');
    } catch (cause) {
      setSampleError(errorMessage(cause, 'We could not write a sample just now.'));
    } finally {
      setSampling(false);
    }
  }, [agentId, sampling, draft.brandTone]);

  const updateService = (index: number, patch: Partial<ServiceEntry>): void => {
    onChange({
      services: draft.services.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  };
  const updateLink = (index: number, patch: Partial<SmartLink>): void => {
    onChange({
      smartLinks: draft.smartLinks.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          eyebrow="Instructions"
          titleAs="h2"
          title="How it should behave"
          description="Layered on top of everything the chatbot has read. Leave it empty to use the platform's default behaviour."
        />
        <CardBody>
          <Field
            label="Custom instructions"
            hint={`Up to ${LIMITS.systemPrompt} characters — ${draft.systemPrompt.length} used.`}
          >
            <Textarea
              rows={6}
              value={draft.systemPrompt}
              maxLength={LIMITS.systemPrompt}
              disabled={readOnly}
              placeholder="You are a support assistant for Acme. Be concise, and offer to connect the visitor to a person when you are unsure."
              onChange={(event) => onChange({ systemPrompt: event.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Voice"
          titleAs="h2"
          title="How it should sound"
          description="Visitors feel this in every sentence. Describe the tone, or start from a preset."
          actions={
            <Tooltip
              content={
                meta.trained
                  ? 'Read your website and infer a tone from it'
                  : 'Train this chatbot on your website first — detection reads what it has crawled'
              }
            >
              <Button
                variant="secondary"
                size="sm"
                loading={detecting}
                disabled={readOnly || agentId === null || !meta.trained}
                iconLeft={<Sparkles aria-hidden className="h-3.5 w-3.5" />}
                onClick={() => void detect()}
              >
                Detect from my site
              </Button>
            </Tooltip>
          }
        />
        <CardBody className="flex flex-col gap-4">
          {presets.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Tone presets">
              {presets.map((preset) => {
                const active = draft.brandTonePreset === preset.key;
                return (
                  <li key={preset.key}>
                    <button
                      type="button"
                      disabled={readOnly}
                      aria-pressed={active}
                      onClick={() => {
                        setDetected(false);
                        onChange({ brandTone: preset.text, brandTonePreset: preset.key });
                      }}
                      className={cn(
                        'rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--dur-fast)]',
                        active
                          ? 'border-ink bg-ink text-text-inverse'
                          : 'border-border-strong bg-surface text-text-primary hover:bg-surface-hover',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      {preset.label}
                    </button>
                  </li>
                );
              })}
              {draft.brandTonePreset === CUSTOM_PRESET ? (
                <li>
                  <Badge tone="neutral">Custom</Badge>
                </li>
              ) : null}
            </ul>
          ) : null}

          <Field
            label="Voice and tone"
            hint="Two or three sentences is plenty. Say what to avoid as well as what to aim for."
          >
            <Textarea
              rows={3}
              value={draft.brandTone}
              maxLength={LIMITS.brandTone}
              disabled={readOnly}
              placeholder="Warm and direct, with no jargon. Never oversell — say when you do not know."
              onChange={(event) => onToneText(event.target.value)}
            />
          </Field>

          {detectError ? (
            <Alert tone="danger" title="Detection did not work" live>
              {detectError}
            </Alert>
          ) : null}
          {detected && !detectError ? (
            <Alert tone="success" live>
              Read from your website and saved. It is already in effect.
            </Alert>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={sampling}
                disabled={readOnly || agentId === null || draft.brandTone.trim().length === 0}
                iconLeft={<Volume2 aria-hidden className="h-3.5 w-3.5" />}
                onClick={() => void hear()}
              >
                Hear this voice
              </Button>
              <span className="text-xs text-text-secondary">
                Writes one sample sentence in the tone above — including the part you have not saved
                yet.
              </span>
            </div>
            {sample ? (
              <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2.5 text-prose text-text-primary">
                <MessageSquareQuote aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
                <span>{sample}</span>
              </p>
            ) : null}
            {sampleError ? (
              <Alert tone="danger" title="No sample this time" live>
                {sampleError}
              </Alert>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Business"
          titleAs="h2"
          title="Who the chatbot says you are"
          description="Used whenever a visitor asks what you do. Filled in from your website while training, and yours to correct."
        />
        <CardBody className="flex flex-col gap-5">
          <Field label="Company name" hint="Exactly as you want it written.">
            <Input
              value={draft.companyName}
              maxLength={LIMITS.companyName}
              disabled={readOnly}
              placeholder="Acme Inc."
              onChange={(event) => onChange({ companyName: event.target.value })}
              className="max-w-sm"
            />
          </Field>
          <Field label="What you do" hint="A couple of sentences, in your own words.">
            <Textarea
              rows={3}
              value={draft.companyDescription}
              maxLength={LIMITS.companyDescription}
              disabled={readOnly}
              placeholder="Acme builds project management software for remote teams."
              onChange={(event) => onChange({ companyDescription: event.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Scope"
          titleAs="h2"
          title="What it is allowed to talk about"
          description="List your services and the chatbot answers about those and nothing else. An empty list means it answers from everything it has read."
        />
        <CardBody className="flex flex-col gap-4">
          {draft.services.length === 0 ? (
            <p className="text-prose text-text-secondary">
              No list, so the chatbot answers about anything in its knowledge. Add services to hold
              it to them.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {draft.services.map((service, index) => (
                <li key={index} className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <Input
                      value={service.name}
                      maxLength={LIMITS.serviceName}
                      disabled={readOnly}
                      aria-label={`Service ${index + 1} name`}
                      placeholder="SEO audit"
                      onChange={(event) => updateService(index, { name: event.target.value })}
                      className="flex-1"
                    />
                    <Input
                      value={service.url}
                      disabled={readOnly}
                      spellCheck={false}
                      inputMode="url"
                      aria-label={`Service ${index + 1} link`}
                      placeholder="https://example.com/seo (optional)"
                      aria-invalid={errors[`services:${index}`] ? true : undefined}
                      onChange={(event) => updateService(index, { url: event.target.value })}
                      className="flex-1"
                    />
                    <Tooltip content="Remove">
                      <Button
                        variant="ghost"
                        size="icon-md"
                        disabled={readOnly}
                        aria-label={`Remove service ${index + 1}`}
                        onClick={() =>
                          onChange({ services: draft.services.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 aria-hidden className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  </div>
                  {errors[`services:${index}`] ? (
                    <p role="status" className="text-xs text-danger">
                      {errors[`services:${index}`]}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={readOnly || draft.services.length >= LIMITS.services}
              onClick={() => onChange({ services: [...draft.services, { name: '', url: '' }] })}
            >
              <Plus aria-hidden className="h-3.5 w-3.5" />
              Add a service
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Links"
          titleAs="h2"
          title="Words the chatbot turns into links"
          description="When an answer happens to mention the keyword, it becomes a link to the page you name. It never changes what the chatbot may answer."
        />
        <CardBody className="flex flex-col gap-4">
          {draft.smartLinks.length === 0 ? (
            <p className="text-prose text-text-secondary">
              None yet. Mapping “pricing” to your pricing page is the usual first one.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {draft.smartLinks.map((link, index) => (
                <li key={index} className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <Input
                      value={link.keyword}
                      maxLength={LIMITS.keyword}
                      disabled={readOnly}
                      aria-label={`Link ${index + 1} keyword`}
                      placeholder="pricing"
                      onChange={(event) => updateLink(index, { keyword: event.target.value })}
                      className="w-40 shrink-0"
                    />
                    <Input
                      value={link.url}
                      disabled={readOnly}
                      spellCheck={false}
                      inputMode="url"
                      aria-label={`Link ${index + 1} destination`}
                      placeholder="https://example.com/pricing"
                      aria-invalid={errors[`smartLinks:${index}`] ? true : undefined}
                      onChange={(event) => updateLink(index, { url: event.target.value })}
                      className="flex-1"
                    />
                    <Tooltip content="Remove">
                      <Button
                        variant="ghost"
                        size="icon-md"
                        disabled={readOnly}
                        aria-label={`Remove link ${index + 1}`}
                        onClick={() =>
                          onChange({ smartLinks: draft.smartLinks.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 aria-hidden className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  </div>
                  {errors[`smartLinks:${index}`] ? (
                    <p role="status" className="text-xs text-danger">
                      {errors[`smartLinks:${index}`]}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={readOnly || draft.smartLinks.length >= LIMITS.smartLinks}
              onClick={() =>
                onChange({ smartLinks: [...draft.smartLinks, { keyword: '', url: '' }] })
              }
            >
              <Plus aria-hidden className="h-3.5 w-3.5" />
              Add a link
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
