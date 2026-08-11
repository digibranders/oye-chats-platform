import { describe, expect, it } from 'vitest';
import { UPGRADE_INTENTS } from './upgradeIntents';

/**
 * The upgrade registry is static copy with no access to a workspace's credit
 * ledger and no endpoint exposing `pricing_config.topup_expiry_months`, so it
 * cannot honestly promise anything about top-up expiry. Whether top-ups expire
 * is a term of sale; this pins the registry to claims that hold on every
 * database, whatever that config row says.
 */
describe('topup_credits upgrade intent', () => {
  it('makes no expiry promise it cannot evidence', () => {
    const intent = UPGRADE_INTENTS.topup_credits();
    const copy = [intent.eyebrow, intent.title, intent.description, ...intent.highlights].join(' ');

    expect(copy).not.toMatch(/expire/i);
    expect(copy).not.toMatch(/roll ?over/i);
  });

  it('still sells the top-up value proposition', () => {
    const intent = UPGRADE_INTENTS.topup_credits();

    expect(intent.description).toMatch(/one-time/i);
    expect(intent.highlights.length).toBeGreaterThanOrEqual(3);
  });
});
