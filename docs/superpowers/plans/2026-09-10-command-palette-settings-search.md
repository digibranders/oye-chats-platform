# Command Palette Settings Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `⌘K` find a named setting ("Business Hours", "API Key", "Webhooks") the same way it already finds a page or a chatbot, and make its matching forgive query-word order.

**Architecture:** One new data file (`searchIndex.ts`) lists every settings-index entry, following `nav.ts`'s own established pattern exactly. One new pure function (`paletteFilter.ts`) wraps Base UI's own `contains` to test each query word independently instead of the whole query as one substring. `navCopy.ts` gains two translation resolvers matching its existing `navLabel`/`navHint` shape. `CommandPalette.tsx` wires all three into a new "Settings" group.

**Tech Stack:** React 19, TypeScript, `@base-ui/react/combobox`, Vitest, Testing Library.

Spec: `docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `app/src/shell/searchIndex.ts` | The 39-entry settings index (`WORKSPACE_SETTINGS`, `AGENT_SETTINGS`) and its types. |
| `app/src/shell/searchIndex.test.ts` | Shape (counts, no duplicate ids) and route-existence checks against `nav.ts`. |
| `app/src/shell/paletteFilter.ts` | `makePaletteFilter`: every query word must match, any order. |
| `app/src/shell/paletteFilter.test.ts` | Pure-function tests, no React. |
| `app/src/shell/navCopy.ts` | Modified: adds `settingLabel`, `settingHint`. |
| `app/src/shell/navCopy.test.ts` | New. Proves the key-construction contract via a mocked `t`. |
| `app/src/shell/CommandPalette.tsx` | Modified: wires the index and the filter into a new "Settings" group. |
| `app/src/shell/CommandPalette.test.tsx` | New. Integration tests against the rendered palette. |
| `app/src/i18n/locales/en.ts` | Modified: one new key, `shell.settings`. |
| `app/src/i18n/locales/hi.ts` | Modified: same key, Hindi. |
| `app/src/i18n/locales/ar.ts` | Modified: same key, Arabic. |

All commands below assume `cd app` from the repo root first, unless a command already starts with `cd app &&`.

---

## Task 1: The settings index

**Files:**
- Create: `app/src/shell/searchIndex.ts`
- Test: `app/src/shell/searchIndex.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/shell/searchIndex.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_NAV, NAV_SECTIONS } from './nav';
import { AGENT_SETTINGS, WORKSPACE_SETTINGS } from './searchIndex';

const VALID_SETTINGS_SEGMENTS = new Set(Object.keys(NAV_SECTIONS['/settings'] ?? {}));
const VALID_AGENT_SEGMENTS = new Set(AGENT_NAV.map((item) => item.segment));

describe('searchIndex shape', () => {
  it('has the launch-set counts the spec commits to', () => {
    expect(WORKSPACE_SETTINGS).toHaveLength(9);
    expect(AGENT_SETTINGS).toHaveLength(30);
  });

  it('has no duplicate ids within either array', () => {
    const workspaceIds = WORKSPACE_SETTINGS.map((item) => item.id);
    const agentIds = AGENT_SETTINGS.map((item) => item.id);
    expect(new Set(workspaceIds).size).toBe(workspaceIds.length);
    expect(new Set(agentIds).size).toBe(agentIds.length);
  });
});

/**
 * `WORKSPACE_SETTINGS.to` targets `/settings/<section>`, so the section must
 * be one `NAV_SECTIONS['/settings']` already names as a real route.
 * `AGENT_SETTINGS.segment` must be one `AGENT_NAV` already names as a real
 * chatbot tab. Both are the SAME canonical lists the rail itself is built
 * from, so a renamed or removed page fails this test rather than shipping a
 * dead palette result.
 */
