/**
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

export type QuestionType = 'text' | 'choice' | 'number';
export type BantDimension = 'need' | 'timeline' | 'authority' | 'budget';

export interface ServiceQuestion {
  id: string;
  text: string;
  type: QuestionType;
  /** Only meaningful for `choice`; cleared on save for the other two types. */
  options: string[];
  required: boolean;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  unit_label: string;
  price_per_unit: number;
  default_quantity: number;
  questions: ServiceQuestion[];
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
export const MAX_QUESTIONS_PER_SERVICE = 8;
export const MAX_OPTIONS = 8;

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

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'choice', label: 'Multiple choice' },
  { value: 'number', label: 'Number' },
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

export function newQuestionId(existing: readonly ServiceQuestion[]): string {
  return nextId('q', new Set(existing.map((question) => question.id)), existing.length + 1);
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
      unit_label: asString(service.unit_label) || 'unit',
      price_per_unit: Math.max(0, asNumber(service.price_per_unit)),
      default_quantity: Math.max(0, Math.floor(asNumber(service.default_quantity) || 1)),
      questions: (Array.isArray(service.questions) ? service.questions : [])
        .filter((question): question is Record<string, unknown> => !!question && typeof question === 'object')
        .map((question) => ({
          id: asString(question.id),
          text: asString(question.text),
          type: (['text', 'choice', 'number'] as const).includes(question.type as QuestionType)
            ? (question.type as QuestionType)
            : 'text',
          options: (Array.isArray(question.options) ? question.options : []).map(asString),
          // Absent means required. Only an explicit `false` opts out, so a row
          // written before this flag existed keeps the behaviour it had.
          required: question.required !== false,
        })),
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
      unit_label: service.unit_label.trim() || 'unit',
      price_per_unit: Math.max(0, asNumber(service.price_per_unit)),
      default_quantity: Math.max(0, Math.floor(asNumber(service.default_quantity))),
      questions: service.questions.map((question) => ({
        ...question,
        text: question.text.trim(),
        // A non-choice question carrying options is a leftover from a type
        // change, and the widget would render nothing for them anyway.
        options: question.type === 'choice' ? question.options.map((option) => option.trim()).filter(Boolean) : [],
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
    for (const question of service.questions) {
      if (!question.text) return `“${named}” has a question with no text.`;
      if (question.type === 'choice' && question.options.length === 0) {
        return `“${named}” → “${question.text}” needs at least one option.`;
      }
    }
  }
  if (payload.enabled && payload.services.length === 0) {
    return 'Quotations are on, but there are no services to quote. Add one, or switch them off.';
  }
  return null;
}
