import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Loader2, MessageCircle, Sparkles, Volume2, Wand2 } from 'lucide-react';
import { Button, Input, SectionHeader } from '../../../design-system';
import { detectBrandTone, getBrandTonePresets, previewChatStream } from '../../../services/api';
import { type ExperienceDraft, FIELD_LIMITS } from './types';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

export interface PersonalitySectionProps {
  draft: ExperienceDraft;
  onChange: (patch: Partial<ExperienceDraft>) => void;
  /** The active agent's id, or null while it resolves. Gates the AI-assist calls. */
  botId: number | null;
  /** True once the site has been crawled - brand-tone detection needs that content. */
  canDetect: boolean;
  /**
   * Commit server-persisted values into BOTH the draft and its baseline. Used
   * after "Detect from website", which writes the tone server-side, so the field
   * updates without falsely reading as an unsaved change.
   */
  onServerApply: (patch: Partial<ExperienceDraft>) => void;
}

/** A single selectable brand-tone preset, normalised from the loose API payload. */
interface TonePreset {
  key: string;
  label: string;
  text: string;
}

/** The marker the tone field carries once its text diverges from every preset. */
const CUSTOM_PRESET = 'custom';

/**
 * A neutral question used to stream a representative sample reply.
 *
 * i18n-exempt: this is SENT to the model, not rendered as chrome. The preview
 * exists to show what the tone settings do; asking in the dashboard's language
 * would change the answer's language too and confound the thing being previewed.
 */
const SAMPLE_QUESTION = 'What can you help me with?';

/** Narrow one loose preset record into a usable {key,label,text}, or null. */
function toPreset(raw: Record<string, unknown>): TonePreset | null {
  const key = typeof raw.key === 'string' ? raw.key : null;
  const text = typeof raw.text === 'string' ? raw.text : null;
  if (!key || !text) return null;
  const label = typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : key;
  return { key, label, text };
}

/** Labelled multi-line field with a live character counter capped at `maxLength`. */
function TextAreaField({
  label,
  hint,
  value,
  maxLength,
  rows,
  placeholder,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  value: string;
  maxLength: number;
  rows: number;
  placeholder: string;
  onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  const hintId = useId();
  const counterId = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--ds-text)]">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-describedby={`${hintId} ${counterId}`}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2.5 text-sm text-[var(--ds-text)] outline-none transition-colors placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      />
      <div className="flex items-center justify-between gap-3">
        <p id={hintId} className="text-[11px] text-[var(--ds-text-subtle)]">
          {hint}
        </p>
        <span
          id={counterId}
          className="shrink-0 text-[11px] tabular-nums text-[var(--ds-text-subtle)]"
        >
          {value.length}/{maxLength}
        </span>
      </div>
    </div>
  );
}

/**
 * PersonalitySection - how the agent sounds and what it knows about the
 * business: a custom system prompt, brand voice, and company identity. These
 * shape every answer a visitor reads. Bind to the same `Bot` fields the shipped
 * personality editor uses, with the backend length caps enforced client-side.
 *
 * The brand-voice block adds the AI assists that were dropped in the rebuild:
 * one-tap presets, "Detect from website" (infers the tone from crawled content
 * and persists it), and a streamed sample reply so the user can hear the voice.
 */
