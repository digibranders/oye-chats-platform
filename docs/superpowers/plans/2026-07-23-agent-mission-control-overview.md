# Agent Mission Control Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the AI Agent Overview tab into a concise Mission Control dashboard that communicates lifecycle health, knowledge, live channels, experience, and seven-day performance without duplicating the detailed configuration tabs.

**Architecture:** Keep `OverviewPage` as the route-level composition layer. Extend its existing typed `useOverviewData` hook with the two analytics values the dashboard needs (resolution rate and rating) plus the complete bot record required for its optional brand-tone summary, then create small presentational overview cards that receive fully typed view models plus deep links into the existing Knowledge, Channels, Experience, and Analytics routes. The overview must never issue write requests, expose a destructive control, or display unavailable values as invented data.

**Tech Stack:** React 19, TypeScript strict mode, React Router, Tailwind CSS v4, Lucide React, existing OyeChats design-system primitives, ESLint, Vite.

## Global Constraints

- Scope all source changes to `oyechats-platform/app`; do not modify legacy JSX pages or backend endpoints.
- Retain the six existing `/agents/:agentId/<tab>` routes; summary-card actions must deep-link to those routes.
- Use only data returned by existing endpoints and the typed `Bot` model; use `—` only for unavailable analytics, never mock values.
- Extend shared interfaces instead of using local type assertions for API fields returned by the bot endpoints.
- Keep destructive actions in `AgentActionsMenu`; the overview contains no pause or delete action.
- Preserve all existing initial-loading, retry, cancellation, empty-state, and error-state behaviour.
- Add focused tests before production code. The app currently has no React test runner, so establish one once using Vitest and Testing Library; do not add any other dependencies.
- Final verification from `oyechats-platform/app`: `npm run lint`, `npx tsc --noEmit`, and `npm run build`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/src/types/domain.ts` | Adds optional API-backed creation and brand-tone fields to the shared bot contract. |
| `app/package.json` and `app/package-lock.json` | Adds the repository’s first React component test command and its pinned dev dependencies. |
| `app/vite.config.js` and `app/src/test/setup.ts` | Configures Vitest’s browser-like DOM and Testing Library matchers. |
| `app/src/features/agents/AgentCard.tsx` | Removes its local `created_at` widening and consumes the shared contract. |
| `app/src/features/agents/overview/overview-data.ts` | Fetches, parses, and exposes all overview analytics in a single typed, cancellation-safe hook. |
| `app/src/features/agents/overview/overview-data.test.ts` | Tests analytics parsing and overview data failure/partial-data semantics. |
| `app/src/features/agents/overview/AgentOverviewHero.tsx` | Renders the agent identity, lifecycle state, creation date, and navigation to Experience. |
| `app/src/features/agents/overview/AgentSnapshotCards.tsx` | Renders compact Knowledge, Channels, Experience, and Performance cards from explicit props. |
| `app/src/features/agents/overview/AgentSnapshotCards.test.tsx` | Verifies real-data display, unavailable metrics, and deep-link destinations. |
| `app/src/features/agents/overview/OverviewPage.tsx` | Composes the Mission Control layout and keeps existing skeleton/error/retry flows. |

## Task 0: Establish the app’s React test harness

**Files:**
- Modify: `app/package.json`
- Modify: `app/package-lock.json`
- Modify: `app/vite.config.js`
- Create: `app/src/test/setup.ts`

**Interfaces:**
- Consumes: Vite’s existing React configuration.
- Produces: `npm test` and `npm run test:watch`, both scoped to `src/**/*.{test,spec}.{ts,tsx}` and runnable in jsdom.

- [ ] **Step 1: Confirm the current lack of a component-test command**

Run: `npm run`

Expected: `lint`, `typecheck`, `build`, `dev`, and `preview` are present; no component-test command is defined.

- [ ] **Step 2: Add the minimal test dependencies and scripts**

From `app/`, run:

```bash
npm install --save-dev vitest @testing-library/react @testing-library/jest-dom jsdom
```

Add these scripts to `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Configure Vitest and the DOM test setup**

