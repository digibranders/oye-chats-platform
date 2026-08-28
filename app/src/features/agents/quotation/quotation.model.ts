
import { t as translateNow } from '../../../i18n/i18n';/**
 * The quotation catalog: the priced services a chatbot can quote a visitor for,
 * and the qualification bar a visitor has to clear before it offers to.
 *
 * Parsing, clamping and validation all live here rather than in the page, for
 * the same reason `qualification.model.ts` does: the server stores this as a
 * loose JSONB blob on `Bot.quotation_catalog`, so the boundary between "what a
 * row can contain" and "what the editor can represent" has to be one function
 * with one set of rules, not a scatter of `?? ''` down a form.
 *
 * **Prices here are MAJOR units** — rupees, not paise — because the customer
 * authors this catalog themselves in whole currency. That is the opposite
 * convention to the billing rail, which is minor units throughout, so every
 * amount is scaled at the render boundary rather than stored scaled.
 */

export type RequirementType = 'item' | 'choice';
export type QuantityMode = 'none' | 'fixed' | 'ask';
export type BantDimension = 'need' | 'timeline' | 'authority' | 'budget';

/** One priced answer within a `choice` requirement, e.g. "Next.js". */
export interface RequirementOption {
  id: string;
  label: string;
  price: number;
  quantity: number;
}

/**
 * A line item within a service, and where ALL pricing lives.
 *
 * `item` is a tick-on/off line: its `price × quantity` is added when the
 * visitor selects it. `choice` is a question with priced `options`: the visitor
 * picks at most one and that option's `price × quantity` is added.
 *
 * Mirrors `Requirement` in `api/app/api/quotation_routes.py` field for field. A
 * service is now just a named grouping and carries no price of its own. The
 * server's models are `extra="ignore"`, so a field spelled differently here is
 * not rejected, it is DROPPED - and the PUT writes the stripped object back
 * over the row. `quotation.model.test.ts` pins the names for that reason.
 */
export interface Requirement {
  id: string;
  label: string;
  /** Prompt shown to the visitor. Falls back to `label` server-side when blank. */
  question: string;
  type: RequirementType;
  price: number;
  /**
   * `none` → always 1 and the quantity is hidden everywhere.
   * `fixed` → the admin's `quantity`.
   * `ask` → the visitor picks, with `quantity` pre-filled.
   */
  quantity_mode: QuantityMode;
  unit_label: string;
  quantity: number;
  /** Required and non-empty when `type === 'choice'`; cleared otherwise. */
  options: RequirementOption[];
}

export interface Service {
  id: string;
  name: string;
  description: string;
  requirements: Requirement[];
}

export interface QuotationCatalog {
  enabled: boolean;
  currency: string;
  /** Empty means "any of the four dimensions counts", not "none of them". */
  required_categories: BantDimension[];
  threshold: number;
  services: Service[];
}

export const BANT_DIMENSIONS: { key: BantDimension; label: string; help: string }[] = [
  { key: 'need', label: 'Need', help: 'They described a real problem or use case.' },
  { key: 'timeline', label: 'Timeline', help: 'They said when they want to buy or start.' },
  { key: 'authority', label: 'Authority', help: 'They showed decision-making power.' },
  { key: 'budget', label: 'Budget', help: 'They named a budget range or a price ceiling.' },
];

const DIMENSION_KEYS = new Set<string>(BANT_DIMENSIONS.map((dimension) => dimension.key));

export const MAX_SERVICES = 20;
export const MAX_REQUIREMENTS_PER_SERVICE = 20;
export const MAX_OPTIONS_PER_REQUIREMENT = 12;

export const CURRENCIES: { value: string; label: string }[] = [
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'SGD', label: 'SGD — Singapore Dollar' },
  { value: 'AED', label: 'AED — UAE Dirham' },
];

export const REQUIREMENT_TYPES: { value: RequirementType; label: string }[] = [
  { value: 'item', label: 'Line item' },
  { value: 'choice', label: 'Priced choice' },
];

export const QUANTITY_MODES: { value: QuantityMode; label: string; help: string }[] = [
  { value: 'none', label: 'No quantity', help: 'Counts once. The visitor is never asked.' },
  { value: 'fixed', label: 'Fixed', help: 'Always the quantity you set here.' },
  { value: 'ask', label: 'Ask the visitor', help: 'They pick a number; yours is the default.' },
];

export const EMPTY_CATALOG: QuotationCatalog = {
  enabled: false,
  currency: 'INR',
  required_categories: [],
  threshold: 2,
  services: [],
};

/**
 * How many dimensions the threshold may demand.
 *
 * With no dimensions ticked, all four are in play, so the ceiling is four. With
 * some ticked, only those count — and a threshold above that count is a rule
 * that can never fire, which is why it is clamped rather than merely warned
 * about.
 */
export function thresholdCeiling(categories: readonly BantDimension[]): number {
  return categories.length === 0 ? BANT_DIMENSIONS.length : categories.length;
}