export function PersonalitySection({
  draft,
  onChange,
  botId,
  canDetect,
  onServerApply,
}: PersonalitySectionProps): ReactElement {
  const { t } = useTranslation();
  const companyId = useId();
  const companyHintId = useId();

  const [presets, setPresets] = useState<TonePreset[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectNote, setDetectNote] = useState<string | null>(null);

  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sampleReply, setSampleReply] = useState('');

  // Tracks the agent the in-flight assist calls belong to, so a stream or detect
  // that resolves after an agent switch can't write onto the new agent.
  const botIdRef = useRef(botId);
  botIdRef.current = botId;

  // Load the selectable presets once. Failure is non-fatal - the free-text tone
  // field and detection still work, so we simply render no chips.
  useEffect(() => {
    let cancelled = false;
    getBrandTonePresets()
      .then((raw) => {
        if (cancelled) return;
        setPresets(raw.map(toPreset).filter((p): p is TonePreset => p !== null));
      })
      .catch(() => {
        /* Non-fatal: chips are an enhancement, not a requirement. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectPreset = useCallback(
    (preset: TonePreset): void => {
      setDetectError(null);
      setDetectNote(null);
      onChange({ brandTone: preset.text, brandTonePreset: preset.key });
    },
    [onChange],
  );

  const onToneTextChange = useCallback(
    (value: string): void => {
      setDetectNote(null);
      const matched = presets.find((p) => p.text === value);
      const nextPreset = value.trim() === '' ? null : matched ? matched.key : CUSTOM_PRESET;
      onChange({ brandTone: value, brandTonePreset: nextPreset });
    },
    [onChange, presets],
  );

  const handleDetect = useCallback(async (): Promise<void> => {
    if (botId === null || detecting) return;
    const requestBotId = botId;
    setDetecting(true);
    setDetectError(null);
    setDetectNote(null);
    try {
      const result = await detectBrandTone(requestBotId);
      if (botIdRef.current !== requestBotId) return;
      const tone = typeof result.brand_tone === 'string' ? result.brand_tone : '';
      const preset = typeof result.brand_tone_preset === 'string' ? result.brand_tone_preset : null;
      onServerApply({ brandTone: tone, brandTonePreset: preset });
      setDetectNote(translateNow('agents.toneDetectedFromYourWebsite') || 'Tone detected from your website and saved.');
    } catch (err) {
      if (botIdRef.current !== requestBotId) return;
      setDetectError(err instanceof Error ? err.message : translateNow('agents.couldNotDetectATone') || 'Could not detect a tone. Please try again.');
    } finally {
      if (botIdRef.current === requestBotId) setDetecting(false);
    }
  }, [botId, detecting, onServerApply]);

  const handlePreview = useCallback(async (): Promise<void> => {
    if (botId === null || previewing) return;
    const requestBotId = botId;
    setPreviewing(true);
    setPreviewError(null);
    setSampleReply('');
    try {
      await previewChatStream(requestBotId, SAMPLE_QUESTION, null, {
        onChunk: (text) => {
          if (botIdRef.current !== requestBotId) return;
          setSampleReply((prev) => prev + text);
        },
        onError: (streamErr) => {
          if (botIdRef.current !== requestBotId) return;
          setPreviewError(
            streamErr instanceof Error ? streamErr.message : translateNow('agents.couldNotGenerateASample') || 'Could not generate a sample reply.',
          );
        },
      });
    } catch (err) {
      if (botIdRef.current !== requestBotId) return;
      setPreviewError(err instanceof Error ? err.message : translateNow('agents.couldNotGenerateASample') || 'Could not generate a sample reply.');
    } finally {
      if (botIdRef.current === requestBotId) setPreviewing(false);
    }
  }, [botId, previewing]);

  const detectDisabled = detecting || botId === null || !canDetect;

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SectionHeader
          title={t('agents.systemPrompt') || 'System prompt'}
          description="Custom instructions that steer every reply. Leave blank to use the platform default."
        />
        <TextAreaField
          label={t('agents.customInstructions') || 'Custom instructions'}
          hint="Layered on top of your knowledge base to guide the chatbot's behaviour."
          value={draft.systemPrompt}
          maxLength={FIELD_LIMITS.systemPrompt}
          rows={6}
          placeholder={t('agents.eGYouAreA') || 'e.g. You are a friendly support assistant for Acme Inc. Be concise and offer to connect visitors to a human when unsure.'}
          onChange={(v) => onChange({ systemPrompt: v })}
        />
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title={t('agents.brandVoice') || 'Brand voice'}
          description="Describe the tone your chatbot should match. Visitors feel this in every message."
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={handleDetect}
              disabled={detectDisabled}
              title={
                canDetect
                  ? t('agents.inferABrandToneFrom') || 'Infer a brand tone from your trained website'
                  : t('agents.trainOnYourWebsiteFirst') || 'Train on your website first to detect a tone'
              }
            >
              {detecting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {detecting ? 'Detecting…' : t('agents.detectFromWebsite') || 'Detect from website'}
            </Button>
          }
        />

        {presets.length > 0 && (
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-[var(--ds-text)]">{t('agents.tonePresets') || 'Tone presets'}</p>
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => {
                const active = draft.brandTonePreset === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-pressed={active}
                    title={preset.text}
                    onClick={() => selectPreset(preset)}
                    className={
                      active
                        ? 'rounded-full border border-[var(--ds-accent)] bg-[var(--ds-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-accent-fg)] transition-colors'
                        : 'rounded-full border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:border-[var(--ds-accent)] hover:text-[var(--ds-text)]'
                    }
                  >
                    {preset.label}
                  </button>
                );
              })}
              {draft.brandTonePreset === CUSTOM_PRESET && (
                <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--ds-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                  <Wand2 size={12} aria-hidden="true" />
                  {t('agents.custom') || 'Custom'}
                </span>
              )}
            </div>
          </div>
        )}

        <TextAreaField
          label={t('agents.voiceTone') || 'Voice & tone'}
          hint="e.g. Warm and approachable, with a touch of humour. Avoid jargon."
          value={draft.brandTone}
          maxLength={FIELD_LIMITS.brandTone}
          rows={3}
          placeholder={t('agents.warmAndApproachableWithA') || 'Warm and approachable, with a touch of humour. Avoid jargon.'}
          onChange={onToneTextChange}
        />

        {detectError && (
          <p role="alert" className="text-[12px] text-[var(--ds-danger)]">
            {detectError}
          </p>
        )}
        {detectNote && !detectError && (
          <p role="status" className="text-[12px] text-[var(--ds-text-muted)]">
            {detectNote}
          </p>
        )}

        <div className="space-y-2 border-t border-[var(--ds-border)] pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreview}
            disabled={previewing || botId === null}
          >
            {previewing ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}
            {previewing ? 'Generating…' : t('agents.previewASampleReply') || 'Preview a sample reply'}
          </Button>
          {sampleReply && (
            <div className="flex items-start gap-2">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-accent)]"
                aria-hidden="true"
              >
                <MessageCircle size={13} />
              </span>
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--ds-bg-sunken)] px-3 py-2 text-[13px] text-[var(--ds-text)]">
                {sampleReply}
              </div>
            </div>
          )}
          {previewError && (
            <p role="alert" className="text-[12px] text-[var(--ds-danger)]">
              {previewError}
            </p>
          )}
          <p className="text-[11px] text-[var(--ds-text-subtle)]">
            {t('agents.streamsARealAnswer') ||
              'Streams a real answer using your chatbot’s saved settings - save your voice changes first to hear them here.'}
          </p>
        </div>
      </section>

      <section className="space-y-4 border-t border-[var(--ds-border)] pt-6">
        <SectionHeader
          title={t('agents.companyDetails') || 'Company details'}
          description="Context the chatbot uses to describe your business accurately."
        />
        <div className="space-y-1.5">
          <label htmlFor={companyId} className="block text-[13px] font-medium text-[var(--ds-text)]">
            {t('agents.companyName') || 'Company name'}
          </label>
          <Input
            id={companyId}
            value={draft.companyName}
            maxLength={FIELD_LIMITS.companyName}
            placeholder={t('agents.eGAcmeInc') || 'e.g. Acme Inc.'}
            aria-describedby={companyHintId}
            onChange={(e) => onChange({ companyName: e.target.value })}
          />
          <p id={companyHintId} className="text-[11px] text-[var(--ds-text-subtle)]">
            {t('agents.theNameOfYourBusiness') || 'The name of your business or brand.'}
          </p>
        </div>
        <TextAreaField
          label={t('agents.companyDescription') || 'Company description'}
          hint="A short summary of what your company does."
          value={draft.companyDescription}
          maxLength={FIELD_LIMITS.companyDescription}
          rows={4}
          placeholder={t('agents.eGAcmeIncBuilds') || 'e.g. Acme Inc. builds project-management software for remote teams.'}
          onChange={(v) => onChange({ companyDescription: v })}
        />
      </section>
    </div>
  );
}
