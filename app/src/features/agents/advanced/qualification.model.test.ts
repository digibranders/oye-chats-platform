import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECAY_RATES,
  balanceWeights,
  decayRatesFor,
  dimensionCanScore,
  effectiveShare,
  makeDimension,
  normalizeDimensionKey,
  parseModel,
  serializeModel,
  toLabel,
  validateModel,
  weightTotal,
  type QualModel,
} from './qualification.model';

/** A minimal MEDDIC-shaped preset, in the exact shape the server returns. */
const MEDDIC_PRESET = {
  framework: 'meddic',
  metrics: {
    enabled: true,
    weight: 17,
    options: [
      { label: 'No measurable impact defined', score: 4 },
      { label: 'Early KPI hypotheses', score: 8 },
    ],
    cta_enabled: false,
    cta_prompt: '',
  },
  champion: {
    enabled: true,
    weight: 17,
    options: [{ label: 'No advocate', score: 4 }],
    cta_enabled: false,
    cta_prompt: '',
  },
  thresholds: { mql: 30, sal: 55, sql: 75 },
};

function bantModel(): QualModel {
  return parseModel(null, 'bant');
}

describe('parseModel', () => {
  it('falls back to the BANT defaults when there is no config and no preset', () => {
    const model = parseModel(null, 'bant');
    expect(model.order).toEqual(['need', 'timeline', 'authority', 'budget']);
    expect(weightTotal(model)).toBe(100);
  });

  it('seeds from the server preset rather than BANT when the bot has no config', () => {
    /* A MEDDIC bot with an empty config used to render BANT's four dimensions,
       because BANT is the only preset shipped client-side. Applying that would
       have written need/timeline/authority/budget onto a MEDDIC chatbot. */
    const model = parseModel(null, 'meddic', MEDDIC_PRESET);

    expect(model.order).toEqual(['metrics', 'champion']);
    expect(model.framework).toBe('meddic');
  });

  it('seeds from the preset for a config that names a framework but has no dimensions', () => {
    const model = parseModel({ framework: 'meddic' }, 'meddic', MEDDIC_PRESET);
    expect(model.order).toEqual(['metrics', 'champion']);
  });

  it('keeps a stored config over the preset', () => {
    const model = parseModel(
      { framework: 'meddic', metrics: { enabled: false, weight: 40, options: [] } },
      'meddic',
      MEDDIC_PRESET,
    );
    expect(model.dimensions.metrics.enabled).toBe(false);
    expect(model.dimensions.metrics.weight).toBe(40);
  });

  it('honours conversation_order, then appends anything it omits', () => {
    const model = parseModel(
      {
        conversation_order: ['budget', 'need'],
        need: { weight: 10, options: [] },
        budget: { weight: 20, options: [] },
        authority: { weight: 30, options: [] },
      },
      'bant',
    );
    expect(model.order).toEqual(['budget', 'need', 'authority']);
  });
});

describe('decay', () => {
  it('reads a rate for every dimension, not only BANT’s two', () => {
    /* `apply_display_decay` reads `{dimension}_decay_per_30d` for whatever
       dimensions the framework has. The editor this replaces exposed exactly
       `timeline_` and `need_`, so MEDDIC's six rates were unreachable. */
    const model = parseModel(MEDDIC_PRESET, 'meddic');
    expect(Object.keys(model.decay.rates).sort()).toEqual(['champion', 'metrics']);
  });

  it('falls back to the server’s own BANT defaults when a rate is absent', () => {
    const model = parseModel(null, 'bant');
    expect(model.decay.rates.timeline).toBe(DEFAULT_DECAY_RATES.timeline);
    expect(model.decay.rates.need).toBe(DEFAULT_DECAY_RATES.need);
    expect(model.decay.rates.budget).toBe(0);
  });

  it('writes every rate explicitly, including the zeros', () => {
    /* The server merges its BANT defaults UNDER the stored decay object, so a
       payload that omits `timeline_decay_per_30d` means 5, not 0. A customer
       who sets timeline decay to zero must see zero after a reload. */
    const model = bantModel();
    model.decay.rates.timeline = 0;
    const serialized = serializeModel(model).decay as Record<string, unknown>;

    expect(serialized.timeline_decay_per_30d).toBe(0);
    expect(serialized.need_decay_per_30d).toBe(DEFAULT_DECAY_RATES.need);
  });

  it('decayRatesFor gives 0 for a dimension the server has no default for', () => {
    expect(decayRatesFor(['need', 'metrics'])).toEqual({ need: 3, metrics: 0 });
  });
});

describe('serializeModel', () => {
  it('round-trips through parseModel without drift', () => {
    const model = bantModel();
    expect(parseModel(serializeModel(model), 'bant')).toEqual(model);
  });

  it('drops a dimension removed from the order', () => {
    const model = bantModel();
    const next: QualModel = {
      ...model,
      order: model.order.filter((key) => key !== 'budget'),
    };
    expect(serializeModel(next)).not.toHaveProperty('budget');
  });
});

