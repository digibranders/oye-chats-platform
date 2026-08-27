import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { formatNumber } from '../../../i18n/formatters';
import {
  Receipt,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  X,
  ChevronDown,
  ChevronRight,
  Lock,
  Info,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Input, SectionHeader, Select } from '../../../design-system';
import { Toggle } from './controls';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getQuotationCatalog, putQuotationCatalog } from '../../../services/api';

type QuestionType = 'text' | 'choice' | 'number';
type BantDimension = 'need' | 'timeline' | 'authority' | 'budget';

const BANT_DIMENSIONS: { key: BantDimension; label: string; help: string }[] = [
  { key: 'need', label: 'Need', help: 'Visitor described a real problem or use case.' },
  { key: 'timeline', label: 'Timeline', help: 'Visitor mentioned when they want to buy or start.' },
  { key: 'authority', label: 'Authority', help: 'Visitor showed decision-making power or influence.' },
  { key: 'budget', label: 'Budget', help: 'Visitor mentioned a budget range or price ceiling.' },
];

const QUOTATION_PLAN_SLUGS = new Set(['professional', 'enterprise']);

/**
 * Small `(i)` icon that surfaces an inline explanation instantly on hover
 * and on keyboard focus. Rolled inline (no design-system tooltip primitive
 * exists yet) as a wrapper span whose absolutely-positioned popover appears
 * via CSS `group-hover` / `group-focus-within`, so there's no JS state,
 * timers, or ref work. `aria-label` stays populated so screen readers get
 * the same text without needing the popover.
 */
function Hint({ what, example }: { what: string; example: string }): ReactElement {
  return (
    <span className="group relative inline-flex">
      <span
        role="img"
        aria-label={`${what}. Example: ${example}`}
        tabIndex={0}
        className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full text-[var(--ds-text-subtle)] hover:text-[var(--ds-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
      >
        <Info size={12} aria-hidden="true" />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-2.5 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal text-[var(--ds-text)] shadow-[var(--ds-shadow-md)] group-hover:block group-focus-within:block"
      >
        <span className="block text-[var(--ds-text)]">{what}</span>
        <span className="mt-1.5 block border-t border-[var(--ds-border)] pt-1.5 text-[var(--ds-text-subtle)]">
          <span className="font-medium text-[var(--ds-text)]">Example: </span>
          {example}
        </span>
      </span>
    </span>
  );
}

function thresholdCeiling(categories: BantDimension[]): number {
  return categories.length === 0 ? 4 : categories.length;
}

interface ServiceQuestion {
  id: string;
  text: string;
  type: QuestionType;
  options: string[];
  required: boolean;
}

interface Service {
  id: string;
  name: string;
  description: string;
  unit_label: string;
  price_per_unit: number;
  default_quantity: number;
  questions: ServiceQuestion[];
}

interface QuotationCatalog {
  enabled: boolean;
  currency: string;
  required_categories: BantDimension[];
  threshold: number;
  services: Service[];
}

const MAX_SERVICES = 20;
const MAX_QUESTIONS_PER_SERVICE = 8;
const MAX_OPTIONS = 8;

const CURRENCIES: { value: string; label: string }[] = [
  { value: 'INR', label: 'INR · ₹ Indian Rupee' },
  { value: 'USD', label: 'USD · $ US Dollar' },
  { value: 'EUR', label: 'EUR · € Euro' },
  { value: 'GBP', label: 'GBP · £ British Pound' },
  { value: 'AUD', label: 'AUD · $ Australian Dollar' },
  { value: 'CAD', label: 'CAD · $ Canadian Dollar' },
  { value: 'SGD', label: 'SGD · $ Singapore Dollar' },
  { value: 'AED', label: 'AED · د.إ UAE Dirham' },
];

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  AED: 'د.إ',
};

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'choice', label: 'Multiple choice' },
  { value: 'number', label: 'Number' },
];

const EMPTY_CATALOG: QuotationCatalog = {
  enabled: false,
  currency: 'INR',
  required_categories: [],
  threshold: 2,
  services: [],
};

