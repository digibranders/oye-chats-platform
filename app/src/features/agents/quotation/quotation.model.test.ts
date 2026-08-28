import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOG,
  blockedReason,
  parseCatalog,
  toPayload,
  type QuotationCatalog,
} from './quotation.model';

/**
 * The catalog is stored as a loose JSONB blob and validated server-side by
 * Pydantic models with `extra="ignore"`. That combination is unforgiving: a
 * field this editor spells differently is not rejected, it is DROPPED, and the
 * PUT handler then writes the stripped object straight back over the row.
 *
 * That is not hypothetical. Before this suite existed, the editor still wrote
 * the pre-requirement schema (`price_per_unit`, `questions`) while the API had
 * moved to requirement-level pricing, so saving a catalog stored
 * `{id, name, description, requirements: []}` and silently destroyed every
 * price and question the customer had authored.
 *
 * So these tests pin the FIELD NAMES against `Requirement` / `RequirementOption`
 * in `api/app/api/quotation_routes.py`. If the two drift again, this fails
 * instead of a customer's catalog emptying itself.
 */

const SERVER_REQUIREMENT_KEYS = [
  'id',
  'label',
  'question',
  'type',
  'price',
  'quantity_mode',
  'unit_label',
  'quantity',
  'options',
].sort();

const SERVER_OPTION_KEYS = ['id', 'label', 'price', 'quantity'].sort();

function catalogWith(overrides: Partial<QuotationCatalog> = {}): QuotationCatalog {
  return {
    ...EMPTY_CATALOG,
    services: [
      {
        id: 's1',
        name: 'Photography',
        description: 'Event shoot',
        requirements: [
          {
            id: 'r1',
            label: 'Second shooter',
            question: 'Want a second shooter?',
            type: 'item',
            price: 8000,
            quantity_mode: 'fixed',
            unit_label: 'day',
            quantity: 2,
            options: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('the payload the server actually stores', () => {
  it('emits exactly the fields Requirement declares, and no others', () => {
    const [service] = toPayload(catalogWith()).services;
    expect(Object.keys(service).sort()).toEqual(['description', 'id', 'name', 'requirements']);
    expect(Object.keys(service.requirements[0]).sort()).toEqual(SERVER_REQUIREMENT_KEYS);
  });

  it('emits exactly the fields RequirementOption declares', () => {
    const catalog = catalogWith();
    catalog.services[0].requirements[0] = {
      ...catalog.services[0].requirements[0],
      type: 'choice',
      options: [{ id: 'o1', label: '30 page', price: 5000, quantity: 1 }],
    };
    const [option] = toPayload(catalog).services[0].requirements[0].options;
    expect(Object.keys(option).sort()).toEqual(SERVER_OPTION_KEYS);
  });

  it('drops options from a line that is not a choice, which the widget could not render', () => {
    const catalog = catalogWith();
    catalog.services[0].requirements[0].options = [
      { id: 'o1', label: 'stale', price: 10, quantity: 1 },
    ];
    expect(toPayload(catalog).services[0].requirements[0].options).toEqual([]);
  });

  it('clamps a quantity to at least one, because the server rejects zero', () => {
    const catalog = catalogWith();
    catalog.services[0].requirements[0].quantity = 0;
    expect(toPayload(catalog).services[0].requirements[0].quantity).toBe(1);
  });
});

describe('reading a stored blob back', () => {
  it('round-trips a catalog through parse and payload unchanged', () => {
    const payload = toPayload(catalogWith());
    expect(toPayload(parseCatalog(payload))).toEqual(payload);
  });

  it('reads a service with no requirements as empty rather than throwing', () => {
    const parsed = parseCatalog({ services: [{ id: 's1', name: 'Bare' }] });
    expect(parsed.services[0].requirements).toEqual([]);
  });

  it('ignores the pre-requirement schema instead of inventing prices from it', () => {
    // A row authored before the requirement model. There is no faithful
    // conversion (the old `text`/`number` questions have no equivalent), so the
    // editor shows it empty rather than guessing at what the customer meant.
    const parsed = parseCatalog({
      services: [
        {
          id: 's1',
          name: 'Photography',
          unit_label: 'hour',
          price_per_unit: 2500,
          questions: [{ id: 'q1', text: 'Indoor?', type: 'choice', options: ['Yes'] }],
        },
      ],
    });
    expect(parsed.services[0].requirements).toEqual([]);
    expect(parsed.services[0].name).toBe('Photography');
  });
});

describe('what blocks a save', () => {
  it('names a choice that has no options, which the API would 422 on', () => {
    const catalog = catalogWith();
    catalog.services[0].requirements[0] = {
      ...catalog.services[0].requirements[0],
      type: 'choice',
      options: [],
    };
    expect(blockedReason(catalog)).toContain('needs at least one option');
  });

  it('names a line with no label', () => {
    const catalog = catalogWith();
    catalog.services[0].requirements[0].label = '   ';
    expect(blockedReason(catalog)).toContain('no label');
  });

  it('passes a well-formed catalog', () => {
    expect(blockedReason(catalogWith())).toBeNull();
  });
});