Change the Vite import to `import { defineConfig } from 'vitest/config'`, preserving the existing plugins, build, and server configuration. Add:

```ts
test: {
  environment: 'jsdom',
  setupFiles: './src/test/setup.ts',
  include: ['src/**/*.{test,spec}.{ts,tsx}'],
},
```

Create `app/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Add a smoke test and prove the runner works**

Create `app/src/test/smoke.test.ts`:

```ts
import { expect, test } from 'vitest';

test('test environment is configured', () => {
  expect(document.createElement('main')).toBeInstanceOf(HTMLElement);
});
```

Run: `npm test -- --runInBand`

Expected: Vitest completes with one passing test. If the installed Vitest version does not accept `--runInBand`, run `npm test`; do not add Jest flags.

- [ ] **Step 5: Commit the test harness**

```bash
git add app/package.json app/package-lock.json app/vite.config.js app/src/test/setup.ts app/src/test/smoke.test.ts
git commit -m "test(app): add React component test harness"
```

## Task 1: Correct the shared agent data boundary

**Files:**
- Modify: `app/src/types/domain.ts:30-42`
- Modify: `app/src/features/agents/AgentCard.tsx:17-47`
- Test: `app/src/features/agents/AgentCard.test.tsx`

**Interfaces:**
- Consumes: bot payloads declared by `services/api.d.ts`.
- Produces: `Bot.created_at?: string | null` and `Bot.brand_tone?: string | null`, available to every agent surface without a cast.

- [ ] **Step 1: Write the failing component test**

Create `app/src/features/agents/AgentCard.test.tsx` using the Task 0 React test utility. Render a `Bot` that includes `created_at: '2026-07-12T00:00:00.000Z'`, then assert the caption contains `Created Jul 12, 2026` and that an invalid creation string produces no `Created` caption.

```tsx
const bot: Bot = {
  id: 17,
  name: 'Support Concierge',
  created_at: '2026-07-12T00:00:00.000Z',
};

expect(screen.getByText('Created Jul 12, 2026')).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify it fails because `Bot` has no `created_at` property**

Run: `npm test -- src/features/agents/AgentCard.test.tsx`

Expected: TypeScript compilation fails at `created_at` until the shared interface is extended.

- [ ] **Step 3: Add the field to the single shared type and delete the local widening**

In `app/src/types/domain.ts`, add the field beside the other API timestamps:

```ts
export interface Bot {
  id: number;
  name: string;
  created_at?: string | null;
  brand_tone?: string | null;
  // existing fields unchanged
}
```

In `AgentCard.tsx`, delete `BotWithCreatedAt` and replace:

```ts
const created = formatCreatedDate((bot as BotWithCreatedAt).created_at);
```

with:

```ts
const created = formatCreatedDate(bot.created_at);
```

- [ ] **Step 4: Run the focused test and type check**

Run: `npm test -- src/features/agents/AgentCard.test.tsx && npx tsc --noEmit`

Expected: the caption cases pass and strict TypeScript reports no casts or errors.

- [ ] **Step 5: Commit the isolated contract correction**

```bash
git add app/src/types/domain.ts app/src/features/agents/AgentCard.tsx app/src/features/agents/AgentCard.test.tsx
git commit -m "fix(agents): type agent creation date"
```

## Task 2: Extend the overview query contract with honest performance values

**Files:**
- Modify: `app/src/features/agents/overview/overview-data.ts:1-156`
- Modify: `app/src/features/agents/overview/OverviewPage.tsx:22-205`
- Test: `app/src/features/agents/overview/overview-data.test.ts`

