/**
 * Typed access to the endpoints this surface uses.
 *
 * The shared client answers most of these as `Record<string, unknown>`, so
 * narrowing happens once, here, and the components downstream only ever see a
 * strict shape. It is also the single place that knows which failures are
 * refusals rather than faults — a 403 needs a different screen from "this did
 * not load", which is the whole point of shipping four states.
 */

import {
  detectBrandTone,
  getBrandTonePresets,
  getSeedQuestions,
  previewBrandTone,
  refreshSeedQuestions,
  uploadLogo,
} from '../../../services/api';

export interface ApiErrorShape {
  status?: number;
  message?: string;
  detail?: { error?: string; feature?: string; message?: string } | string | null;
}

export function asApiError(cause: unknown): ApiErrorShape {
  return cause !== null && typeof cause === 'object' ? (cause as ApiErrorShape) : {};
}

export function errorMessage(cause: unknown, fallback: string): string {
  const message = asApiError(cause).message;
  if (typeof message === 'string' && message.length > 0) return message;
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * True when the server refused rather than failed.
 *
 * An operator seat that may work a chatbot's inbox but not reconfigure it, and
 * a chatbot id belonging to another workspace, both answer 403 here — see
 * `_require_bot_management_access` and `_get_workspace_bot` in `bot_routes.py`.
 */
export function isForbidden(cause: unknown): boolean {
  return asApiError(cause).status === 403;
}

// ── Brand tone ───────────────────────────────────────────────────────────────

export interface TonePreset {
  key: string;
  label: string;
  text: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function fetchTonePresets(): Promise<TonePreset[]> {
  const raw = await getBrandTonePresets();
  return raw
    .map((entry): TonePreset | null => {
      const key = asString(entry.key);
      const text = asString(entry.text);
      if (!key || !text) return null;
      return { key, label: asString(entry.label) ?? key, text };
    })
    .filter((preset): preset is TonePreset => preset !== null);
}

export interface DetectedTone {
  brandTone: string;
  brandTonePreset: string | null;
}

/**
 * Infer a tone from the chatbot's already-crawled content.
 *
 * This one **writes**: the endpoint persists what it detects before answering
 * (`bot_routes.py` `detect_brand_tone`). The caller must therefore commit the
 * result to the baseline as well as the draft, or the page reports a change the
 * user did not make and cannot discard.
 */
export async function detectTone(botId: number): Promise<DetectedTone> {
  const raw = await detectBrandTone(botId);
  return {
    brandTone: asString(raw.brand_tone) ?? '',
    brandTonePreset: asString(raw.brand_tone_preset),
  };
}

/**
 * A sample reply in a tone that has not been saved.
 *
 * The distinction from `previewChatStream` is the whole reason this exists:
 * that one answers from the chatbot's stored record, so it cannot be used to
 * hear an edit before committing it. This one takes the draft text directly and
 * never touches the database.
 */
export async function sampleTone(botId: number, brandTone: string): Promise<string> {
  const raw = await previewBrandTone(botId, brandTone);
  return asString(raw.sample) ?? '';
}

// ── Suggested questions ──────────────────────────────────────────────────────

/**
 * Questions the chatbot can demonstrably answer, proposed from its own content.
 *
 * `regenerate` maps to the endpoint's `force` flag. Without it the server
 * returns the set it cached the first time it was asked, for the life of the
 * chatbot — which is why the questions could be set once and never changed.
 */
export async function fetchSuggestedQuestions(
  botId: number,
  regenerate: boolean,
): Promise<string[]> {
  return regenerate ? refreshSeedQuestions(botId) : getSeedQuestions(botId);
}

// ── Avatar ───────────────────────────────────────────────────────────────────

export async function uploadAvatar(file: File): Promise<string> {
  const { url } = await uploadLogo(file);
  return url;
}
