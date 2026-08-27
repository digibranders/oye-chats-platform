import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { formatNumber } from '../../../i18n/formatters';
import {
  Receipt,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Lock,
  Info,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Input, SectionHeader, Select } from '../../../design-system';
import { Toggle } from './controls';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getQuotationCatalog, putQuotationCatalog } from '../../../services/api';

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
 * and on keyboard focus.
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

type RequirementType = 'item' | 'choice';
type QtyMode = 'none' | 'fixed' | 'ask';

const REQUIREMENT_QTY_MODES: { value: QtyMode; label: string }[] = [
  { value: 'none', label: 'No quantity' },
  { value: 'fixed', label: 'Fixed (you set it)' },
  { value: 'ask', label: 'Ask the visitor' },
];

interface RequirementOption {
  id: string;
  label: string;
  price: number;
  quantity: number;
}

interface Requirement {
  id: string;
  label: string;
  question: string;
  type: RequirementType;
  quantity_mode: QtyMode;
  unit_label: string;
  price: number;
  quantity: number;
  options: RequirementOption[];
}

interface Service {
  id: string;
  name: string;
  description: string;
  requirements: Requirement[];
}

const REQUIREMENT_TYPES: { value: RequirementType; label: string }[] = [
  { value: 'item', label: 'Simple item' },
  { value: 'choice', label: 'Choice (priced options)' },
];

function normQty(value: unknown): number {
  return Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : 1;
}

interface QuotationCatalog {
  enabled: boolean;
  currency: string;
  required_categories: BantDimension[];
  threshold: number;
  services: Service[];
}

const MAX_SERVICES = 20;
const MAX_REQUIREMENTS_PER_SERVICE = 20;
const MAX_OPTIONS_PER_REQUIREMENT = 12;

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

function newRequirementId(existing: Requirement[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((r) => r.id));
  while (taken.has(`r${n}`)) n += 1;
  return `r${n}`;
}

function newOptionId(existing: RequirementOption[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((o) => o.id));
  while (taken.has(`o${n}`)) n += 1;
  return `o${n}`;
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
      requirements: (s.requirements || []).map((r) => ({
        id: r.id,
        label: r.label ?? '',
        question: r.question ?? '',
        type: (r.type as RequirementType) === 'choice' ? 'choice' : 'item',
        quantity_mode: (['none', 'fixed', 'ask'] as QtyMode[]).includes(r.quantity_mode as QtyMode)
          ? (r.quantity_mode as QtyMode)
          : 'fixed',
        unit_label: r.unit_label || 'unit',
        price: Number(r.price) || 0,
        quantity: normQty(r.quantity),
        options: (r.options || []).map((o) => ({
          id: o.id,
          label: o.label ?? '',
          price: Number(o.price) || 0,
          quantity: normQty(o.quantity),
        })),
      })),
    })),
  };
}

/** Sum of the simple-item requirements only. Choice requirements are
 * inherently variable (the visitor picks one), so they're excluded from this
 * indicative figure; each option shows its own price inline instead. */
