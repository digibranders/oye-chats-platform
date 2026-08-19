import { describe, expect, it } from 'vitest';
import {
  domainOf,
  formatConfigValue,
  parseConfigValue,
  partitionConfig,
  specFor,
} from './pricing-keys';
import type { PricingConfigRow } from './types';

function row(key: string, value: PricingConfigRow['value']): PricingConfigRow {
  return { key, value, updated_at: null };
}

describe('which screen owns a pricing_config key', () => {
  it('routes the credit economics to the pricing screen', () => {
    expect(domainOf('credit_cost.ai_chat')).toBe('money');
    expect(domainOf('topup_packs')).toBe('money');
    expect(domainOf('low_balance_warn_pct')).toBe('money');
  });

  it('routes the switches away from the pricing screen', () => {
    expect(domainOf('kill_switch')).toBe('switch');
    expect(domainOf('feature.company_name_enabled')).toBe('switch');
  });

  it('routes every model and RAG key to the runtime screen by prefix', () => {
    expect(domainOf('model.primary')).toBe('runtime');
    expect(domainOf('rag.chunk_overlap')).toBe('runtime');
    expect(domainOf('crawl.provider_primary')).toBe('runtime');
    expect(domainOf('embed.concurrency')).toBe('runtime');
    // Boolean, but with an environment floor this endpoint cannot see.
    expect(domainOf('impersonation.enabled')).toBe('runtime');
  });

  it('routes the marketing copy to the content editor', () => {
    expect(domainOf('pricing_faq')).toBe('content');
    expect(domainOf('pricing_topup_packs')).toBe('content');
  });

  it('calls anything else unknown rather than assuming', () => {
    expect(domainOf('something_new')).toBe('unknown');
  });

  it('keeps the charged pack list and the advertised one apart', () => {
    // Two different keys, and confusing them is how the site advertises a pack
    // the checkout will not sell.
    expect(domainOf('topup_packs')).toBe('money');
    expect(domainOf('pricing_topup_packs')).toBe('content');
  });
});

describe('partitioning the response', () => {
  const rows = [
    row('credit_cost.ai_chat', 1),
    row('kill_switch', false),
    row('rag.chunk_size', 1000),
    row('pricing_faq', []),
    row('mystery', { a: 1 }),
    row('credit_cost.url_scan', 5),
  ];

  it('splits by owner and orders the money keys as documented', () => {
    const parts = partitionConfig(rows);
    expect(parts.money.map((entry) => entry.key)).toEqual(['credit_cost.ai_chat', 'credit_cost.url_scan']);
    expect(parts.switches.map((entry) => entry.key)).toEqual(['kill_switch']);
    expect(parts.runtime.map((entry) => entry.key)).toEqual(['rag.chunk_size']);
    expect(parts.content.map((entry) => entry.key)).toEqual(['pricing_faq']);
    expect(parts.unknown.map((entry) => entry.key)).toEqual(['mystery']);
  });

  it('reports documented keys with no row, since a default is not the same as a value', () => {
    const parts = partitionConfig(rows);
    expect(parts.missingMoneyKeys.map((spec) => spec.key)).toContain('topup_expiry_months');
    expect(parts.missingMoneyKeys.map((spec) => spec.key)).not.toContain('credit_cost.ai_chat');
  });

  it('survives an empty database', () => {
    const parts = partitionConfig([]);
    expect(parts.money).toEqual([]);
    expect(parts.missingMoneyKeys.length).toBeGreaterThan(0);
  });
});

describe('specFor', () => {
  it('names what reads each documented key', () => {
    expect(specFor('kill_switch')?.readBy).toMatch(/credit_service/);
    expect(specFor('nope')).toBeUndefined();
  });
});

describe('formatting a stored value', () => {
  it('never shows a boolean as true or false', () => {
    expect(formatConfigValue(true)).toBe('On');
    expect(formatConfigValue(false)).toBe('Off');
  });

  it('summarises a list rather than dumping it into a table cell', () => {
    expect(formatConfigValue([1, 2, 3])).toBe('3 items');
    expect(formatConfigValue([1])).toBe('1 item');
  });

  it('renders absence as an em dash', () => {
    expect(formatConfigValue(null)).toBe('—');
  });
});

describe('parsing what the operator typed', () => {
  it('refuses a non-numeric value for a numeric key, which would fail closed downstream', () => {
    expect(parseConfigValue('integer', '1.5')).toEqual({ ok: false, error: expect.any(String) });
    expect(parseConfigValue('integer', 'free')).toEqual({ ok: false, error: expect.any(String) });
    expect(parseConfigValue('integer', '5')).toEqual({ ok: true, value: 5 });
  });

  it('refuses a negative credit cost', () => {
    expect(parseConfigValue('integer', '-1').ok).toBe(false);
  });

  it('takes only true or false for a boolean key', () => {
    expect(parseConfigValue('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(parseConfigValue('boolean', 'false')).toEqual({ ok: true, value: false });
    expect(parseConfigValue('boolean', 'yes').ok).toBe(false);
  });

  it('parses JSON for a structured key and reports the parse error', () => {
    expect(parseConfigValue('json', '[{"inr":1000}]')).toEqual({ ok: true, value: [{ inr: 1000 }] });
    expect(parseConfigValue('json', '[{').ok).toBe(false);
  });
});
