import { describe, expect, it } from 'vitest';
import { describeFlagChange, flagSpec, isDangerousChange, partitionFlags } from './flags-model';
import type { ConfigRow } from './types';

function row(key: string, value: ConfigRow['value']): ConfigRow {
  return { key, value, updated_at: null };
}

describe('partitioning the flags response', () => {
  // The endpoint is `list_pricing_config` under another name, so this is what
  // actually comes back.
  const rows = [
    row('kill_switch', false),
    row('feature.company_name_enabled', true),
    row('credit_cost.ai_chat', 1),
    row('rag.chunk_size', 1000),
    row('model.primary', 'openai/gpt-5.4-mini'),
    row('pricing_faq', []),
    row('some_new_switch', true),
    row('impersonation.enabled', true),
  ];

  it('keeps only the boolean switches', () => {
    const parts = partitionFlags(rows);
    expect(parts.known.map((entry) => entry.key)).toEqual(['kill_switch', 'feature.company_name_enabled']);
  });

  it('shows an undocumented boolean rather than hiding it', () => {
    expect(partitionFlags(rows).undocumented.map((entry) => entry.key)).toEqual(['some_new_switch']);
  });

  it('leaves impersonation to the runtime screen, which can see the environment floor', () => {
    const parts = partitionFlags(rows);
    expect(parts.known.map((entry) => entry.key)).not.toContain('impersonation.enabled');
    expect(parts.undocumented.map((entry) => entry.key)).not.toContain('impersonation.enabled');
    expect(parts.elsewhere.runtime).toBe(3);
  });

  it('counts what it is not showing, so the screen can say where it went', () => {
    const parts = partitionFlags(rows);
    expect(parts.elsewhere.pricing).toBe(1);
    expect(parts.elsewhere.content).toBe(1);
  });

  it('reports a documented switch with no row at all', () => {
    const parts = partitionFlags([row('kill_switch', true)]);
    expect(parts.missing.map((spec) => spec.key)).toEqual([
      'feature.email_verification_enabled',
      'feature.company_name_enabled',
    ]);
  });

  it('survives an empty store', () => {
    const parts = partitionFlags([]);
    expect(parts.known).toEqual([]);
    expect(parts.missing).toHaveLength(3);
  });
});

describe('which direction is destructive', () => {
  it('treats turning the kill switch ON as the dangerous move', () => {
    const spec = flagSpec('kill_switch');
    expect(isDangerousChange(spec, true)).toBe(true);
    expect(isDangerousChange(spec, false)).toBe(false);
  });

  it('treats turning a metered feature OFF as the dangerous move', () => {
    const spec = flagSpec('feature.company_name_enabled');
    expect(isDangerousChange(spec, false)).toBe(true);
    expect(isDangerousChange(spec, true)).toBe(false);
  });

  it('treats an unknown flag as dangerous in both directions', () => {
    expect(isDangerousChange(undefined, true)).toBe(true);
    expect(isDangerousChange(undefined, false)).toBe(true);
  });
});

describe('the sentence in the confirm', () => {
  it('states the consequence of the direction being taken', () => {
    const spec = flagSpec('kill_switch');
    expect(describeFlagChange(spec, 'kill_switch', true)).toMatch(/stops|raises/i);
    expect(describeFlagChange(spec, 'kill_switch', false)).toMatch(/normally/i);
  });

  it('admits ignorance for an undocumented flag rather than inventing a consequence', () => {
    expect(describeFlagChange(undefined, 'mystery', true)).toMatch(/nothing in this console knows/i);
  });
});
