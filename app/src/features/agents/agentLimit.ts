
import { t as translateNow } from '../../i18n/i18n';
/**
 * The client-side mirror of the server's add-an-agent decision, so the create
 * flow can tell the user what it will cost BEFORE they fill in a form.
 *
 * The authority is `bot_routes.create_bot`, which refuses with a 402
 * (`must_subscribe`) when BOTH of these hold:
 *
 *   1. `plan_entitlements_service.can_client_add_new_bot` denies - it denies
 *      as soon as the account holds one active agent, because billing is
 *      per-agent: the first agent is free, every later one is funded by its
 *      own subscription.
 *   2. `_plan_bots_limit_allows` does not widen that - i.e. the plan's own
 *      `limits.bots` quota no longer covers the agents already on the account.
 *      Only the UNLIMITED sentinel (`-1`, Enterprise today) widens it; the
 *      other seeded plans declare `bots: 1`.
 *
 * The important consequence, and the reason this module returns a
 * three-state gate rather than a boolean "blocked": a 402 here is NOT a dead
 * end. It is a price. `CreateAgentDialog` answers it by advancing to a plan
 * picker and running the per-agent Razorpay checkout, which is how every
 * second and subsequent agent on the platform gets sold. So the UI must
 * announce the cost up front without ever removing the path to pay it.
 */

/** `limits.bots` sentinel for "no ceiling" - mirrors `plan_entitlements_service.UNLIMITED`. */
export const UNLIMITED_AGENTS = -1;

/**
 * Will `POST /bots` answer 402 `must_subscribe` for an account holding
 * `agentCount` agents on a plan whose included agent quota is `agentLimit`?
 *
 * Both server clauses are reproduced, in order:
 *  - fewer than one agent is always allowed, whatever the quota says (this is
 *    what stops a plan row with a missing/0 `bots` quota from being read as
 *    "you may not create your first agent");
 *  - an unlimited quota never blocks;
 *  - otherwise the quota is a ceiling on the count.
 *
 * Non-finite input is treated as "no evidence of a limit" and does not block:
 * the server is still the enforcer, and guessing wrong towards a paywall is
 * the more expensive mistake.
 */
export function isAtAgentLimit(agentCount: number, agentLimit: number): boolean {
  if (!Number.isFinite(agentCount) || agentCount < 1) return false;
  if (!Number.isFinite(agentLimit) || agentLimit === UNLIMITED_AGENTS) return false;
  return agentCount >= agentLimit;
}

/** What creating one more agent will take, resolved before the form opens. */
export type AgentCreationGate =
  /** The plan funds another agent outright - `POST /bots` will just create it. */
  | { readonly kind: 'included' }
  /**
   * The account is at its plan's agent quota. The agent can still be created,
   * but only with a subscription of its own - the server answers 402
   * `must_subscribe` and the dialog routes that to its plan picker.
   */
  | { readonly kind: 'requires_plan'; readonly agentCount: number; readonly agentLimit: number };

/**
 * Resolve the gate for an account holding `agentCount` agents under an
 * included quota of `agentLimit` (read from `useEntitlements().limitFor('bots')`).
 */
export function resolveAgentCreationGate(agentCount: number, agentLimit: number): AgentCreationGate {
  if (!isAtAgentLimit(agentCount, agentLimit)) return { kind: 'included' };
  return { kind: 'requires_plan', agentCount, agentLimit };
}

/**
 * The half of the notice that never varies - what the user is being told to
 * expect.
 *
 * One clause, because the plan step of `CreateAgentDialog` says the rest one
 * click later. It used to be a full sentence here AND the identical sentence as
 * that dialog's description, so the customer read it twice in two seconds.
 */
const PER_AGENT_BILLING = 'The next one needs its own plan.';

/**
 * One sentence explaining why the next agent is a paid one, for the notice
 * shown above the create form. Names the plan and its quota so the user can
 * check the claim against their own billing page.
 *
 * A quota below 1 is unreadable plan data (`limitFor` answers 0 for a missing
 * key), so the claim is dropped rather than rendered as "includes 0 agents" -
 * the per-agent billing sentence stands on its own and is still true.
 */
export function describeAgentLimit(gate: AgentCreationGate, planName: string): string | null {
  if (gate.kind !== 'requires_plan') return null;
  if (gate.agentLimit < 1) return PER_AGENT_BILLING;
  const plan = planName.trim() || translateNow('agents.yourPlan') || 'Your plan';
  const quota = gate.agentLimit === 1 ? '1 chatbot' : `${gate.agentLimit} chatbots`;
  return `${plan} includes ${quota}; you have ${gate.agentCount}. ${PER_AGENT_BILLING}`;
}