**Interfaces:**
- Consumes: `getBot`, `getDashboardStats`, `getActivityStats`, `getTopQuestions`, `getRatingsSummary`, and `getResolutionSummary` from `services/api`.
- Produces: `AgentStats` with `resolutionRate: number | null` and `averageRating: number | null`, plus `OverviewData.details: Bot | null`. The analytics values are null only when the backend has no rated answers or its optional summary cannot load; `details` is null only when the complete-record request cannot load.

- [ ] **Step 1: Write parser tests for present and unavailable ratings**

Mock the API functions and assert the hook model keeps `null` rather than coercing no-data ratings or resolution to zero, and that a complete-record failure does not discard loaded dashboard data:

```ts
expect(result.current.stats).toMatchObject({
  resolutionRate: null,
  averageRating: null,
});
expect(result.current.details).toBeNull();
```

Also test that a failing dashboard request produces `status: 'error'`, while a failing activity or questions request preserves a successful dashboard result and yields an empty list, matching the current behaviour.

- [ ] **Step 2: Run the focused test and verify the new contract fails**

Run: `npm test -- src/features/agents/overview/overview-data.test.ts`

Expected: failures because `resolutionRate` and `averageRating` do not yet exist.

- [ ] **Step 3: Extend `AgentStats` and fetch the two summary endpoints in the existing parallel request**

Add nullable fields to `AgentStats`:

```ts
readonly resolutionRate: number | null;
readonly averageRating: number | null;
```

Import `getBot`, `getRatingsSummary`, and `getResolutionSummary`, then extend the existing `Promise.all` with all three calls. Parse analytics with the established `parseRatingsSummary` and `parseResolutionSummary` helpers from `../analytics/analytics.types`; assign `ratings.avg` and `resolution.rate` to the new fields. Do not recreate loose-record parsing inside the overview hook.

Keep `getDashboardStats` as the critical request. Treat the complete-record request, activity, questions, ratings, and resolution as independently optional by applying the existing `.catch(() => [])` pattern with typed `null`/empty fallbacks. A failed secondary summary must result in `null`, not a misleading `0` or a failed whole overview.

- [ ] **Step 4: Use the expanded stats model in the existing metric grid**

Replace `totalMessages` and `Helpful answers` with `Resolution rate` and `Average rating`. Retain Active visitors and Conversations. This prevents two cards from presenting potentially overlapping answer-quality measures. Format nullable values as `—`.

```ts
format: (s) => (s.resolutionRate === null ? '—' : `${s.resolutionRate}%`),
```

- [ ] **Step 5: Run focused tests and the app type check**

Run: `npm test -- src/features/agents/overview/overview-data.test.ts && npx tsc --noEmit`

Expected: parser/loading/error assertions pass; TypeScript has no implicit `any` or unchecked nullable access.

- [ ] **Step 6: Commit the data-contract change**

```bash
git add app/src/features/agents/overview/overview-data.ts app/src/features/agents/overview/overview-data.test.ts app/src/features/agents/overview/OverviewPage.tsx
git commit -m "feat(agents): add overview performance summaries"
```

## Task 3: Build isolated, linkable Mission Control cards

**Files:**
- Create: `app/src/features/agents/overview/AgentOverviewHero.tsx`
- Create: `app/src/features/agents/overview/AgentSnapshotCards.tsx`
- Create: `app/src/features/agents/overview/AgentSnapshotCards.test.tsx`

**Interfaces:**
- Consumes: the resolved list `Bot`, optional complete-record `Bot`, `AgentHealth`, `AgentStats`, `ActivityPoint`, and a base URL of the form `/agents/${agent.id}`.
- Produces: `AgentOverviewHero` and `AgentSnapshotCards`, presentational components with no network requests and no local mutation state.

- [ ] **Step 1: Write rendering and navigation tests**

Render the cards with a trained, installed bot and real metrics. Assert the following accessible links:

```tsx
expect(screen.getByRole('link', { name: /manage knowledge/i })).toHaveAttribute(
  'href',
  '/agents/17/knowledge',
);
expect(screen.getByRole('link', { name: /manage channels/i })).toHaveAttribute(
  'href',
  '/agents/17/channels',
);
expect(screen.getByText('—')).toBeInTheDocument(); // no rating or resolution data
```

Test the knowledge states: training, failed, empty, and ready. Test that an uninstalled widget renders `Not installed` and its link targets Channels.

- [ ] **Step 2: Run the focused component test and verify it fails before implementation**

Run: `npm test -- src/features/agents/overview/AgentSnapshotCards.test.tsx`

Expected: module-not-found failure for the new components.

- [ ] **Step 3: Implement `AgentOverviewHero` as identity and lifecycle only**

Render the bot logo or name initial, agent name, lifecycle `StatusBadge`, website when present, and formatted creation date. Provide a single `Edit experience` `Link` to `${agentBasePath}/experience`. Reuse `deriveAgentHealth` output for status copy rather than duplicating lifecycle rules.

The component signature must stay data-only:

```ts
export interface AgentOverviewHeroProps {
  readonly agent: Bot;
  readonly health: AgentHealth;
  readonly agentBasePath: string;
}
```

- [ ] **Step 4: Implement `AgentSnapshotCards` as four summaries**

Create a responsive two-column grid using the existing `Card`, `StatusBadge`, `SectionHeader`, and `Link` patterns:

1. **Knowledge:** `indexed_chunk_count`, last training state, and a Knowledge link. Show `Training now`, `Needs attention`, `Not trained`, or `Ready` from `last_crawl_status` and chunk count.
2. **Channels:** website installation state and hostname/website when available, with a Channels link. Do not list WhatsApp, email, or other roadmap channels as live.
3. **Experience:** receive `details: Bot | null`; display `details.brand_tone` only when non-empty, otherwise render `Configured in Experience` with no invented tone. This card links to Experience.
4. **Performance:** resolution rate, average rating, and the existing `ActivityTrend` for message volume. This card links to Analytics. When an optional metric is null, display `—` and an accessible `No ratings yet` / `No resolved conversations yet` explanation.

Accept explicitly typed values; do not import API services or contexts inside either card.

- [ ] **Step 5: Run the component test and type check**

Run: `npm test -- src/features/agents/overview/AgentSnapshotCards.test.tsx && npx tsc --noEmit`

Expected: all states, deep links, and unavailable-metric behaviour pass.

- [ ] **Step 6: Commit the isolated presentation layer**

```bash
git add app/src/features/agents/overview/AgentOverviewHero.tsx app/src/features/agents/overview/AgentSnapshotCards.tsx app/src/features/agents/overview/AgentSnapshotCards.test.tsx
git commit -m "feat(agents): add mission control summary cards"
```

## Task 4: Compose the upgraded Overview page and preserve every state

**Files:**
- Modify: `app/src/features/agents/overview/OverviewPage.tsx:1-270`
- Test: `app/src/features/agents/overview/OverviewPage.test.tsx`

**Interfaces:**
- Consumes: `useAgent`, `deriveAgentHealth`, `useOverviewData`, `AgentOverviewHero`, and `AgentSnapshotCards`.
- Produces: the `/agents/:agentId/overview` Mission Control experience.

- [ ] **Step 1: Write page-state tests**

Mock `useAgent` and `useOverviewData`. Assert:

```tsx
expect(screen.getByRole('heading', { name: /support concierge/i })).toBeInTheDocument();
expect(screen.getByRole('link', { name: /manage knowledge/i })).toHaveAttribute(
  'href',
  '/agents/17/knowledge',
);
```

Add one test each for initial skeleton, critical overview-request failure with Retry, and a healthy overview with unavailable optional rating/resolution values.

- [ ] **Step 2: Run the focused page test and verify it fails**

Run: `npm test -- src/features/agents/overview/OverviewPage.test.tsx`

Expected: assertions fail until the new layout is composed.