function newServiceId(existing: Service[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((s) => s.id));
  while (taken.has(`s${n}`)) n += 1;
  return `s${n}`;
}

function newQuestionId(existing: ServiceQuestion[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((q) => q.id));
  while (taken.has(`q${n}`)) n += 1;
  return `q${n}`;
}

function normalize(raw: QuotationCatalog | null | undefined): QuotationCatalog {
  if (!raw) return { ...EMPTY_CATALOG, required_categories: [] };
  const rawCategories = Array.isArray(raw.required_categories) ? raw.required_categories : [];
  const categories = rawCategories.filter((c): c is BantDimension =>
    ['need', 'timeline', 'authority', 'budget'].includes(c),
  );
  return {
    enabled: !!raw.enabled,
    currency: (raw.currency || 'INR').toUpperCase(),
    required_categories: categories,
    threshold: Math.min(4, Math.max(1, Number(raw.threshold) || 2)),
    services: (raw.services || []).map((s) => ({
      id: s.id,
      name: s.name ?? '',
      description: s.description ?? '',
      unit_label: s.unit_label || 'unit',
      price_per_unit: Number(s.price_per_unit) || 0,
      default_quantity: Number.isFinite(Number(s.default_quantity))
        ? Math.max(0, Math.floor(Number(s.default_quantity)))
        : 1,
      questions: (s.questions || []).map((q) => ({
        id: q.id,
        text: q.text ?? '',
        type: (q.type as QuestionType) || 'text',
        options: Array.isArray(q.options) ? q.options : [],
        required: q.required !== false,
      })),
    })),
  };
}

function formatMoney(currency: string, value: number): string {
  const symbol = CURRENCY_SYMBOL[currency] ?? currency;
  const rounded = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  return `${symbol}${formatNumber(rounded)}`;
}

interface QuotationCatalogSectionProps {
  botId: number | null;
}

/**
 * Standalone editor for a bot's quotation catalog. Same self-contained
 * fetch/dirty/save shape as QualificationFlowSection: the service list is
 * dynamic and doesn't fit the flat-field draft model used by the other
 * Advanced sections.
 */