describe('every indexed setting resolves to a route that actually exists', () => {
  it('every workspace setting points at a real /settings sub-route', () => {
    const offenders = WORKSPACE_SETTINGS.filter((item) => {
      const [path] = item.to.split('?');
      const segments = (path ?? '').split('/').filter(Boolean);
      return segments[0] !== 'settings' || !VALID_SETTINGS_SEGMENTS.has(segments[1] ?? '');
    }).map((item) => `${item.id} -> ${item.to}`);
    expect(offenders).toEqual([]);
  });

  it('every per-chatbot setting points at a real agent tab', () => {
    const offenders = AGENT_SETTINGS.filter((item) => !VALID_AGENT_SEGMENTS.has(item.segment)).map(
      (item) => `${item.id} -> ${item.segment}`,
    );
    expect(offenders).toEqual([]);
  });

  it('the guard can still fail, so it is worth having', () => {
    expect(VALID_SETTINGS_SEGMENTS.has('not-a-real-section')).toBe(false);
    expect(VALID_AGENT_SEGMENTS.has('not-a-real-tab')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails on the missing module**

```bash
cd app && npx vitest run src/shell/searchIndex.test.ts
```

Expected: fails with `Cannot find module './searchIndex'` (or equivalent resolution error) — the file does not exist yet.

- [ ] **Step 3: Write the index**

Create `app/src/shell/searchIndex.ts`:

```ts
/**
 * Things a customer can name, one level deeper than a page.
 *
 * `nav.ts` indexes destinations: pages and chatbots. This indexes what lives
 * INSIDE a destination: a specific, named setting a customer would type the
 * name of rather than browse to. "Business Hours" is the case that started
 * this file: it is a real field on every chatbot's Experience tab, and until
 * now the command palette had no way to know that word meant anything.
 *
 * Same rule `nav.ts` states for itself applies here: a setting missing from
 * this file is a setting the palette cannot find. See
 * docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md
 * for how this list was built (walked every settings page and every agent tab
 * once, pulling real section headings already in the product's own copy) and
 * what is deliberately not in it (anything reached only from inside a dialog,
 * which has no stable URL to land the palette on).
 */
import {
  Brain,
  Building2,
  Globe,
  Handshake,
  KeyRound,
  type LucideIcon,
  MessagesSquare,
  Plug,
  Receipt,
  Settings2,
  Target,
  Users,
  Webhook,
} from 'lucide-react';

export interface SettingItem {
  id: string;
  /** What the customer calls it. English is the lookup KEY here, exactly
   *  like `NavItem.label` in nav.ts — see `navCopy.ts`'s `settingLabel`. */
  label: string;
  /** One line, for the palette row. Same rule: a lookup key, not copy. */
  hint: string;
  icon: LucideIcon;
  /** Extra terms the filter matches but which are never rendered. English
   *  only in this pass; see the spec's "Translation" section for why. */
  keywords: string;
}

export interface WorkspaceSettingItem extends SettingItem {
  /** Static: the same URL for every workspace. */
  to: string;
}

export interface AgentSettingItem extends SettingItem {
  /** Appended to `/chatbots/:agentId`, exactly like `AgentNavItem.segment`. */
  segment: string;
}

export const WORKSPACE_SETTINGS: readonly WorkspaceSettingItem[] = [
  {
    id: 'workspace-name',
    label: 'Workspace Name',
    hint: 'What your account is called across the product',
    icon: Building2,
    to: '/settings/workspace',
    keywords: 'company name account name rename workspace',
  },
  {
    id: 'invite-teammate',
    label: 'Invite a Teammate',
    hint: 'Add someone to your team',
    icon: Users,
    to: '/settings/team?tab=invitations',
    keywords: 'invite team member add person pending invitation',
  },
  {
    id: 'departments',
    label: 'Departments',
    hint: 'Group operators so chats route to the right team',
    icon: Users,
    to: '/settings/team?tab=departments',
    keywords: 'department group routing operators team',
  },
  {
    id: 'queue-wait-time',
    label: 'Live Chat Queue and Wait Time',
    hint: 'What a visitor sees while they wait for your team',
    icon: Users,
    to: '/settings/team?tab=routing',
    keywords: 'queue wait time timeout routing live chat availability',
  },
  {
    id: 'api-key',
    label: 'API Key',
    hint: 'Your workspace credential, and how to rotate it',
    icon: KeyRound,
    to: '/settings/developers',
    keywords: 'api key secret token credential developer rotate',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    hint: 'Endpoints we notify when something happens',
    icon: Webhook,
    to: '/settings/integrations?tab=webhooks',
    keywords: 'webhook endpoint integration deliveries http post',
  },
  {
    id: 'email-notifications',
    label: 'Email Notifications',
    hint: 'Who hears about a chatbot by email',
    icon: Plug,
    to: '/settings/integrations?tab=email',
    keywords: 'email notification recipient routing alerts',
  },
  {
    id: 'meeting-booking',
    label: 'Meeting Booking',
    hint: 'Let the chatbot offer a time on your calendar',
    icon: Plug,
    to: '/settings/integrations?tab=meetings',
    keywords: 'meeting booking calendly zcal cal.com calendar schedule',
  },
  {
    id: 'affiliate',
    label: 'Affiliate Programme',
    hint: 'Earn credit for referrals',
    icon: Handshake,
    to: '/settings/affiliate',
    keywords: 'affiliate partner referral programme commission',
  },
];

export const AGENT_SETTINGS: readonly AgentSettingItem[] = [
  // ── Experience ────────────────────────────────────────────────────────
  {
    id: 'business-hours',
    label: 'Business Hours',
    hint: "When the chatbot's people are around",
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'availability online offline opening times staffed when someone is there',
  },
  {
    id: 'widget-colours',
    label: 'Widget Colours',
    hint: 'Your two brand colours on the chat window',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'colour color brand primary accent theme',
  },
  {
    id: 'chatbot-avatar',
    label: 'Chatbot Avatar',
    hint: 'The face of your chatbot',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'avatar face icon logo picture image',
  },
  {
    id: 'credit-line',
    label: 'Credit Line',
    hint: 'Show or hide the OyeChats mark in the chat window',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'branding remove credit line powered by whitelabel',
  },
  {
    id: 'language',
    label: 'Language',
    hint: 'What languages this chatbot speaks to visitors',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'language locale translate multilingual',
  },
  {
    id: 'talking-to-a-person',
    label: 'Talking to a Person',
    hint: 'What happens when the chatbot is not enough',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'handoff live chat escalate human operator talk to a person',
  },
  {
    id: 'pre-chat-form',
    label: 'Pre-chat Form',
    hint: 'What to ask before the chat starts',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'pre-chat form name email capture qualify before chat',
  },
  {
    id: 'chatbot-name',
    label: 'Chatbot Name',
    hint: 'What your chatbot is called',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'name title rename chatbot',
  },
  {
    id: 'greeting-message',
    label: 'Greeting Message',
    hint: 'The first thing a visitor reads',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'greeting welcome message first message',
  },
  {
    id: 'suggested-questions',
    label: 'Suggested Questions',
    hint: 'Questions a visitor can tap',
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'suggested questions quick replies chips prompts',
  },
  {
    id: 'widget-copy',
    label: 'Widget Copy',
    hint: "The rest of the widget's copy",
    icon: MessagesSquare,
    segment: 'experience',
    keywords: 'copy text wording labels widget messages',
  },
  // ── Behaviour ─────────────────────────────────────────────────────────
  {
    id: 'persona',
    label: 'Persona',
    hint: 'Who the chatbot says you are',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'persona identity who am i character',
  },
  {
    id: 'voice',
    label: 'Voice',
    hint: 'How it should sound',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'voice tone sound formal casual',
  },
  {
    id: 'scope',
    label: 'Scope',
    hint: 'What it is allowed to talk about',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'scope topics allowed restrict boundaries',
  },
  {
    id: 'smart-links',
    label: 'Smart Links',
    hint: 'Words the chatbot turns into links',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'smart links auto link hyperlink keywords',
  },
  {
    id: 'lead-enrichment',
    label: 'Lead Enrichment',
    hint: 'Extra signal collected about a visitor',
    icon: Settings2,
    segment: 'behaviour',
    keywords: 'lead enrichment ip company email verification',
  },
  // ── Qualification ─────────────────────────────────────────────────────
  {
    id: 'scoring-dimensions',
    label: 'Scoring Dimensions',
    hint: 'What this scoring has produced',
    icon: Target,
    segment: 'qualification',
    keywords: 'scoring dimensions bant meddic budget authority need timeline',
  },
  {
    id: 'tier-thresholds',
    label: 'Tier Thresholds',
    hint: 'The score to reach',
    icon: Target,
    segment: 'qualification',
    keywords: 'tier threshold score hot warm cold',
  },
  {
    id: 'tier-outcomes',
    label: 'Tier Outcomes',
    hint: 'What happens at each tier',
    icon: Target,
    segment: 'qualification',
    keywords: 'tier outcome action webhook notify',
  },
  {
    id: 'score-decay',
    label: 'Score Decay',
    hint: 'How a score fades over time',
    icon: Target,
    segment: 'qualification',
    keywords: 'score decay timing expiry stale',
  },
  {
    id: 'behavioural-points',
    label: 'Behavioural Points',
    hint: 'Points earned from what a visitor does',
    icon: Target,
    segment: 'qualification',
    keywords: 'behavioural points signals return visit page view',
  },
  // ── Quotation ─────────────────────────────────────────────────────────
  {
    id: 'currency',
    label: 'Currency',
    hint: 'What currency the chatbot quotes in',
    icon: Receipt,
    segment: 'quotation',
    keywords: 'currency inr usd price',
  },
  {
    id: 'quotation-timing',
    label: 'When to Send the Quotation',
    hint: 'How long after asking a visitor gets a quote',
    icon: Receipt,
    segment: 'quotation',
    keywords: 'quotation send delay timing document email',
  },
  {
    id: 'quotation-trigger',
    label: 'When to Offer a Quote',
    hint: 'What makes the chatbot offer to price something',
    icon: Receipt,
    segment: 'quotation',
    keywords: 'quotation trigger offer price when',
  },
  // ── Deploy ────────────────────────────────────────────────────────────
  {
    id: 'allowed-domains',
    label: 'Allowed Domains',
    hint: 'Which websites this chatbot may run on',
    icon: Globe,
    segment: 'deploy',
    keywords: 'allowed domains origin cors website embed restrict',
  },
  {
    id: 'demo-link',
    label: 'Demo Link',
    hint: 'Share a link instead of embedding',
    icon: Globe,
    segment: 'deploy',
    keywords: 'demo link share preview url',
  },
  {
    id: 'install-embed-code',
    label: 'Install / Embed Code',
    hint: 'The script tag to paste on your site',
    icon: Globe,
    segment: 'deploy',
    keywords: 'install embed code script tag snippet deploy',
  },
  // ── Knowledge ─────────────────────────────────────────────────────────
  {
    id: 'auto-retrain',
    label: 'Auto-retrain',
    hint: 'Keep this knowledge up to date',
    icon: Brain,
    segment: 'knowledge',
    keywords: 'auto retrain recrawl refresh schedule knowledge',
  },
  {
    id: 'sources',
    label: 'Sources',
    hint: 'The documents and pages this chatbot knows',
    icon: Brain,
    segment: 'knowledge',
    keywords: 'sources documents pages uploads crawl',
  },
  {
    id: 'knowledge-gaps',
    label: 'Knowledge Gaps',
    hint: 'Questions it could not answer',
    icon: Brain,
    segment: 'knowledge',
    keywords: 'knowledge gaps unanswered questions missing',
  },
];
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd app && npx vitest run src/shell/searchIndex.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd app && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell/searchIndex.ts app/src/shell/searchIndex.test.ts
git commit -m "feat(shell): index every named setting the command palette can find"
```

---

## Task 2: The palette filter

**Files:**
- Create: `app/src/shell/paletteFilter.ts`
- Test: `app/src/shell/paletteFilter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/shell/paletteFilter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makePaletteFilter } from './paletteFilter';

/**
 * Stands in for Base UI's real `contains`: case-insensitive, single
 * substring — close enough to its actual `Intl.Collator` behaviour to test
 * word-splitting in isolation from React and from Base UI itself.
 */
function stubContains(item: string, query: string): boolean {
  return item.toLowerCase().includes(query.toLowerCase());
}

describe('makePaletteFilter', () => {
  const filter = makePaletteFilter(stubContains);

  it('matches every word regardless of order', () => {
    expect(filter('Business Hours', 'hours business', undefined)).toBe(true);
  });

  it('still matches a plain substring, unchanged from before', () => {
    expect(filter('Business Hours', 'business hour', undefined)).toBe(true);
  });

  it('fails when one word is entirely absent', () => {
    expect(filter('Business Hours', 'business pricing', undefined)).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(filter('Business Hours', '', undefined)).toBe(true);
    expect(filter('Business Hours', '   ', undefined)).toBe(true);
  });

  it('collapses repeated whitespace between words', () => {
    expect(filter('Business Hours', 'business    hours', undefined)).toBe(true);
  });

  it('does not forgive a typo — no fuzzy matching, by design', () => {
    expect(filter('Business Hours', 'buisness hours', undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd app && npx vitest run src/shell/paletteFilter.test.ts
```

Expected: fails, `Cannot find module './paletteFilter'`.

- [ ] **Step 3: Write the filter**

Create `app/src/shell/paletteFilter.ts`:

```ts
import type { ComboboxFilter } from '@base-ui/react/combobox';

/**
 * Every word in the query has to appear somewhere in the item, in any order.
 *
 * Base UI's own default `contains` is a single whole-query substring scan
 * (read directly from `@base-ui/react/internals/filter.mjs`): one slice of
 * the query, tested once against one slice of the item's searchable text.
 * That means "hours business" would never match an item whose text reads
 * "...Business Hours...", only "business hours" would — and a command
 * palette is exactly the surface where a reader types the words in whatever
 * order they come to mind.
 *
 * This wraps the SAME `Intl.Collator`-backed `contains` Base UI already
 * computes (`Combobox.useFilter()`), so case-insensitivity and accent-folding
 * are unchanged, and applies it once per query word instead of once per
 * query. No typo tolerance: every word still has to be a real substring
 * somewhere. That is a deliberate, stated scope limit — see
 * docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md.
 */
export function makePaletteFilter<Item>(contains: ComboboxFilter['contains']) {
  return function paletteFilter(
    itemValue: Item,
    query: string,
    itemToString?: (item: Item) => string,
  ): boolean {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    return words.every((word) => contains(itemValue, word, itemToString));
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd app && npx vitest run src/shell/paletteFilter.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd app && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell/paletteFilter.ts app/src/shell/paletteFilter.test.ts
git commit -m "feat(shell): let a palette query match its words in any order"
```

---

## Task 3: Settings translation resolvers

**Files:**
- Modify: `app/src/shell/navCopy.ts`
- Test: `app/src/shell/navCopy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/shell/navCopy.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

/**
 * `settingLabel`/`settingHint` build a key from the label and ask `t()` for
 * it — the same contract `navLabel`/`navHint` already have. Mocking `t`
 * proves the KEY SHAPE is right (`app.setting.<crumbKey>` /
 * `setting.hint.<crumbKey>`) without needing any dictionary populated: none
 * is, by design — see the spec's "Translation, following the existing rule
 * exactly" section.
 */
vi.mock('../i18n/i18n', () => ({
  t: (key: string) => {
    if (key === 'app.setting.businessHours') return 'व्यापार के घंटे';
    if (key === 'setting.hint.businessHours') return 'जब आपकी टीम उपलब्ध हो';
    return null;
  },
}));

import { settingHint, settingLabel } from './navCopy';

describe('settingLabel', () => {
  it('resolves the key built from the label, in its own namespace', () => {
    expect(settingLabel('Business Hours')).toBe('व्यापार के घंटे');
  });

  it('falls back to the English label when nothing is translated yet', () => {
    expect(settingLabel('Something Nobody Translated')).toBe('Something Nobody Translated');
  });
});

describe('settingHint', () => {
  it('resolves the key built from the label, in its own namespace', () => {
    expect(settingHint('Business Hours', "When the chatbot's people are around")).toBe(
      'जब आपकी टीम उपलब्ध हो',
    );
  });

  it('falls back to the English hint when nothing is translated yet', () => {
    expect(settingHint('Something Nobody Translated', 'Fallback hint')).toBe('Fallback hint');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd app && npx vitest run src/shell/navCopy.test.ts
```

Expected: fails, `settingLabel`/`settingHint` are not exported from `./navCopy`.

- [ ] **Step 3: Add the resolvers**

In `app/src/shell/navCopy.ts`, append after `navHint`:

```ts

/**
 * A settings-index label, translated.
 *
 * Same rule as `navLabel`, applied one level deeper: `SettingItem.label` is a
 * module constant evaluated before any locale exists, so it is the lookup KEY
 * and the fallback, never copy translated in place. Its own namespace
 * (`app.setting.*`) keeps a settings label from colliding with a nav label
 * that happens to share the same English words.
 */
export function settingLabel(label: string): string {
  return translateNow(`app.setting.${crumbKey(label)}`) || label;
}

/** The one-line hint under a settings row, keyed off its label. */
export function settingHint(label: string, hint: string): string {
  return translateNow(`setting.hint.${crumbKey(label)}`) || hint;
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd app && npx vitest run src/shell/navCopy.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd app && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell/navCopy.ts app/src/shell/navCopy.test.ts
git commit -m "feat(shell): translate settings-index labels the same way nav labels already are"
```

---

## Task 4: Wire it into the palette

**Files:**
- Modify: `app/src/shell/CommandPalette.tsx`
- Modify: `app/src/i18n/locales/en.ts`
- Modify: `app/src/i18n/locales/hi.ts`
- Modify: `app/src/i18n/locales/ar.ts`
- Test: `app/src/shell/CommandPalette.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/shell/CommandPalette.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { useBotContext } from '../context/BotContext';
import { useWorkspace } from '../context/WorkspaceContext';
import type { Bot } from '../types/domain';

/**
 * The user's own report: "business hour" returned nothing, though Business
 * Hours is a real, named field on every chatbot. That was a coverage gap, not
 * a matching bug — see
 * docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md.
 * These tests pin the fix: the setting is findable by name, word order does
 * not matter, and picking it lands on the right chatbot's Experience tab.
 */

vi.mock('../context/BotContext', () => ({ useBotContext: vi.fn() }));
vi.mock('../context/WorkspaceContext', () => ({ useWorkspace: vi.fn() }));

// The palette persists its "recent" picks to REAL localStorage
// (CommandPalette.tsx's `rememberRecent`), and the global test setup
// (src/test/setup.ts) only unmounts between tests — it never clears storage.
// Without this, the "picking a result" tests below (which click a result,
// writing it to localStorage) would leak into "group placement", excluding
// that item from its group via CommandPalette's own `!recentIds.has(...)`
// filter and making the test's pass/fail depend on file order.
beforeEach(() => {
  localStorage.clear();
});

const BOTS: Bot[] = [
  { id: 1, name: 'Acme Support', bot_key: 'bot-acme' },
  { id: 2, name: 'Northwind Sales', bot_key: 'bot-northwind' },
];

const PLACEHOLDER = 'Jump to a chatbot or a page…';

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPalette({ bots = BOTS, isOperator = false }: { bots?: Bot[]; isOperator?: boolean } = {}) {
  vi.mocked(useBotContext).mockReturnValue({ bots } as ReturnType<typeof useBotContext>);
  vi.mocked(useWorkspace).mockReturnValue({ isOperator } as ReturnType<typeof useWorkspace>);
  return render(
    <MemoryRouter initialEntries={['/']}>
      <CommandPalette open onOpenChange={() => {}} />
      <Probe />
    </MemoryRouter>,
  );
}

describe('finding a setting by name', () => {
  it('finds Business Hours, which the palette could not find before this change', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');

    expect(screen.getByText('Settings')).toBeInTheDocument();
    // Two chatbots, so the setting is disambiguated per bot — the same
    // convention the existing per-bot tab rows already use.
    expect(screen.getByRole('option', { name: 'Acme Support — Business Hours' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Northwind Sales — Business Hours' }),
    ).toBeInTheDocument();
  });

  it('matches the query words in either order', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'hours business');

    expect(screen.getByRole('option', { name: 'Acme Support — Business Hours' })).toBeInTheDocument();
  });

  it('finds a workspace setting by its synonym, not only its literal label', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'rotate');

    expect(screen.getByRole('option', { name: 'API Key' })).toBeInTheDocument();
  });
});

describe('picking a result', () => {
  it('navigates to the exact chatbot and tab, including per-bot disambiguation', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');
    await user.click(screen.getByRole('option', { name: 'Northwind Sales — Business Hours' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/chatbots/2/experience');
  });

  it('navigates a workspace setting to its exact URL, including the tab query param', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'webhook');
    await user.click(screen.getByRole('option', { name: 'Webhooks' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/integrations?tab=webhooks');
  });
});

describe('a single chatbot', () => {
  it('still disambiguates by name, unchanged from how the existing tab rows already behave', async () => {
    renderPalette({ bots: [BOTS[0]!] });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');

    expect(screen.getByRole('option', { name: 'Acme Support — Business Hours' })).toBeInTheDocument();
  });
});

describe('an operator', () => {
  it('sees no Settings group — operators have no Settings destination at all', async () => {
    renderPalette({ isOperator: true });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');

    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByRole('option', { name: /business hours/i })).toBeNull();
  });
});

describe('group placement', () => {
  it('renders Settings after Chatbots, and Chatbots keeps its existing position', async () => {
    renderPalette();
    const user = userEvent.setup();
    // Broad enough to surface both a chatbot row and a settings row.
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'a');

    const chatbotsGroup = screen.getByRole('group', { name: 'Chatbots' });
    const settingsGroup = screen.getByRole('group', { name: 'Settings' });
    // eslint-disable-next-line no-bitwise -- DOM API returns a bitmask.
    expect(
      chatbotsGroup.compareDocumentPosition(settingsGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd app && npx vitest run src/shell/CommandPalette.test.tsx
```

Expected: fails. "Business Hours" is not found by any of these queries, because `CommandPalette.tsx` has not been wired to the index yet.

- [ ] **Step 3: Add the dictionary key**

In `app/src/i18n/locales/en.ts`, find (around line 689):

```ts
    sendFeedback: 'Send feedback',
    setupComplete: 'Setup complete',
```

Replace with:

```ts
    sendFeedback: 'Send feedback',
    settings: 'Settings',
    setupComplete: 'Setup complete',
```

In `app/src/i18n/locales/hi.ts`, find (around line 684):

```ts
    sendFeedback: 'प्रतिक्रिया भेजें',
    setupComplete: 'सेटअप पूरा',
```

Replace with:

```ts
    sendFeedback: 'प्रतिक्रिया भेजें',
    settings: 'सेटिंग्स',
    setupComplete: 'सेटअप पूरा',
```

In `app/src/i18n/locales/ar.ts`, find (around line 687):

```ts
    sendFeedback: "إرسال الملاحظات",
    setupComplete: "اكتمل الإعداد",
```

Replace with:

```ts
    sendFeedback: "إرسال الملاحظات",
    settings: "الإعدادات",
    setupComplete: "اكتمل الإعداد",
```

These are the SAME Hindi/Arabic words `app.crumb.settings` already uses for the rail's own Settings destination — reusing the existing translation, not inventing a new one.

- [ ] **Step 4: Run the i18n guard suite and confirm it passes**

```bash
cd app && npx vitest run src/i18n
```

Expected: `dictionary-parity.test.ts` and `keys-exist.test.ts` both pass (the new key exists in all three files with a real, non-English translation in `hi`/`ar`).

- [ ] **Step 5: Update the imports in `CommandPalette.tsx`**

In `app/src/shell/CommandPalette.tsx`, find:

```tsx
import { navHint, navLabel } from './navCopy';
import { useTranslation } from '../i18n/useTranslation';
import { Trans } from '../i18n/Trans';
```

Replace with:

```tsx
import { navHint, navLabel, settingHint, settingLabel } from './navCopy';
import { makePaletteFilter } from './paletteFilter';
import { AGENT_SETTINGS, WORKSPACE_SETTINGS } from './searchIndex';
import { useTranslation } from '../i18n/useTranslation';
import { Trans } from '../i18n/Trans';
```

- [ ] **Step 6: Add the filter hook and the settings commands**

Find:

```tsx
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(readRecent);

  const commands = useMemo<Command[]>(() => {
```

Replace with:

```tsx
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(readRecent);

  // Base UI's own default match is a single whole-query substring scan, so
  // "hours business" would not find an item whose text reads "...Business
  // Hours...". `makePaletteFilter` wraps the SAME Collator-backed `contains`
  // Base UI already computes and applies it once per query word instead of
  // once per query — see paletteFilter.ts.
  const coreFilter = BaseCombobox.useFilter();
  const filter = useMemo(() => makePaletteFilter(coreFilter.contains), [coreFilter]);

  const commands = useMemo<Command[]>(() => {
```

Find (the end of the existing `agents` block, immediately before the `return [...destinations, ...agents];` line):

```tsx
            ...AGENT_NAV.map((tab) => ({
              id: `agent:${bot.id}:${tab.segment}`,
              label: `${name} — ${navLabel(tab.label)}`,
              hint: navHint(tab.label, tab.hint),
              icon: tab.icon,
              to: agentPath(bot.id, tab.segment),
              keywords: `${name} ${tab.label} ${navLabel(tab.label)} ${bot.bot_key ?? ''}`,
            })),
          ];
        });

    return [...destinations, ...agents];
  }, [bots, isOperator, t]);
```

Replace with:

```tsx
            ...AGENT_NAV.map((tab) => ({
              id: `agent:${bot.id}:${tab.segment}`,
              label: `${name} — ${navLabel(tab.label)}`,
              hint: navHint(tab.label, tab.hint),
              icon: tab.icon,
              to: agentPath(bot.id, tab.segment),
              keywords: `${name} ${tab.label} ${navLabel(tab.label)} ${bot.bot_key ?? ''}`,
            })),
          ];
        });

    // Things a customer would type the NAME of rather than browse to —
    // Business Hours, an API key, a webhook — indexed one level deeper than a
    // destination. See searchIndex.ts. An operator has no Settings
    // destination at all today (`OPERATOR_PREFIXES` in nav.ts), so none of
    // this applies to them either.
    const settings: Command[] = isOperator
      ? []
      : [
          ...WORKSPACE_SETTINGS.map((item) => ({
            id: `setting:workspace:${item.id}`,
            label: settingLabel(item.label),
            hint: settingHint(item.label, item.hint),
            icon: item.icon,
            to: item.to,
            keywords: item.keywords,
          })),
          ...bots.flatMap((bot) => {
            const name = bot.name ?? `${navLabel((t('shell.chatbot') || 'Chatbot'))} ${bot.id}`;
            return AGENT_SETTINGS.map((item) => ({
              id: `setting:agent:${bot.id}:${item.id}`,
              label: `${name} — ${settingLabel(item.label)}`,
              hint: settingHint(item.label, item.hint),
              icon: item.icon,
              to: agentPath(bot.id, item.segment),
              keywords: `${name} ${item.keywords}`,
            }));
          }),
        ];

    return [...destinations, ...agents, ...settings];
  }, [bots, isOperator, t]);
```

- [ ] **Step 7: Add the Settings group**

Find:

```tsx
      {
        label: t('shell.chatbots') || 'Chatbots',
        items: commands.filter(
          (command) => command.id.startsWith('agent:') && !recentIds.has(command.id),
        ),
      },
    ].filter((group) => group.items.length > 0);
```

Replace with:

```tsx
      {
        label: t('shell.chatbots') || 'Chatbots',
        items: commands.filter(
          (command) => command.id.startsWith('agent:') && !recentIds.has(command.id),
        ),
      },
      // Appended last, deliberately: the two groups above keep their exact
      // existing order and behaviour — this is pure addition.
      {
        label: t('shell.settings') || 'Settings',
        items: commands.filter(
          (command) => command.id.startsWith('setting:') && !recentIds.has(command.id),
        ),
      },
    ].filter((group) => group.items.length > 0);
```

- [ ] **Step 8: Wire the filter prop**

Find:

```tsx
            itemToStringValue={(item) => `${item.label} ${item.hint} ${item.keywords ?? ''}`}
            onValueChange={run}
          >
```

Replace with:

```tsx
            itemToStringValue={(item) => `${item.label} ${item.hint} ${item.keywords ?? ''}`}
            filter={filter}
            onValueChange={run}
          >
```

- [ ] **Step 9: Run the test and confirm it passes**

```bash
cd app && npx vitest run src/shell/CommandPalette.test.tsx
```

Expected: all 7 tests pass.

- [ ] **Step 10: Typecheck and lint**

```bash
cd app && npx tsc --noEmit && npm run lint
```

Expected: no errors, no lint failures.

- [ ] **Step 11: Commit**

```bash
git add app/src/shell/CommandPalette.tsx app/src/shell/CommandPalette.test.tsx \
  app/src/i18n/locales/en.ts app/src/i18n/locales/hi.ts app/src/i18n/locales/ar.ts
git commit -m "feat(shell): the command palette can find a setting by name"
```

---

## Task 5: Full verification

- [ ] **Step 1: Full unit suite**

```bash
cd app && npx vitest run
```

Expected: all tests pass, including the four new files and the existing suite (nothing in `nav.ts` was modified, so no existing test should change behaviour).

- [ ] **Step 2: Lint and typecheck**

```bash
cd app && npm run lint && npx tsc --noEmit
```

Expected: both clean.

- [ ] **Step 3: Build**

```bash
cd app && npm run build
```

Expected: succeeds. This also catches any icon import (`KeyRound`, `Webhook`, `Handshake`) that does not actually exist in the installed `lucide-react` version.

- [ ] **Step 4: Browser suite**

This change touches `app/src/shell/`, which `app/CLAUDE.md` names as one of the surfaces that must run the Playwright suite, since jsdom cannot catch overlap, covered elements, or real popup/portal layout.

```bash
cd app && npx playwright install chromium && npm run e2e
```

Expected: the existing suite passes unchanged. No new Playwright spec is added in this plan — `CommandPalette.test.tsx` (Task 4) already exercises the rendered palette end-to-end at the Testing Library level, and this step is a regression check on everything else, not new coverage.

- [ ] **Step 5: Manual check in `/dev/ui` or the running app**

```bash
cd app && npm run dev
```

Open the dashboard, press `⌘K` (or `Ctrl+K`), type `business hour`, and confirm a "Settings" group appears with `Business Hours` rows, one per chatbot. Type `rotate` and confirm `API Key` appears. Type `hours business` (reversed) and confirm the same result still appears.

---

## Plan self-review

**Spec coverage:**
- Settings index, two categories, 39 entries → Task 1.
- Word-order-independent matching, no fuzzy/typo tolerance → Task 2.
- Translation following the existing `navLabel`/`navHint` pattern, `keywords` deliberately untranslated → Task 3.
- New "Settings" group after "Chatbots", icon inherited from the parent page, per-bot expansion identical to `AGENT_NAV`'s own convention → Task 4.
- Route-existence test against `nav.ts`'s own canonical lists → Task 1, Step 1.
- Out-of-scope items (records search, fuzzy typo tolerance, per-field scrolling, per-department hours) — none of them are implemented anywhere in this plan, confirmed by inspection.

**Type consistency:** `SettingItem`/`WorkspaceSettingItem`/`AgentSettingItem` (Task 1) are consumed in `CommandPalette.tsx` (Task 4) by field name only (`item.id`, `item.label`, `item.hint`, `item.icon`, `item.to`, `item.segment`, `item.keywords`) — every field read exists on the type as defined. `makePaletteFilter`'s signature (Task 2) matches the `filter` prop's exact type as verified against `@base-ui/react/combobox`'s own `.d.mts`. `settingLabel`/`settingHint` (Task 3) are called with `(item.label)` and `(item.label, item.hint)` respectively in Task 4, matching their defined signatures.

**No placeholders:** every step above contains complete file content or a complete diff; no step says "add appropriate X" without showing the X.