function nextId(prefix: string, taken: Set<string>, from: number): string {
  let n = from;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function newServiceId(existing: readonly Service[]): string {
  return nextId('s', new Set(existing.map((service) => service.id)), existing.length + 1);
}

export function newRequirementId(existing: readonly Requirement[]): string {
  return nextId('r', new Set(existing.map((requirement) => requirement.id)), existing.length + 1);
}

export function newOptionId(existing: readonly RequirementOption[]): string {
  return nextId('o', new Set(existing.map((option) => option.id)), existing.length + 1);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A loose stored blob (or nothing at all) into a catalog the editor can hold. */
export function parseCatalog(raw: unknown): QuotationCatalog {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CATALOG, required_categories: [] };
  const record = raw as Record<string, unknown>;
  const categories = (Array.isArray(record.required_categories) ? record.required_categories : []).filter(
    (candidate): candidate is BantDimension => typeof candidate === 'string' && DIMENSION_KEYS.has(candidate),
  );
  const services = (Array.isArray(record.services) ? record.services : [])
    .filter((service): service is Record<string, unknown> => !!service && typeof service === 'object')
    .map((service) => ({
      id: asString(service.id),
      name: asString(service.name),
      description: asString(service.description),
      // A row written before the requirement model has no `requirements`, so it
      // reads as empty. There is deliberately no conversion from the old
      // `price_per_unit`/`questions` shape: the old free-text and number
      // questions have no equivalent here, so any mapping would be a guess at
      // what the customer priced. See the migration note in the follow-up.
      requirements: (Array.isArray(service.requirements) ? service.requirements : [])
        .filter((req): req is Record<string, unknown> => !!req && typeof req === 'object')
        .map((req) => {
          const type: RequirementType = req.type === 'choice' ? 'choice' : 'item';
          const options = (Array.isArray(req.options) ? req.options : [])
            .filter((opt): opt is Record<string, unknown> => !!opt && typeof opt === 'object')
            .map((opt) => ({
              id: asString(opt.id),
              label: asString(opt.label),
              price: Math.max(0, asNumber(opt.price)),
              quantity: Math.max(1, Math.floor(asNumber(opt.quantity) || 1)),
            }));
          return {
            id: asString(req.id),
            label: asString(req.label),
            question: asString(req.question),
            type,
            price: Math.max(0, asNumber(req.price)),
            quantity_mode: (['none', 'fixed', 'ask'] as const).includes(req.quantity_mode as QuantityMode)
              ? (req.quantity_mode as QuantityMode)
              : 'fixed',
            unit_label: asString(req.unit_label) || 'unit',
            quantity: Math.max(1, Math.floor(asNumber(req.quantity) || 1)),
            // A non-choice requirement carrying options is a leftover from a
            // type change; the widget would render none of them.
            options: type === 'choice' ? options : [],
          };
        }),
    }));

  return {
    enabled: record.enabled === true,
    currency: (asString(record.currency) || 'INR').toUpperCase(),
    required_categories: categories,
    threshold: Math.min(thresholdCeiling(categories), Math.max(1, Math.floor(asNumber(record.threshold)) || 2)),
    services,
  };
}

/** The payload the API stores: trimmed, clamped, and free of dead options. */
export function toPayload(catalog: QuotationCatalog): QuotationCatalog {
  return {
    enabled: catalog.enabled,
    currency: (catalog.currency || 'INR').toUpperCase(),
    required_categories: [...catalog.required_categories],
    threshold: Math.min(catalog.threshold, thresholdCeiling(catalog.required_categories)),
    services: catalog.services.map((service) => ({
      ...service,
      name: service.name.trim(),
      description: service.description.trim(),
      requirements: service.requirements.map((requirement) => ({
        ...requirement,
        label: requirement.label.trim(),
        question: requirement.question.trim(),
        price: Math.max(0, asNumber(requirement.price)),
        unit_label: requirement.unit_label.trim() || 'unit',
        quantity: Math.max(1, Math.floor(asNumber(requirement.quantity) || 1)),
        options:
          requirement.type === 'choice'
            ? requirement.options
                .map((option) => ({
                  ...option,
                  label: option.label.trim(),
                  price: Math.max(0, asNumber(option.price)),
                  quantity: Math.max(1, Math.floor(asNumber(option.quantity) || 1)),
                }))
                .filter((option) => option.label)
            : [],
      })),
    })),
  };
}

/**
 * Why this catalog cannot be saved, named specifically enough to act on.
 *
 * One reason at a time, in the order the reader would meet them scrolling the
 * page: "please fix the errors above" makes them hunt, which is exactly the
 * failure `SaveBar.blockedReason` exists to prevent.
 */
export function blockedReason(catalog: QuotationCatalog): string | null {
  const payload = toPayload(catalog);
  for (const [index, service] of payload.services.entries()) {
    const named = service.name || `Service ${index + 1}`;
    if (!service.name) return `Service ${index + 1} needs a name.`;
    for (const requirement of service.requirements) {
      if (!requirement.label) return `“${named}” has a line with no label.`;
      // Mirrors `_check_choice_has_options` server-side: a choice with no
      // options is rejected by the API, so the save is blocked here instead of
      // failing with a 422 the reader cannot place.
      if (requirement.type === 'choice' && requirement.options.length === 0) {
        return `“${named}” → “${requirement.label}” needs at least one option.`;
      }
    }
  }
  if (payload.enabled && payload.services.length === 0) {
    return translateNow('agents.quotationsAreOnButThere') || 'Quotations are on, but there are no services to quote. Add one, or switch them off.';
  }
  return null;
}
