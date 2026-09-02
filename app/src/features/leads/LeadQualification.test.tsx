import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../types/domain';
import { LeadQualification } from './LeadQualification';

/**
 * MEDDIC is the case that broke the old denominator: six dimensions, each
 * weighted 17, with a top option worth 21. `round(100 / 6)` is 17, so the best
 * possible answer rendered "21/17" beside a bar clamped at full, and the
 * second-best (17) painted as maxed out at 81% of the real ceiling.
 */
function meddicLead(): Lead {
  return {
    session_id: 's1',
    score: 76,
    tier: 'sql',
    status: 'sql',
    chats: 4,
    bant: {
      metrics: { value: 'Board-level quantified outcomes', score: 21 },
      economic_buyer: { value: 'Direct access', score: 17 },
      decision_criteria: { value: null, score: 0 },
      decision_process: { value: null, score: 0 },
      identify_pain: { value: null, score: 0 },
      champion: { value: null, score: 0 },
    },
  } as unknown as Lead;
}

describe('LeadQualification', () => {
  it('states no denominator the payload did not give it', () => {
    render(<LeadQualification lead={meddicLead()} />);
    expect(screen.queryByText('21/17')).not.toBeInTheDocument();
    expect(screen.queryByText('17/17')).not.toBeInTheDocument();
    expect(screen.queryByText(/\/\d+$/)).not.toBeInTheDocument();
  });

  it('draws no bar where there is no ceiling to draw it against', () => {
    render(<LeadQualification lead={meddicLead()} />);
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    // The score is still reported, as what it is: points added to the header
    // figure, with the sentence saying so.
    expect(screen.getByText('+21')).toBeInTheDocument();
    expect(screen.getByText(/points each answer added/i)).toBeInTheDocument();
  });

  it('brings the bar and the fraction back when the payload states a ceiling', () => {
    const lead = {
      session_id: 's2',
      score: 40,
      tier: 'mql',
      status: 'mql',
      chats: 2,
      bant: { metrics: { value: 'Target KPIs committed', score: 17, max: 21 } },
    } as unknown as Lead;

    render(<LeadQualification lead={lead} />);
    expect(screen.getByText('17/21')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
