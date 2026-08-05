import { LAUNCH_STEPS, LAUNCH_PROGRESS_KEY } from './steps.config';

/**
 * Launch Studio re-entry.
 *
 * Launch Studio is a one-time flow, but "one-time" was implemented as
 * "one-way": its only entry point was the Home empty state, which renders only
 * while the workspace has zero agents. Since the flow creates the agent at step
 * 2, closing the studio at any later step removed the only door back in - the
 * saved progress below sat in localStorage with nothing able to read it.
 *
 * These helpers let any "setup incomplete" surface offer a way back to exactly
 * where the user stopped.
 */

/** Furthest step index the user reached, clamped to the real step range. */
function readProgressIndex(): number {
  if (typeof localStorage === 'undefined') return 0;
  const raw = Number(localStorage.getItem(LAUNCH_PROGRESS_KEY) ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(Math.floor(raw), LAUNCH_STEPS.length - 1));
}

/**
 * The route that resumes onboarding where the user left off.
 *
 * Falls back to the first step when there's no saved progress - a user who
 * onboarded in another browser (or cleared storage) still gets a working door
 * rather than a dead one. Launch Studio's own forward-gating means a returning
 * user can never be dropped past a step they haven't reached.
 */
export function resumeLaunchPath(): string {
  return `/launch/${LAUNCH_STEPS[readProgressIndex()].path}`;
}

/** True when saved progress exists, i.e. the user started but didn't finish. */
export function hasLaunchProgress(): boolean {
  return readProgressIndex() > 0;
}
