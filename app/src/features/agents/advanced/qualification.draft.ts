import { draftsEqual } from './draftDiff';
import { isSupportedFramework } from './qualification.config';
import { type QualModel, parseModel, serializeModel } from './qualification.model';

/**
 * The Qualification page's draft, and the two payloads that persist it.
 *
 * Two payloads because the fields live behind two different concerns on one
 * endpoint: the metered enrichments are widget settings, while the scoring
 * model is a rubric that is interpolated into the LLM prompt on every turn. They
 * are sent separately so that saving an enrichment toggle never rewrites a
 * `bant_config` the customer did not open — the previous page PATCHed both on
 * every save, which is how an unrelated edit can overwrite a rubric another
 * session changed.
 */
export interface QualificationDraft {
  /** `Bot.bant_enabled` — the master switch. Scoring is skipped entirely when off. */
  enabled: boolean;
  /** `bant` or `meddic`. Anything else is not writable; see FRAMEWORK_OPTIONS. */
  framework: string;
  /** The typed view of `Bot.bant_config`. */
  model: QualModel;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The dimension keys the server's own preset owns, and which therefore cannot be
 * deleted.
 *
 * `get_framework_config` deep-merges the preset *under* the stored config, so a
 * preset dimension removed from `bant_config` comes straight back at scoring
 * time. Disabling it is the only removal that takes effect, and the editor has
 * to know which keys those are in order to say so.
 */
export function presetKeysFor(presets: Record<string, unknown>, framework: string): string[] {
  const preset = presets[framework];
  if (!isRecord(preset)) return [];
  return parseModel(preset, framework).order;
}

/**
 * Narrow `GET /bots/{id}` into a Qualification draft.
 *
 * `presets` is the server's framework catalog, used to seed a bot that has a
 * framework but no config of its own.
 */
export function parseQualification(
  raw: Record<string, unknown>,
  presets: Record<string, unknown>,
): QualificationDraft {
  const config = isRecord(raw.bant_config) ? raw.bant_config : null;
  // The column and the config both carry a framework. `get_framework_config`
  // reads the CONFIG's copy, so that is the one that decides how a live
  // conversation is scored, and it wins here too.
  const stored =
    (typeof config?.framework === 'string' ? config.framework : null) ??
    (typeof raw.qualification_framework === 'string' ? raw.qualification_framework : null);
  const framework = stored && isSupportedFramework(stored) ? stored : 'bant';
  const preset = isRecord(presets[framework]) ? (presets[framework] as Record<string, unknown>) : null;

  return {
    // `!== false`: the column defaults ON, so an absent field on an older API
    // build reads as ON rather than silently disabling a customer's live scoring.
    enabled: raw.bant_enabled !== false,
    framework,
    model: parseModel(config, framework, preset),
  };
}

/** The `PATCH /bots/{id}` body for the scoring rubric. */
export function toScoringPayload(draft: QualificationDraft): Record<string, unknown> {
  return {
    bant_enabled: draft.enabled,
    qualification_framework: draft.framework,
    // The framework is restated inside the config because the server stores the
    // config wholesale and `get_framework_config` reads the framework from it.
    bant_config: { ...serializeModel(draft.model), framework: draft.framework },
  };
}

/** True when the rubric slice differs, so a save can skip the heavier PATCH. */
export function scoringChanged(draft: QualificationDraft, initial: QualificationDraft): boolean {
  return (
    draft.enabled !== initial.enabled ||
    draft.framework !== initial.framework ||
    !draftsEqual(draft.model, initial.model)
  );
}