function serviceItemsSubtotal(service: Service): number {
  return service.requirements
    .filter((r) => r.type === 'item' && r.quantity_mode !== 'ask')
    .reduce(
      (sum, r) => sum + (Number(r.price) || 0) * (r.quantity_mode === 'none' ? 1 : Number(r.quantity) || 0),
      0,
    );
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
 * Standalone editor for a bot's quotation catalog. A service is a named group
 * of priced requirements; each requirement carries its own price and quantity.
 * The visitor picks a service, checks which requirements they need, and the
 * bot returns a live estimate summing the chosen requirements.
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
      const next: Service = { id, name: '', description: '', requirements: [] };
      setExpandedServiceId(id);
      return { ...prev, services: [...prev.services, next] };
    });
  }, []);

  const removeService = useCallback((index: number) => {
    setCatalog((prev) => ({ ...prev, services: prev.services.filter((_, i) => i !== index) }));
  }, []);

  const addRequirement = useCallback((sIndex: number) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => {
        if (i !== sIndex) return s;
        if (s.requirements.length >= MAX_REQUIREMENTS_PER_SERVICE) return s;
        return {
          ...s,
          requirements: [
            ...s.requirements,
            { id: newRequirementId(s.requirements), label: '', question: '', type: 'item', quantity_mode: 'none', unit_label: 'unit', price: 0, quantity: 1, options: [] },
          ],
        };
      }),
    }));
  }, []);

  const updateRequirement = useCallback(
    (sIndex: number, rIndex: number, patch: Partial<Requirement>) => {
      setCatalog((prev) => ({
        ...prev,
        services: prev.services.map((s, i) => {
          if (i !== sIndex) return s;
          return {
            ...s,
            requirements: s.requirements.map((r, ri) => (ri === rIndex ? { ...r, ...patch } : r)),
          };
        }),
      }));
    },
    [],
  );

  const removeRequirement = useCallback((sIndex: number, rIndex: number) => {
    setCatalog((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => {
        if (i !== sIndex) return s;
        return { ...s, requirements: s.requirements.filter((_, ri) => ri !== rIndex) };
      }),
    }));
  }, []);

  const mapRequirement = useCallback(
    (sIndex: number, rIndex: number, fn: (r: Requirement) => Requirement) => {
      setCatalog((prev) => ({
        ...prev,
        services: prev.services.map((s, i) =>
          i === sIndex
            ? { ...s, requirements: s.requirements.map((r, ri) => (ri === rIndex ? fn(r) : r)) }
            : s,
        ),
      }));
    },
    [],
  );

  const addOption = useCallback(
    (sIndex: number, rIndex: number) => {
      mapRequirement(sIndex, rIndex, (r) =>
        r.options.length >= MAX_OPTIONS_PER_REQUIREMENT
          ? r
          : { ...r, options: [...r.options, { id: newOptionId(r.options), label: '', price: 0, quantity: 1 }] },
      );
    },
    [mapRequirement],
  );

  const updateOption = useCallback(
    (sIndex: number, rIndex: number, oIndex: number, patch: Partial<RequirementOption>) => {
      mapRequirement(sIndex, rIndex, (r) => ({
        ...r,
        options: r.options.map((o, oi) => (oi === oIndex ? { ...o, ...patch } : o)),
      }));
    },
    [mapRequirement],
  );

  const removeOption = useCallback(
    (sIndex: number, rIndex: number, oIndex: number) => {
      mapRequirement(sIndex, rIndex, (r) => ({ ...r, options: r.options.filter((_, oi) => oi !== oIndex) }));
    },
    [mapRequirement],
  );

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
          id: s.id,
          name: s.name.trim(),
          description: s.description.trim(),
          requirements: s.requirements.map((r) => ({
            id: r.id,
            label: r.label.trim(),
            question: r.question.trim(),
            type: r.type,
            quantity_mode: r.quantity_mode,
            unit_label: (r.unit_label || 'unit').trim() || 'unit',
            price: Number(r.price) || 0,
            quantity: Math.max(1, Math.floor(Number(r.quantity) || 1)),
            options:
              r.type === 'choice'
                ? r.options.map((o) => ({
                    id: o.id,
                    label: o.label.trim(),
                    price: Number(o.price) || 0,
                    quantity: Math.max(1, Math.floor(Number(o.quantity) || 1)),
                  }))
                : [],
          })),
        })),
      };
      for (const s of cleaned.services) {
        if (!s.name) throw new Error('Every service needs a name.');
        for (const r of s.requirements) {
          if (!r.label) throw new Error(`"${s.name}" has a requirement with no name.`);
          if (r.type === 'choice') {
            if (r.options.length === 0) {
              throw new Error(`"${s.name}" → "${r.label}" is a choice and needs at least one option.`);
            }
            for (const o of r.options) {
              if (!o.label) throw new Error(`"${s.name}" → "${r.label}" has an option with no name.`);
              if (o.price < 0) throw new Error(`"${s.name}" → "${r.label}" → "${o.label}" has a negative price.`);
            }
          } else if (r.price < 0) {
            throw new Error(`"${s.name}" → "${r.label}" has a negative price.`);
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
        description="Define the services this bot can quote for. Each service is a set of priced requirements — the visitor picks a service, checks which requirements they need, and the bot returns a live estimate."
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
            All requirement prices are stored and quoted in this currency.
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
                what="A service is a named group the visitor picks from. Its price comes from the requirements you add inside it."
                example="Web agency: Landing page design · SEO · Branding. SaaS: Onboarding · Migration · Training."
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
                const itemsSubtotal = serviceItemsSubtotal(service);
                const hasItems = service.requirements.some((r) => r.type === 'item');
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
                            {service.requirements.length} requirement{service.requirements.length === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      {hasItems && (
                        <span className="shrink-0 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                          {formatMoney(catalog.currency, itemsSubtotal)}
                        </span>
                      )}
                    </button>

                    {expanded && (
                      <div className="space-y-4 border-t border-[var(--ds-border)] p-3">
                        <div className="space-y-1">
                          <label className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-subtle)]">
                            Service name
                            <Hint
                              what="What the visitor sees in the service picker card. Keep it short and unambiguous."
                              example="Landing page design · SEO · Branding · Backend development"
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
                            Short description (optional)
                            <Hint
                              what="One-line explainer shown under the service name in the visitor's picker. Optional."
                              example="'Custom-designed responsive landing page' · 'On-page + technical SEO'"
                            />
                          </label>
                          <Input
                            value={service.description}
                            onChange={(event) => updateService(sIndex, { description: event.target.value })}
                            placeholder="One line shown to the visitor while quoting."
                            disabled={saving}
                          />
                        </div>

                        {/* Priced requirements */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text)]">
                              Requirements
                              <Hint
                                what="The priced line items inside this service. The visitor checks the ones they want; each adds its price × quantity to the quote."
                                example="Landing page → 'Hero section' @ 8000 ×1, 'Extra content page' @ 2000 ×3, 'Contact form' @ 1500 ×1."
                              />
                            </p>
                            <p className="text-[11px] text-[var(--ds-text-subtle)]">
                              {service.requirements.length} / {MAX_REQUIREMENTS_PER_SERVICE}
                            </p>
                          </div>
                          {service.requirements.length === 0 ? (
                            <p className="rounded-md border border-dashed border-[var(--ds-border)] p-3 text-[12px] text-[var(--ds-text-subtle)]">
                              No requirements yet. Add the priced items this service is made of.
                            </p>
                          ) : (
                            <div className="space-y-3">
                              {service.requirements.map((r, rIndex) => (
                                <div key={r.id} className="space-y-2 rounded-md bg-[var(--ds-bg-sunken)] p-3">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] uppercase tracking-wider text-[var(--ds-text-subtle)]">
                                      Requirement {rIndex + 1}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => removeRequirement(sIndex, rIndex)}
                                      className="inline-flex items-center gap-1 text-[12px] text-[var(--ds-danger)] hover:underline"
                                      disabled={saving}
                                    >
                                      <Trash2 size={12} /> Remove
                                    </button>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                      Question
                                      <Hint
                                        what="The prompt the visitor is asked for this requirement, on its own step. Leave blank to fall back to the name below."
                                        example="'Which tech stack do you prefer?' · 'Do you need a laptop?' · 'How much support?'"
                                      />
                                    </label>
                                    <Input
                                      value={r.question}
                                      onChange={(event) => updateRequirement(sIndex, rIndex, { question: event.target.value })}
                                      placeholder={r.type === 'choice' ? 'e.g. Which tech stack?' : 'e.g. Do you need a laptop?'}
                                      disabled={saving}
                                    />
                                  </div>
                                  <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
                                    <div className="space-y-1">
                                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                        Name on quote
                                        <Hint
                                          what="The short name that appears on the quote and PDF. For a choice it prefixes the picked option (e.g. 'Tech stack: Next.js')."
                                          example="Item: 'Laptop'. Choice: 'Tech stack' → 'Tech stack: Next.js'."
                                        />
                                      </label>
                                      <Input
                                        value={r.label}
                                        onChange={(event) => updateRequirement(sIndex, rIndex, { label: event.target.value })}
                                        placeholder={r.type === 'choice' ? 'e.g. Tech stack' : 'e.g. Laptop'}
                                        disabled={saving}
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                        Type
                                        <Hint
                                          what="Simple item = a tick-box the visitor turns on/off. Choice = a question with priced options; the visitor picks one."
                                          example="'CI/CD setup' → Simple item. 'Tech stack?' (Next.js/React) → Choice."
                                        />
                                      </label>
                                      <Select
                                        value={r.type}
                                        onChange={(value: string) => {
                                          const nextType = value as RequirementType;
                                          updateRequirement(sIndex, rIndex, {
                                            type: nextType,
                                            options:
                                              nextType === 'choice' && r.options.length === 0
                                                ? [{ id: 'o1', label: '', price: 0, quantity: 1 }]
                                                : r.options,
                                          });
                                        }}
                                        options={REQUIREMENT_TYPES}
                                      />
                                    </div>
                                  </div>

                                  {r.type === 'choice' ? (
                                    <div className="space-y-1.5 rounded-md bg-[var(--ds-bg-surface)] p-2">
                                      <div className="flex items-center justify-between">
                                        <p className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--ds-text-subtle)]">
                                          Options
                                          <Hint
                                            what="The priced answers the visitor picks ONE of. Each carries its own price."
                                            example="Tech stack? → Next.js @ 50000, React @ 40000."
                                          />
                                        </p>
                                        <p className="text-[11px] text-[var(--ds-text-subtle)]">
                                          {r.options.length} / {MAX_OPTIONS_PER_REQUIREMENT}
                                        </p>
                                      </div>
                                      {r.options.map((o, oIndex) => (
                                        <div
                                          key={o.id}
                                          className={`grid ${r.quantity_mode === 'fixed' ? 'grid-cols-[1fr_96px_64px_auto]' : 'grid-cols-[1fr_96px_auto]'} items-center gap-2`}
                                        >
                                          <Input
                                            value={o.label}
                                            onChange={(event) => updateOption(sIndex, rIndex, oIndex, { label: event.target.value })}
                                            placeholder={`Option ${oIndex + 1}`}
                                            disabled={saving}
                                          />
                                          <Input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={String(o.price)}
                                            onChange={(event) => updateOption(sIndex, rIndex, oIndex, { price: Number(event.target.value) || 0 })}
                                            placeholder="Price"
                                            disabled={saving}
                                          />
                                          {r.quantity_mode === 'fixed' && (
                                            <Input
                                              type="number"
                                              min="1"
                                              step="1"
                                              value={String(o.quantity)}
                                              onChange={(event) => updateOption(sIndex, rIndex, oIndex, { quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
                                              placeholder="Qty"
                                              disabled={saving}
                                            />
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => removeOption(sIndex, rIndex, oIndex)}
                                            aria-label={`Remove option ${oIndex + 1}`}
                                            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ds-text-subtle)] hover:bg-[var(--ds-bg-sunken)] hover:text-[var(--ds-danger)]"
                                            disabled={saving}
                                          >
                                            <X size={14} aria-hidden="true" />
                                          </button>
                                        </div>
                                      ))}
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => addOption(sIndex, rIndex)}
                                        disabled={saving || r.options.length >= MAX_OPTIONS_PER_REQUIREMENT}
                                      >
                                        <Plus size={12} aria-hidden="true" /> Add option
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="space-y-1">
                                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                        Price
                                        <Hint
                                          what="Cost of this item, in the currency at the top."
                                          example={`8000 per unit · ${formatNumber(5000)} for a laptop`}
                                        />
                                      </label>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={String(r.price)}
                                        onChange={(event) => updateRequirement(sIndex, rIndex, { price: Number(event.target.value) || 0 })}
                                        disabled={saving}
                                      />
                                    </div>
                                  )}

                                  {/* Quantity behaviour — applies to both types */}
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="space-y-1">
                                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                        Quantity
                                        <Hint
                                          what="No quantity = just the price (×1). Fixed = you set the number. Ask the visitor = they pick how many in the widget."
                                          example="Techstack → No quantity. Support months → Fixed 6. Laptop → Ask the visitor."
                                        />
                                      </label>
                                      <Select
                                        value={r.quantity_mode}
                                        onChange={(value: string) => updateRequirement(sIndex, rIndex, { quantity_mode: value as QtyMode })}
                                        options={REQUIREMENT_QTY_MODES}
                                      />
                                    </div>
                                    {r.quantity_mode !== 'none' && (
                                      <div className="space-y-1">
                                        <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                          Unit
                                          <Hint
                                            what="The word shown beside the quantity on the widget and quote (auto-pluralised)."
                                            example="unit · page · hour · month · laptop · seat"
                                          />
                                        </label>
                                        <Input
                                          value={r.unit_label}
                                          onChange={(event) => updateRequirement(sIndex, rIndex, { unit_label: event.target.value })}
                                          placeholder="unit"
                                          disabled={saving}
                                        />
                                      </div>
                                    )}
                                  </div>

                                  {r.quantity_mode === 'fixed' && r.type === 'item' && (
                                    <div className="space-y-1">
                                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                        Quantity (applied automatically)
                                      </label>
                                      <Input
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={String(r.quantity)}
                                        onChange={(event) => updateRequirement(sIndex, rIndex, { quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
                                        disabled={saving}
                                      />
                                    </div>
                                  )}
                                  {r.quantity_mode === 'ask' && (
                                    <div className="space-y-1">
                                      <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                                        Default quantity
                                        <Hint
                                          what="Pre-filled number the visitor sees on the stepper; they can change it (0 skips the item)."
                                          example="1 for a laptop · 3 for a typical page count"
                                        />
                                      </label>
                                      <Input
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={String(r.quantity)}
                                        onChange={(event) => updateRequirement(sIndex, rIndex, { quantity: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
                                        disabled={saving}
                                      />
                                    </div>
                                  )}
                                  {r.type === 'item' && r.quantity_mode !== 'ask' && (
                                    <p className="text-right text-[11px] text-[var(--ds-text-subtle)]">
                                      Line total:{' '}
                                      <span className="font-medium text-[var(--ds-text)]">
                                        {formatMoney(
                                          catalog.currency,
                                          (Number(r.price) || 0) * (r.quantity_mode === 'none' ? 1 : Number(r.quantity) || 0),
                                        )}
                                      </span>
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => addRequirement(sIndex)}
                            disabled={saving || service.requirements.length >= MAX_REQUIREMENTS_PER_SERVICE}
                          >
                            <Plus size={12} aria-hidden="true" /> Add requirement
                          </Button>
                        </div>

                        <div className="flex items-center justify-between border-t border-[var(--ds-border)] pt-3">
                          <p className="text-[11px] text-[var(--ds-text-subtle)]">
                            {hasItems ? (
                              <>
                                Items subtotal:{' '}
                                <span className="text-[var(--ds-text)]">{formatMoney(catalog.currency, itemsSubtotal)}</span>
                                {service.requirements.some((r) => r.type === 'choice') && ' + choices'}
                              </>
                            ) : (
                              'Total depends on the options the visitor picks.'
                            )}
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
