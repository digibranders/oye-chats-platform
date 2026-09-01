import type { ThresholdKey } from './qualification.model';

/**
 * The Qualification surface's copy and catalog.
 *
 * Everything a customer needs in order to decide whether to trust the scoring,
 * kept out of the components so it can be read — and corrected — in one place.
 */

export interface FrameworkOption {
  readonly key: string;
  readonly label: string;
  /** One line on when to pick it. */
  readonly summary: string;
}

/**
 * The two frameworks the API will actually accept.
 *
 * `UpdateBotRequest.qualification_framework` is
 * `Literal["bant", "meddic"]` (api/app/api/bot_routes.py:467), so the four extra
 * options the previous picker offered — CHAMP, GPCTBA/CI and "Custom" — were a
 * 422 on save. The server *does* carry CHAMP and GPCTBA/CI presets, but nothing
 * can write those values, and `_framework_name` falls any unknown value back to
 * BANT at scoring time, so a bot that somehow stored one was being scored as
 * BANT regardless. Offering two things that work beats offering five where three
 * fail.
 *
 * "Custom" is not a framework here either: the whole scoring model below is
 * editable within both frameworks, and the config is stored wholesale, so
 * customising is what the dimensions editor is for.
 */
export const FRAMEWORK_OPTIONS: readonly FrameworkOption[] = [
  {
    key: 'bant',
    label: 'BANT',
    summary: 'Budget, Authority, Need, Timeline. Best for self-serve and mid-market.',
  },
  {
    key: 'meddic',
    label: 'MEDDIC',
    summary: 'Six dimensions. Built for enterprise cycles with a buying committee.',
  },
];

export function isSupportedFramework(key: string): boolean {
  return FRAMEWORK_OPTIONS.some((option) => option.key === key);
}

export function frameworkLabel(key: string): string {
  return FRAMEWORK_OPTIONS.find((option) => option.key === key)?.label ?? key.toUpperCase();
}

/**
 * What the AI is listening for, per dimension, in one line.
 *
 * This is the surface where a customer decides whether to trust the scoring, and
 * a dimension named "Economic buyer" with a weight box beside it explains
 * nothing. Keys match the server's preset dimension keys
 * (`PRESET_FRAMEWORKS` in api/app/services/qualification_service.py).
 */
export const DIMENSION_LISTENS_FOR: Readonly<Record<string, string>> = {
  // BANT
  need: 'How sharp the problem is: whether the visitor describes a live pain, a project underway, or idle curiosity.',
  timeline: 'When they intend to act: named dates, quarters, renewal deadlines, or "sometime".',
  authority: 'Their part in the decision: whether they buy, recommend, or are researching for someone else.',
  budget: 'Whether money exists and roughly how much: a stated range, an approved budget, or nothing yet.',
  // MEDDIC
  metrics: 'The numbers they want to move (revenue, cost, headcount, response time), and how specific they are.',
  economic_buyer: 'Whether the person who releases the money has been named, met, or not yet identified.',
  decision_criteria: 'What they say they will judge vendors on: features, security review, price, references.',
  decision_process: 'How the purchase actually happens: steps, approvals, procurement, legal, and who signs.',
  identify_pain: 'The cost of doing nothing: what breaks today and what it is costing them.',
  champion: 'Whether someone inside the account is advocating for a change, and how much sway they have.',
};

/** Falls back to a neutral line for a dimension the customer added themselves. */
export function listensFor(key: string): string {
  return (
    DIMENSION_LISTENS_FOR[key] ??
    'A dimension you added. The AI matches what the visitor says against the answers below and takes that answer’s score.'
  );
}

export interface TierMeta {
  readonly key: ThresholdKey;
  readonly label: string;
  readonly abbreviation: string;
  readonly meaning: string;
}

/** The three tiers, in ascending order. Below MQL a lead is "unqualified". */
export const TIERS: readonly TierMeta[] = [
  {
    key: 'mql',
    label: 'Marketing qualified',
    abbreviation: 'MQL',
    meaning: 'Enough interest to be worth marketing to.',
  },
  {
    key: 'sal',
    label: 'Sales accepted',
    abbreviation: 'SAL',
    meaning: 'Worth a salesperson’s time.',
  },
  {
    key: 'sql',
    label: 'Sales qualified',
    abbreviation: 'SQL',
    meaning: 'Ready for a real sales conversation.',
  },
];
