import { describe, expect, it } from 'vitest';
import {
  enrichmentChanged,
  parseQualification,
  scoringChanged,
  toEnrichmentPayload,
  toScoringPayload,
} from './qualification.draft';
import { FRAMEWORK_OPTIONS, isSupportedFramework } from './qualification.config';

const NO_PRESETS: Record<string, unknown> = {};

describe('parseQualification', () => {
  it('reads an absent bant_enabled as ON, matching the column default', () => {
    /* `!== false`. The column defaults true, so an older API build that omits
       the field must not read as "scoring switched off" — that would show a
       paying customer a disabled surface for a chatbot that is scoring fine. */
    expect(parseQualification({}, NO_PRESETS).enabled).toBe(true);
    expect(parseQualification({ bant_enabled: false }, NO_PRESETS).enabled).toBe(false);
  });

  it('reads absent enrichment flags as OFF, matching those column defaults', () => {
    /* `=== true`, the opposite rule, for the opposite reason: enrichment spends
       credits, so an absent field must never read as opted in. */
    const draft = parseQualification({}, NO_PRESETS);
    expect(draft.emailVerificationEnabled).toBe(false);
    expect(draft.companyLookupEnabled).toBe(false);
  });

  it('prefers the framework inside bant_config, which is the one that scores', () => {
    /* `get_framework_config` reads `bant_config.framework`, not the column, so
       when the two disagree the config wins at scoring time and must win here. */
    const draft = parseQualification(
      { qualification_framework: 'bant', bant_config: { framework: 'meddic' } },
      NO_PRESETS,
    );
    expect(draft.framework).toBe('meddic');
  });

  it('falls back to BANT for a framework the API cannot store', () => {
    /* `UpdateBotRequest.qualification_framework` is Literal["bant","meddic"] and
       `_framework_name` falls anything else back to BANT, so a legacy "champ"
       value is being scored as BANT already. Showing it as CHAMP would be a lie
       and saving it would 422. */
    const draft = parseQualification({ qualification_framework: 'champ' }, NO_PRESETS);
    expect(draft.framework).toBe('bant');
  });
});

describe('the framework catalog', () => {
  it('offers only the two values the API accepts', () => {
    expect(FRAMEWORK_OPTIONS.map((option) => option.key)).toEqual(['bant', 'meddic']);
    expect(isSupportedFramework('champ')).toBe(false);
    expect(isSupportedFramework('custom')).toBe(false);
  });
});

describe('payloads', () => {
  const base = parseQualification({}, NO_PRESETS);

  it('sends both enrichment toggles, matching the draft', () => {
    /* A review once deleted `company_lookup_enabled` from the old inline save
       literal with every test still green — and the next save would then have
       PATCHed a paying customer's enrichment to false. */
    const payload = toEnrichmentPayload({
      ...base,
      emailVerificationEnabled: false,
      companyLookupEnabled: true,
    });
    expect(payload).toEqual({ email_verification_enabled: false, company_lookup_enabled: true });
  });

  it('restates the framework inside bant_config, because the server reads it there', () => {
    const payload = toScoringPayload({ ...base, framework: 'meddic' });
    expect(payload.qualification_framework).toBe('meddic');
    expect((payload.bant_config as Record<string, unknown>).framework).toBe('meddic');
  });

  it('never sends the enrichment flags in the scoring payload', () => {
    const payload = toScoringPayload(base);
    expect(payload).not.toHaveProperty('email_verification_enabled');
    expect(payload).not.toHaveProperty('company_lookup_enabled');
  });
});

describe('change detection', () => {
  const base = parseQualification({}, NO_PRESETS);

  it('does not call a rubric change an enrichment change, or the reverse', () => {
    /* The two halves go in separate PATCHes so that saving a switch never
       rewrites a rubric another session may have edited. */
    const enriched = { ...base, companyLookupEnabled: true };
    expect(enrichmentChanged(enriched, base)).toBe(true);
    expect(scoringChanged(enriched, base)).toBe(false);

    const rescored = { ...base, framework: 'meddic' };
    expect(scoringChanged(rescored, base)).toBe(true);
    expect(enrichmentChanged(rescored, base)).toBe(false);
  });

  it('sees a change inside the scoring model', () => {
    const next = {
      ...base,
      model: {
        ...base.model,
        thresholds: { ...base.model.thresholds, sql: 90 },
      },
    };
    expect(scoringChanged(next, base)).toBe(true);
  });

  it('reports no change for an identical draft', () => {
    expect(scoringChanged(parseQualification({}, NO_PRESETS), base)).toBe(false);
    expect(enrichmentChanged(parseQualification({}, NO_PRESETS), base)).toBe(false);
  });
});