- [ ] **Step 3: Replace the generic page header with Mission Control composition**

Within `OverviewContent`, retain the Refresh action and existing `HealthHero`. Place `AgentOverviewHero` first, then the health card, headline performance metrics, and `AgentSnapshotCards`. Keep `TopQuestions` below the summaries as the detailed behavioural signal.

The component hierarchy must be:

```tsx
<PageContainer title="Overview" actions={refreshAction}>
  <AgentOverviewHero agent={agent} health={health} agentBasePath={agentBasePath} />
  <HealthHero health={health} agentBasePath={agentBasePath} />
  <MetricGrid stats={stats} />
  <AgentSnapshotCards agent={agent} stats={stats} activity={activity} agentBasePath={agentBasePath} />
  <TopQuestions questions={questions} />
</PageContainer>
```

Do not remove `MetricsError`, `SectionUnavailable`, or the refresh button. On a primary stats failure, keep the existing retry surface and do not render partially fabricated performance cards.

- [ ] **Step 4: Adapt `OverviewSkeleton` to mirror the new information hierarchy**

Keep the new skeleton limited to structural blocks: identity header, health card, metric row, two-by-two cards, and top-questions card. Do not place a block Skeleton within text spans or metric-value slots.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- src/features/agents/overview/OverviewPage.test.tsx`

Expected: healthy, loading, error/retry, and null-metric cases pass.

- [ ] **Step 6: Commit the route-level composition**

```bash
git add app/src/features/agents/overview/OverviewPage.tsx app/src/features/agents/overview/OverviewPage.test.tsx
git commit -m "feat(agents): upgrade overview to mission control"
```

## Task 5: Validate accessibility, visual integrity, and production build

**Files:**
- Modify only if a verification finding requires it: files from Tasks 1–4.

**Interfaces:**
- Consumes: the completed overview route and existing design tokens.
- Produces: an accessible, responsive agent overview verified in the local app.

- [ ] **Step 1: Audit semantic and keyboard behaviour**

Verify that the hero uses one `h1` supplied by the agent shell; card headings are `h2`/`h3` in order; every action is a `Link` or `button`; status colour is paired with text; the activity chart retains its table-based accessible equivalent; and visible focus rings appear on all card links.

- [ ] **Step 2: Manually test the route in three real states**

Use a local development server and inspect `/agents/:agentId/overview` for:

1. a trained, widget-installed agent;
2. an untrained or training agent; and
3. a failed training agent.

At desktop and narrow/mobile widths, verify no card overflows, route links retain the agent ID, and the danger action remains absent from this page.

- [ ] **Step 3: Run project baseline checks from the touched app**

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all commands exit `0`. Fix any regression before proceeding.

- [ ] **Step 4: Review the final diff against the code-quality gate**

Confirm: no `any`; no local widening of shared API types; nullable analytics are rendered honestly; all endpoint requests are cancellation-safe; no destructive action is duplicated; keyboard focus is visible; and new state combinations are covered by tests.

- [ ] **Step 5: Commit verification-only adjustments, if any**

```bash
git add app/src/features/agents/overview app/src/features/agents/AgentCard.tsx app/src/types/domain.ts
git commit -m "fix(agents): polish mission control overview"
```

## Plan Self-Review

- **Spec coverage:** The plan covers the approved Mission Control hierarchy: agent identity, health, real knowledge and deployment status, honest analytics, deep links, responsive cards, and no danger-zone duplication.
- **Data integrity:** It relies on existing bot and analytics endpoints only. Values without a source are omitted or represented as unavailable; it does not claim WhatsApp/email live status or a region.
- **Type consistency:** `Bot.created_at`, `AgentStats.resolutionRate`, and `AgentStats.averageRating` are introduced before their consumers. All new props are explicit and readonly.
- **Scope:** It does not modify APIs, schemas, routes, or the configuration tabs; the upgrade remains a single independently shippable frontend feature.