export function QuotationCatalogSection({ botId }: QuotationCatalogSectionProps): ReactElement | null {
  const navigate = useNavigate();
  const { planSlug, planName, loading: entitlementsLoading } = useEntitlements();
  const planAllows = QUOTATION_PLAN_SLUGS.has((planSlug || '').toLowerCase());

  const [catalog, setCatalog] = useState<QuotationCatalog>(EMPTY_CATALOG);
  const [initial, setInitial] = useState<QuotationCatalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState<number>(0);
  const [expandedServiceId, setExpandedServiceId] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getQuotationCatalog(botId)
      .then((data) => {
        if (cancelled) return;
        const normalized = normalize(data as QuotationCatalog);
        setCatalog(normalized);
        setInitial(normalized);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Failed to load quotation catalog');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const dirty = useMemo(() => JSON.stringify(catalog) !== JSON.stringify(initial), [catalog, initial]);

  const updateService = useCallback((index: number, patch: Partial<Service>) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  }, []);

  const addService = useCallback(() => {
    setCatalog((prev) => {
      if (prev.services.length >= MAX_SERVICES) return prev;
      const id = newServiceId(prev.services);
      const next: Service = {
        id,
        name: '',
        description: '',
        unit_label: 'unit',
        price_per_unit: 0,
        default_quantity: 1,
        questions: [],
      };
      setExpandedServiceId(id);
      return { ...prev, services: [...prev.services, next] };
    });
  }, []);

  const removeService = useCallback((index: number) => {
    setCatalog((prev) => ({ ...prev, services: prev.services.filter((_, i) => i !== index) }));
  }, []);

  const addQuestion = useCallback((sIndex: number) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => {
        if (i !== sIndex) return s;
        if (s.questions.length >= MAX_QUESTIONS_PER_SERVICE) return s;
        return {
          ...s,
          questions: [
            ...s.questions,
            {
              id: newQuestionId(s.questions),
              text: '',
              type: 'text',
              options: [],
              required: true,
            },
          ],
        };
      }),
    }));
  }, []);

  const updateQuestion = useCallback(
    (sIndex: number, qIndex: number, patch: Partial<ServiceQuestion>) => {
      setCatalog((prev) => ({
        ...prev,
        services: prev.services.map((s, i) => {
          if (i !== sIndex) return s;
          return {
            ...s,
            questions: s.questions.map((q, qi) => (qi === qIndex ? { ...q, ...patch } : q)),
          };
        }),
      }));
    },
    [],
  );

  const removeQuestion = useCallback((sIndex: number, qIndex: number) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => {
        if (i !== sIndex) return s;
        return { ...s, questions: s.questions.filter((_, qi) => qi !== qIndex) };
      }),
    }));
  }, []);

  const addOption = useCallback((sIndex: number, qIndex: number) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => {
        if (i !== sIndex) return s;
        return {
          ...s,
          questions: s.questions.map((q, qi) => {
            if (qi !== qIndex) return q;
            if (q.options.length >= MAX_OPTIONS) return q;
            return { ...q, options: [...q.options, ''] };
          }),
        };
      }),
    }));
  }, []);

  const updateOption = useCallback(
    (sIndex: number, qIndex: number, oIndex: number, value: string) => {
      setCatalog((prev) => ({
        ...prev,
        services: prev.services.map((s, i) => {
          if (i !== sIndex) return s;
          return {
            ...s,
            questions: s.questions.map((q, qi) => {
              if (qi !== qIndex) return q;
              return {
                ...q,
                options: q.options.map((opt, oi) => (oi === oIndex ? value : opt)),
              };
            }),
          };
        }),
      }));
    },
    [],
  );

  const removeOption = useCallback((sIndex: number, qIndex: number, oIndex: number) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => {
        if (i !== sIndex) return s;
        return {
          ...s,
          questions: s.questions.map((q, qi) => {
            if (qi !== qIndex) return q;
            return { ...q, options: q.options.filter((_, oi) => oi !== oIndex) };
          }),
        };
      }),
    }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!botId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const cleaned: QuotationCatalog = {
        enabled: catalog.enabled,
        currency: (catalog.currency || 'INR').toUpperCase(),
        required_categories: [...catalog.required_categories],
        threshold: Math.min(catalog.threshold, thresholdCeiling(catalog.required_categories)),
        services: catalog.services.map((s) => ({
          ...s,
          name: s.name.trim(),
          description: s.description.trim(),
          unit_label: (s.unit_label || 'unit').trim() || 'unit',
          price_per_unit: Number(s.price_per_unit) || 0,
          default_quantity: Math.max(0, Math.floor(Number(s.default_quantity) || 0)),
          questions: s.questions.map((q) => ({
            ...q,
            text: q.text.trim(),
            options: q.type === 'choice' ? q.options.map((o) => o.trim()).filter(Boolean) : [],
          })),
        })),
      };
      for (const s of cleaned.services) {
        if (!s.name) throw new Error('Every service needs a name.');
        if (s.price_per_unit < 0) throw new Error(`"${s.name}" has a negative price.`);
        for (const q of s.questions) {
          if (!q.text) throw new Error(`"${s.name}" has a question with no text.`);
          if (q.type === 'choice' && q.options.length === 0) {
            throw new Error(`"${s.name}" → question "${q.text}" needs at least one option.`);
          }
        }
      }
      const saved = await putQuotationCatalog(botId, cleaned);
      const normalized = normalize(saved as QuotationCatalog);
      setCatalog(normalized);
      setInitial(normalized);
      setSavedTick((t) => t + 1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save quotation catalog';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [botId, catalog, saving]);

  if (!botId) return null;

  return (
    <section aria-labelledby="quotation-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="quotation-heading" className="inline-flex items-center gap-2">
            <Receipt size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Quotations
          </span>
        }
        description="Define the services this bot can quote for. The bot asks the questions you configure per service, multiplies price × quantity, and returns a live estimate."
      />

      {!entitlementsLoading && !planAllows && (
        <Card className="flex flex-col items-start gap-3 border-dashed p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
              <Lock size={16} aria-hidden="true" />
            </div>
            <div>
              <p className="text-[14px] font-medium text-[var(--ds-text)]">
                Quotations are on the Professional plan
              </p>
              <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
                You're on {planName || planSlug || 'a lower plan'}. Upgrade to let this bot generate live quotes from a service catalog you configure.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => navigate('/workspace/billing')}>
            Upgrade plan
          </Button>
        </Card>
      )}

      <Card
        className={`space-y-6 p-5 ${!planAllows ? 'pointer-events-none opacity-60' : ''}`}
        aria-disabled={!planAllows}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[14px] font-medium text-[var(--ds-text)]">
              Enable quotations
            </p>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
              Off means the bot never offers to build a quote, even when asked.
            </p>
          </div>
          <Toggle
            checked={catalog.enabled}
            onChange={(next: boolean) => setCatalog((prev) => ({ ...prev, enabled: next }))}
            label="Enable quotations"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
          <div className="space-y-1">
            <label
              className="text-[13px] font-medium text-[var(--ds-text)]"
              htmlFor="quotation-currency"
            >
              Currency
            </label>
            <Select
              id="quotation-currency"
              value={catalog.currency}
              onChange={(value: string) => setCatalog((prev) => ({ ...prev, currency: value }))}
              options={CURRENCIES}
            />
          </div>
          <p className="self-end text-[11px] text-[var(--ds-text-subtle)]">
            All service prices are stored and quoted in this currency.
          </p>
        </div>

        <div className="space-y-2">
          <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text)]">
            Trigger: categories that count
            <Hint
              what="Which BANT dimensions must be marked in the visitor's chat before the quote card can appear. Only ticked dimensions count toward the threshold below."
              example="Tick Budget + Timeline to only quote high-intent leads who mentioned both. Tick just Budget to quote anyone who names any price signal."
            />
          </p>
          <p className="text-[11px] text-[var(--ds-text-subtle)]">
            Pick which BANT dimensions must be marked before the bot offers a quote. Leave all off to count any of the four.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {BANT_DIMENSIONS.map((dim) => {
              const active = catalog.required_categories.includes(dim.key);
              return (
                <button
                  key={dim.key}
                  type="button"
                  onClick={() =>
                    setCatalog((prev) => {
                      const has = prev.required_categories.includes(dim.key);
                      const nextCategories = has
                        ? prev.required_categories.filter((c) => c !== dim.key)
                        : [...prev.required_categories, dim.key];
                      return {
                        ...prev,
                        required_categories: nextCategories,
                        threshold: Math.min(prev.threshold, thresholdCeiling(nextCategories)),
                      };
                    })
                  }
                  className={`flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors ${
                    active
                      ? 'border-[var(--ds-accent)] bg-[var(--ds-accent)]/5'
                      : 'border-[var(--ds-border)] bg-transparent hover:border-[var(--ds-border-strong)]'
                  }`}
                  aria-pressed={active}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    readOnly
                    tabIndex={-1}
                    className="mt-0.5"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-[var(--ds-text)]">{dim.label}</span>
                    <span className="mt-0.5 block text-[11px] text-[var(--ds-text-subtle)]">{dim.help}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <label
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text)]"
            htmlFor="quotation-threshold"
          >
            Trigger threshold
            <Hint
              what="How many of the ticked categories must be marked before the quote card fires. Auto-caps at the number of categories you picked so you can't set an unreachable value."
              example="Picked Budget + Timeline and set 2 of 2 → both must be present. Set 1 of 2 → either one alone is enough."
            />
          </label>
          <Select
            id="quotation-threshold"
            value={String(catalog.threshold)}
            onChange={(value: string) =>
              setCatalog((prev) => ({
                ...prev,
                threshold: Math.max(
                  1,
                  Math.min(thresholdCeiling(prev.required_categories), Number(value) || 2),
                ),
              }))
            }
            options={Array.from({ length: thresholdCeiling(catalog.required_categories) }, (_, i) => ({
              value: String(i + 1),
              label: `${i + 1} of ${thresholdCeiling(catalog.required_categories)} ${thresholdCeiling(catalog.required_categories) === 1 ? 'dimension' : 'dimensions'}`,
            }))}
          />
          <p className="text-[11px] text-[var(--ds-text-subtle)]">
            {catalog.required_categories.length === 0
              ? 'Any of the 4 BANT dimensions (Need · Timeline · Authority · Budget) can count.'
              : `Only these count: ${catalog.required_categories
                  .map((k) => BANT_DIMENSIONS.find((d) => d.key === k)?.label ?? k)
                  .join(' · ')}.`}
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--ds-text)]">
              Services
              <Hint
                what="The billable line items this bot can quote. The visitor picks which ones they want, and the bot walks each one to compute a live total."
                example="Web agency: Landing page · Logo design · SEO audit. SaaS: Starter seats · Growth seats · Onboarding hours."
              />
            </p>
            <p className="text-[11px] text-[var(--ds-text-subtle)]">
              {catalog.services.length} / {MAX_SERVICES}
            </p>
          </div>

          {catalog.services.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--ds-border)] p-4 text-[13px] text-[var(--ds-text-subtle)]">
              No services yet. Add up to {MAX_SERVICES} services this bot can quote for.
            </p>
          ) : (
            <div className="space-y-3">
              {catalog.services.map((service, sIndex) => {
                const expanded = expandedServiceId === service.id;
                const subtotal = service.price_per_unit * service.default_quantity;
                return (
                  <div key={service.id} className="rounded-md border border-[var(--ds-border)]">
                    <button
                      type="button"
                      onClick={() => setExpandedServiceId(expanded ? null : service.id)}
                      className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-[var(--ds-bg-sunken)]"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {expanded ? (
                          <ChevronDown size={14} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
                        ) : (
                          <ChevronRight size={14} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-[14px] font-medium text-[var(--ds-text)]">
                            {service.name.trim() || `Service ${sIndex + 1}`}
                          </p>
                          <p className="mt-0.5 text-[11px] text-[var(--ds-text-subtle)]">
                            {formatMoney(catalog.currency, service.price_per_unit)} / {service.unit_label || 'unit'} · {service.questions.length} question{service.questions.length === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      <span className="shrink-0 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                        {formatMoney(catalog.currency, subtotal)}
                      </span>
                    </button>

                    {expanded && (
                      <div className="space-y-4 border-t border-[var(--ds-border)] p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                              Service name
                              <Hint
                                what="What the visitor sees in the service picker card. Keep it short and unambiguous."
                                example="Landing page design · Logo design · SEO audit · Backend development"
                              />
                            </label>
                            <Input
                              value={service.name}
                              onChange={(event) => updateService(sIndex, { name: event.target.value })}
                              placeholder="e.g. Landing page design"
                              disabled={saving}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                              Unit label
                              <Hint
                                what="What one unit of this service is billed against. Shown next to the price and used as the label on the quantity prompt."
                                example="page · hour · seat · revision round · word · month · project"
                              />
                            </label>
                            <Input
                              value={service.unit_label}
                              onChange={(event) => updateService(sIndex, { unit_label: event.target.value })}
                              placeholder="page, hour, word, seat…"
                              disabled={saving}
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                            Short description (optional)
                            <Hint
                              what="One-line explainer shown under the service name in the visitor's picker. Optional."
                              example="'Custom-designed responsive landing page' · 'Includes 3 concepts + revisions'"
                            />
                          </label>
                          <Input
                            value={service.description}
                            onChange={(event) => updateService(sIndex, { description: event.target.value })}
                            placeholder="One line shown to the visitor while quoting."
                            disabled={saving}
                          />
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                              Price per {service.unit_label || 'unit'}
                              <Hint
                                what="Cost of one unit. The final subtotal is this × quantity. Stored in the currency you picked at the top."
                                example={`Landing page @ 15000 per page → 3 pages = ${formatNumber((15000 * 3))}`}
                              />
                            </label>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              value={String(service.price_per_unit)}
                              onChange={(event) =>
                                updateService(sIndex, { price_per_unit: Number(event.target.value) || 0 })
                              }
                              disabled={saving}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                              Default quantity
                              <Hint
                                what="The number pre-filled when the bot asks the visitor 'how many?'. They can still change it."
                                example="1 for a one-off project · 3 for typical logo revision rounds · 10 for a 10-page SEO audit"
                              />
                            </label>
                            <Input
                              type="number"
                              min="0"
                              step="1"
                              value={String(service.default_quantity)}
                              onChange={(event) =>
                                updateService(sIndex, {
                                  default_quantity: Math.max(0, Math.floor(Number(event.target.value) || 0)),
                                })
                              }
                              disabled={saving}
                            />
                          </div>
                        </div>

                        {/* Per-service questions */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text)]">
                              Questions for this service
                              <Hint
                                what="Extra info the bot collects for this service before locking in the quote. Answers are saved with the lead for the operator."
                                example="Landing page → 'How many sections?' (number) + 'Design style?' (choice). Logo → 'Preferred style?' (Wordmark / Icon / Combination)."
                              />
                            </p>
                            <p className="text-[11px] text-[var(--ds-text-subtle)]">
                              {service.questions.length} / {MAX_QUESTIONS_PER_SERVICE}
                            </p>
                          </div>
                          {service.questions.length === 0 ? (
                            <p className="rounded-md border border-dashed border-[var(--ds-border)] p-3 text-[12px] text-[var(--ds-text-subtle)]">
                              No questions yet. Add questions the bot should ask to scope this service.
                            </p>
                          ) : (
                            <div className="space-y-3">
                              {service.questions.map((q, qIndex) => (
                                <div key={q.id} className="space-y-2 rounded-md bg-[var(--ds-bg-sunken)] p-3">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] uppercase tracking-wider text-[var(--ds-text-subtle)]">
                                      Question {qIndex + 1}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => removeQuestion(sIndex, qIndex)}
                                      className="inline-flex items-center gap-1 text-[12px] text-[var(--ds-danger)] hover:underline"
                                      disabled={saving}
                                    >
                                      <Trash2 size={12} /> Remove
                                    </button>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                      Question text
                                      <Hint
                                        what="Exactly what the bot will ask the visitor for this service."
                                        example="'How many sections per page?' · 'Preferred design style?' · 'Do you need SSO?'"
                                      />
                                    </label>
                                    <Input
                                      value={q.text}
                                      onChange={(event) => updateQuestion(sIndex, qIndex, { text: event.target.value })}
                                      placeholder="What should the bot ask?"
                                      disabled={saving}
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                      Answer type
                                      <Hint
                                        what="How the visitor answers. Text = free typing. Multiple choice = pick from your options. Number = numeric input only."
                                        example="'How many sections?' → Number. 'Design style?' → Multiple choice. 'Any special requirements?' → Text."
                                      />
                                    </label>
                                    <Select
                                      value={q.type}
                                      onChange={(value: string) => {
                                        const nextType = value as QuestionType;
                                        updateQuestion(sIndex, qIndex, {
                                          type: nextType,
                                          options:
                                            nextType === 'choice' && q.options.length === 0 ? [''] : q.options,
                                        });
                                      }}
                                      options={QUESTION_TYPES}
                                    />
                                  </div>
                                  {q.type === 'choice' && (
                                    <div className="space-y-1.5 rounded-md bg-[var(--ds-bg-surface)] p-2">
                                      <p className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--ds-text-subtle)]">
                                        Options
                                        <Hint
                                          what="The buttons the visitor picks from. Add one per line, the visitor sees them exactly as you type them."
                                          example="For 'Design style?' → Modern, Classic, Minimalist. For 'Preferred stack?' → React, Vue, Svelte."
                                        />
                                      </p>
                                      {q.options.length === 0 ? (
                                        <p className="text-[12px] text-[var(--ds-text-subtle)]">
                                          Add at least one option.
                                        </p>
                                      ) : (
                                        <div className="space-y-1">
                                          {q.options.map((opt, oIndex) => (
                                            <div key={oIndex} className="flex items-center gap-2">
                                              <Input
                                                value={opt}
                                                onChange={(event) =>
                                                  updateOption(sIndex, qIndex, oIndex, event.target.value)
                                                }
                                                placeholder={`Option ${oIndex + 1}`}
                                                disabled={saving}
                                              />
                                              <button
                                                type="button"
                                                onClick={() => removeOption(sIndex, qIndex, oIndex)}
                                                aria-label={`Remove option ${oIndex + 1}`}
                                                className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ds-text-subtle)] hover:bg-[var(--ds-bg-sunken)] hover:text-[var(--ds-danger)]"
                                                disabled={saving}
                                              >
                                                <X size={14} aria-hidden="true" />
                                              </button>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => addOption(sIndex, qIndex)}
                                        disabled={saving || q.options.length >= MAX_OPTIONS}
                                      >
                                        <Plus size={12} aria-hidden="true" /> Add option
                                      </Button>
                                    </div>
                                  )}
                                  <label className="flex items-center gap-2 text-[12px] text-[var(--ds-text-subtle)]">
                                    <input
                                      type="checkbox"
                                      checked={q.required}
                                      onChange={(event) =>
                                        updateQuestion(sIndex, qIndex, { required: event.target.checked })
                                      }
                                      disabled={saving}
                                    />
                                    Required
                                    <Hint
                                      what="If ticked, the visitor can't move past this question without answering. Untick for genuinely optional context."
                                      example="'How many sections?' → required (affects the price). 'Any special notes?' → optional."
                                    />
                                  </label>
                                </div>
                              ))}
                            </div>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => addQuestion(sIndex)}
                            disabled={saving || service.questions.length >= MAX_QUESTIONS_PER_SERVICE}
                          >
                            <Plus size={12} aria-hidden="true" /> Add question
                          </Button>
                        </div>

                        <div className="flex items-center justify-between border-t border-[var(--ds-border)] pt-3">
                          <p className="text-[11px] text-[var(--ds-text-subtle)]">
                            Subtotal at default qty: <span className="text-[var(--ds-text)]">{formatMoney(catalog.currency, subtotal)}</span>
                          </p>
                          <button
                            type="button"
                            onClick={() => removeService(sIndex)}
                            className="inline-flex items-center gap-1 text-[12px] text-[var(--ds-danger)] hover:underline"
                            disabled={saving}
                          >
                            <Trash2 size={12} /> Remove service
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={addService}
            disabled={saving || catalog.services.length >= MAX_SERVICES}
          >
            <Plus size={14} aria-hidden="true" />
            Add service
          </Button>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--ds-border)] pt-4">
          <div className="min-h-[20px] text-[12px]">
            {error ? (
              <span className="inline-flex items-center gap-1 text-[var(--ds-danger)]">
                <AlertTriangle size={12} aria-hidden="true" /> {error}
              </span>
            ) : loading ? (
              <span className="text-[var(--ds-text-subtle)]">Loading catalog...</span>
            ) : savedTick > 0 && !dirty ? (
              <span className="inline-flex items-center gap-1 text-[var(--ds-success)]">
                <CheckCircle2 size={12} aria-hidden="true" /> Saved.
              </span>
            ) : dirty ? (
              <span className="text-[var(--ds-text-subtle)]">You have unsaved changes.</span>
            ) : null}
          </div>
          <Button onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving...' : 'Save catalog'}
          </Button>
        </div>
      </Card>
    </section>
  );
}
