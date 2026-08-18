import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentCreditHero } from './AgentCreditHero';
import { BotCreditsSection } from './BotCreditsSection';
import {
  describeTopupExpiry,
  type CreditBalance,
  type PoolCredit,
  type UsageBuckets,
} from '../usage-model';

/**
 * "Top-up credits never expire" is a TERM OF SALE, true only when
 * `pricing_config.topup_expiry_months = 0`, a server value no endpoint
 * exposes. The only evidence the client holds is the customer's own ledger.
 *
 * These surfaces asserted it unconditionally, in different words ("Roll over",
 * "Top-ups roll over"), directly above a section that states a real expiry
 * date. A review mutated both lines back and the whole 166-test suite stayed
 * green, neither had any coverage at all, which is how one commit fixed the
 * bottom of a screen and left the top of it claiming the opposite.
 */

vi.mock('../../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal: vi.fn() }),
}));

const EMPTY_BUCKET = { creditsUsed: 0, eventCount: 0 };
const ACTIVITY: UsageBuckets = {
  aiChat: EMPTY_BUCKET,
  documentUpload: EMPTY_BUCKET,
  urlScan: EMPTY_BUCKET,
  emailSend: EMPTY_BUCKET,
  emailVerification: EMPTY_BUCKET,
  companyName: EMPTY_BUCKET,
};

function pool(overrides: Partial<PoolCredit> = {}): PoolCredit {
  return {
    botId: null,
    name: 'Shared credits',
    botKey: null,
    planName: null,
    monthlyGrant: 1000,
    planRemaining: 400,
    topupRemaining: 0,
    totalRemaining: 400,
    planUsedPct: 60,
    resetsAt: null,
    soonestExpiry: null,
    periodCreditsUsed: 600,
    activity: ACTIVITY,
    planLimits: null,
    limitUsage: null,
    ...overrides,
  };
}

describe('AgentCreditHero top-up expiry claim', () => {
  it('states the real date when a top-up grant is dated', () => {
    const { container } = render(
      <AgentCreditHero
        pool={pool({ topupRemaining: 500, soonestExpiry: '2026-11-30T00:00:00Z' })}
        agentName="All chatbots"
        onTopup={vi.fn()}
      />,
    );
    expect(container.textContent).toMatch(/Top-ups expire/i);
    expect(container.textContent).toMatch(/Nov 2026/);
    expect(container.textContent).not.toMatch(/never expire|roll over/i);
  });

  it('claims lifetime only when grants exist and none are dated', () => {
    const { container } = render(
      <AgentCreditHero
        pool={pool({ topupRemaining: 500, soonestExpiry: null })}
        agentName="All chatbots"
        onTopup={vi.fn()}
      />,
    );
    expect(container.textContent).toMatch(/Never expire/i);
  });

  it('says nothing about expiry with no grants and no evidence', () => {
    /* The case the shared rule deliberately refuses to speak about. An
       unbacked guarantee is the defect; inventing the opposite would be the
       same mistake mirrored. */
    const { container } = render(
      <AgentCreditHero pool={pool()} agentName="All chatbots" onTopup={vi.fn()} />,
    );
    expect(container.textContent).not.toMatch(/never expire|roll over|expire/i);
  });

  it('shows the plan reset date when there is one, not an expiry claim', () => {
    const { container } = render(
      <AgentCreditHero
        pool={pool({ resetsAt: '2026-09-01T00:00:00Z', topupRemaining: 500 })}
        agentName="All chatbots"
        onTopup={vi.fn()}
      />,
    );
    expect(container.textContent).toMatch(/Plan renews/i);
    expect(container.textContent).not.toMatch(/never expire|roll over/i);
  });
});

describe('BotCreditsSection top-up expiry claim', () => {
  const render_ = (p: PoolCredit) =>
    render(<BotCreditsSection pools={[p]} onTopup={vi.fn()} />).container;

  it('states the real date when a top-up grant is dated', () => {
    const c = render_(pool({ botId: 7, name: 'Agent', topupRemaining: 500, soonestExpiry: '2026-11-30T00:00:00Z' }));
    expect(c.textContent).toMatch(/Top-ups expire/i);
    expect(c.textContent).not.toMatch(/roll over|never expire/i);
  });

  it('claims lifetime only when grants exist and none are dated', () => {
    const c = render_(pool({ botId: 7, name: 'Agent', topupRemaining: 500 }));
    expect(c.textContent).toMatch(/never expire/i);
  });

  it('says nothing about expiry with no grants', () => {
    const c = render_(pool({ botId: 7, name: 'Agent' }));
    expect(c.textContent).not.toMatch(/roll over|never expire|expire/i);
  });
});

describe('the shared rule itself', () => {
  /* `UsagePage`'s "Recent top-ups" description was the third uncovered
     surface: a review replaced it with a hardcoded "Top-up credits never
     expire." and all 166 tests stayed green. Pinning the shared function it
     now calls covers that surface and every future caller at once. */
  function balance(overrides: Partial<CreditBalance> = {}): CreditBalance {
    return {
      monthlyGrant: 1000,
      planRemaining: 400,
      topupRemaining: 0,
      totalRemaining: 400,
      planUsedPct: 60,
      lowBalance: false,
      resetsAt: null,
      soonestExpiry: null,
      aiChat: EMPTY_BUCKET,
      documentUpload: EMPTY_BUCKET,
      urlScan: EMPTY_BUCKET,
      emailSend: EMPTY_BUCKET,
      emailVerification: EMPTY_BUCKET,
      companyName: EMPTY_BUCKET,
      periodCreditsUsed: 600,
      botCredits: [],
      accountPool: null,
      ...overrides,
    };
  }

  it('states the date when a grant is dated', () => {
    const note = describeTopupExpiry(
      balance({ soonestExpiry: '2026-11-30T00:00:00Z', topupRemaining: 500 }),
    );
    expect(note).toMatch(/do expire/i);
    expect(note).toMatch(/Nov 2026/);
  });

  it('claims lifetime only when grants exist and none are dated', () => {
    expect(describeTopupExpiry(balance({ topupRemaining: 500 }))).toMatch(/never expire/i);
  });

  it('says nothing when nothing is proven', () => {
    /* The guard against "fixing" the copy by asserting the opposite. */
    expect(describeTopupExpiry(balance())).toBeNull();
  });
});
