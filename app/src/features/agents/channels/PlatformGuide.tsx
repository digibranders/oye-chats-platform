import { useMemo } from 'react';
import { CodeBlock, Combobox, EmptyState, Field, Skeleton, type ComboboxOption } from '../../../ui';
import {
  categoryLabels,
  categoryOrder,
  platforms,
  type Platform,
  type PlatformEnv,
} from '../../../data/platformIntegrations';

export interface PlatformGuideProps {
  botKey: string;
  env: PlatformEnv;
  platformId: string | null;
  onPlatformChange: (id: string | null) => void;
  attribution: boolean;
  /** Entitlements have not resolved, so the steps could quote the wrong snippet. */
  resolving: boolean;
}

/** The picker's options, grouped by category the way the data module orders them. */
function platformOptions(): ComboboxOption<string>[] {
  const ordered = [...platforms].sort(
    (a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category),
  );
  return ordered.map((platform) => ({
    value: platform.id,
    label: platform.name,
    description: platform.description,
    // The category is searchable without taking a third line on every row:
    // typing "cms" or "builder" finds the right group.
    keywords: `${categoryLabels[platform.category] ?? platform.category} ${platform.category}`,
  }));
}

/**
 * Step-by-step install instructions for the stack the customer actually runs.
 *
 * A searchable single-select rather than a fifteen-tile logo grid. The grid it
 * replaces was a wall of third-party brand marks that had to be scanned
 * visually, was three screens tall on a phone, and had no keyboard path worth
 * the name — while the thing it selects is one value from a known list, which is
 * what a combobox is for. Typing three letters beats hunting for a logo.
 *
 * The steps themselves come straight from `data/platformIntegrations`, the same
 * module that feeds the coding-agent prompt and the developer email, so the
 * three can never drift into telling one customer three different things.
 *
 * It draws no card of its own: it is a tab panel on Deploy, and the panel
 * supplies the card. It used to be a fourth full-width card on a page of
 * eight.
 */
export function PlatformGuide({
  botKey,
  env,
  platformId,
  onPlatformChange,
  attribution,
  resolving,
}: PlatformGuideProps) {
  const options = useMemo(() => platformOptions(), []);
  const platform: Platform | null = platforms.find((p) => p.id === platformId) ?? null;
  const steps = platform && !resolving ? platform.getSteps(botKey, env, { attribution }) : [];

  return (
    <div className="space-y-5">
      <Field label="What is your website built on?" hint="Not sure? Pick HTML.">
        <Combobox
          options={options}
          value={platformId}
          onValueChange={onPlatformChange}
          label="Website platform"
          placeholder="Choose your platform…"
          searchPlaceholder="WordPress, Next.js, Shopify…"
          emptyMessage="No platform by that name. HTML works everywhere."
          className="max-w-sm"
        />
      </Field>

      {!platform ? (
        <EmptyState
          size="inline"
          flush
          title="Choose a platform to see the steps"
        />
      ) : resolving ? (
        <div aria-busy aria-label="Working out which snippet your plan needs" className="space-y-3">
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
      ) : (
        <ol className="space-y-5">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span
                aria-hidden
                className="figure flex h-6 w-6 shrink-0 items-center justify-center rounded-xs bg-surface-sunken text-2xs font-medium text-text-secondary"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium text-text-primary">{step.title}</p>
                <p className="mt-1 text-prose text-text-secondary">{step.description}</p>
                {step.code ? (
                  <CodeBlock
                    className="mt-2.5"
                    code={step.code}
                    label={`${platform.name} step ${index + 1}`}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
