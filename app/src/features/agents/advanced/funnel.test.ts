import { describe, expect, it } from 'vitest';
import { FUNNEL_STAGES, parseFunnel } from './funnel';

describe('parseFunnel', () => {
  it('keeps the server’s stage order, not the payload’s', () => {
    /* Each stage's conversion rate is relative to the one before it, so a
       reordered payload would turn the chart into nonsense. */
    const parsed = parseFunnel({
      funnel: [
        { stage: 'sql', count: 4 },
        { stage: 'total_visitors', count: 100 },
      ],
    });
    expect(parsed.map((stage) => stage.key)).toEqual(FUNNEL_STAGES.map((stage) => stage.key));
    expect(parsed[0].count).toBe(100);
  });

  it('reports a stage the payload omits as 0 rather than dropping the row', () => {
    const parsed = parseFunnel({ funnel: [{ stage: 'total_visitors', count: 12 }] });
    expect(parsed).toHaveLength(FUNNEL_STAGES.length);
    expect(parsed.find((stage) => stage.key === 'meetings_booked')?.count).toBe(0);
  });

  it('survives a payload that is not a funnel at all', () => {
    for (const payload of [null, undefined, {}, { funnel: 'nope' }, { funnel: [1, null] }]) {
      expect(parseFunnel(payload).every((stage) => stage.count === 0)).toBe(true);
    }
  });

  it('ignores a row whose count is not a number', () => {
    const parsed = parseFunnel({ funnel: [{ stage: 'mql', count: '7' }] });
    expect(parsed.find((stage) => stage.key === 'mql')?.count).toBe(0);
  });
});