describe('effectiveShare', () => {
  it('reports the share a weight actually carries, not the weight', () => {
    /* The server divides each weight by the total across enabled dimensions, so
       25 out of a total of 50 is half the score, not a quarter of it. */
    const model = bantModel();
    model.dimensions.authority.enabled = false;
    model.dimensions.budget.enabled = false;

    expect(effectiveShare(model, 'need')).toBeCloseTo(50);
  });

  it('is null for a dimension that is switched off', () => {
    const model = bantModel();
    model.dimensions.need.enabled = false;
    expect(effectiveShare(model, 'need')).toBeNull();
  });

  it('is null when every enabled weight is zero', () => {
    const model = bantModel();
    for (const key of model.order) model.dimensions[key].weight = 0;
    expect(effectiveShare(model, 'need')).toBeNull();
  });
});

describe('balanceWeights', () => {
  it('rescales to exactly 100 while keeping the ratios', () => {
    const model = bantModel();
    model.dimensions.need.weight = 10;
    model.dimensions.timeline.weight = 10;
    model.dimensions.authority.weight = 10;
    model.dimensions.budget.weight = 10;

    const balanced = balanceWeights(model);
    expect(weightTotal(balanced)).toBe(100);
    expect(balanced.dimensions.need.weight).toBe(25);
  });

  it('puts a rounding remainder on the largest dimension so the total is exact', () => {
    const model = bantModel();
    model.dimensions.need.weight = 1;
    model.dimensions.timeline.weight = 1;
    model.dimensions.authority.weight = 1;
    model.dimensions.budget.weight = 0;

    expect(weightTotal(balanceWeights(model))).toBe(100);
  });

  it('leaves a model with nothing to balance alone', () => {
    const model = bantModel();
    for (const key of model.order) model.dimensions[key].weight = 0;
    expect(balanceWeights(model)).toBe(model);
  });
});

describe('validateModel', () => {
  it('accepts the shipped defaults', () => {
    expect(validateModel(bantModel()).blockedReason).toBeNull();
  });

  it('refuses a model with no dimension enabled, and says why', () => {
    const model = bantModel();
    for (const key of model.order) model.dimensions[key].enabled = false;

    expect(validateModel(model).blockedReason).toMatch(/at least one dimension switched on/i);
  });

  it('refuses a model whose enabled weights are all zero', () => {
    /* `calculate_composite_score` returns 0 when `total_weight <= 0`, which pins
       every visitor at 0 forever. This is the invariant the backend actually
       has — not "must sum to 100". */
    const model = bantModel();
    for (const key of model.order) model.dimensions[key].weight = 0;

    expect(validateModel(model).blockedReason).toMatch(/weight above 0/i);
  });

  it('does NOT refuse a set that fails to sum to 100', () => {
    /* Weights are relative server-side. Refusing 80 would be inventing a rule
       and blocking a config that scores identically to one summing to 100. */
    const model = bantModel();
    model.dimensions.budget.weight = 5;

    expect(weightTotal(model)).not.toBe(100);
    expect(validateModel(model).blockedReason).toBeNull();
  });

  it('flags an enabled dimension whose answers are all worth zero', () => {
    const model = bantModel();
    model.dimensions.need.options = [{ label: 'Anything', score: 0 }];

    const result = validateModel(model);
    expect(result.dimensions.need).toMatch(/worth 0 points/i);
    expect(result.blockedReason).toMatch(/Need/);
  });

  it('flags an enabled dimension with no answers at all', () => {
    const model = bantModel();
    model.dimensions.timeline.options = [];

    expect(validateModel(model).dimensions.timeline).toMatch(/no answers to score/i);
  });

  it('ignores a disabled dimension that could never score', () => {
    const model = bantModel();
    model.dimensions.timeline.options = [];
    model.dimensions.timeline.enabled = false;

    expect(validateModel(model).dimensions.timeline).toBeUndefined();
  });

  it('refuses a weight outside 0–100', () => {
    const model = bantModel();
    model.dimensions.need.weight = 140;
    expect(validateModel(model).dimensions.need).toMatch(/between 0 and 100/i);
  });

  it('refuses thresholds that are out of order, naming the unreachable tier', () => {
    /* `get_tier` tests SQL, then SAL, then MQL. With SAL above SQL, no score can
       ever land on SAL. */
    const model = bantModel();
    model.thresholds = { mql: 30, sal: 80, sql: 75 };

    const result = validateModel(model);
    expect(result.thresholds.sql).toMatch(/above sales-accepted/i);
    expect(result.blockedReason).toMatch(/sales-qualified/i);
  });

  it('refuses a threshold above 100, because the composite is clamped there', () => {
    const model = bantModel();
    model.thresholds = { mql: 30, sal: 55, sql: 120 };
    expect(validateModel(model).thresholds.sql).toMatch(/between 0 and 100/i);
  });

  it('refuses a negative behavioural cap', () => {
    const model = bantModel();
    model.behavioral.max_score = -1;
    expect(validateModel(model).behavioralMaxScore).toMatch(/0 or more/i);
  });
});

describe('helpers', () => {
  it('title-cases a dimension key', () => {
    expect(toLabel('economic_buyer')).toBe('Economic Buyer');
  });

  it('normalises a free-text name into a safe key', () => {
    expect(normalizeDimensionKey('  Buying Committee! ')).toBe('buying_committee');
  });

  it('never reuses an existing dimension key', () => {
    expect(makeDimension(['dimension_1', 'dimension_2']).key).not.toBe('dimension_1');
  });

  it('knows whether a dimension can ever score', () => {
    expect(dimensionCanScore({ ...bantModel().dimensions.need })).toBe(true);
    expect(dimensionCanScore({ ...bantModel().dimensions.need, options: [] })).toBe(false);
  });
});
