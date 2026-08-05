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
 * where the user stopped, against the agent the onboarding was actually for.
 *
 * Progress is stored as a scoped record rather than a bare step index. A bare
 * index answers "how far did someone get?" but not "for which agent, in which
 * workspace?" - and every Launch Studio step writes through
 * `BotContext.selectedBot`, which is the shell switcher's scope and is
 * deliberately NOT synced to the URL. Without the scope, "Resume setup" on
 * agent 9's page resumed onboarding against whichever agent the switcher
 * happened to hold, renaming and re-crawling a healthy production agent; and
 * the key survived logout, so a second account on the same browser inherited
 * the first account's progress.
 */

/** Shape persisted under `LAUNCH_PROGRESS_KEY`. */
export interface LaunchProgress {
  /** Schema version, so a future shape change can be detected, not misread. */
  readonly v: 1;
  /** Workspace (Bot.client_id) the onboarding belongs to. */
  readonly workspaceId: number;
  /** Agent created at step 2; null before it exists. */
  readonly botId: number | null;
  /** Furthest step index reached. */
  readonly step: number;
}

const MAX_INDEX = LAUNCH_STEPS.length - 1;

function clampStep(value: unknown): number {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(Math.floor(raw), MAX_INDEX));
}

function toPositiveIdOrNull(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

/**
 * Read the saved record, or `null` when there is none / it is unreadable.
 *
 * Tolerates the pre-scope format (a bare number) by discarding it: that value
 * carries no workspace, so honouring it is exactly the cross-account and
 * wrong-agent resume this scoping exists to prevent. The user loses nothing
 * but a shortcut - Launch Studio itself is still reachable.
 */
export function readLaunchProgress(): LaunchProgress | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAUNCH_PROGRESS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Partial<LaunchProgress>;
  const workspaceId = toPositiveIdOrNull(record.workspaceId);
  if (record.v !== 1 || workspaceId === null) return null;

  return {
    v: 1,
    workspaceId,
    botId: toPositiveIdOrNull(record.botId),
    step: clampStep(record.step),
  };
}

/** Persist progress for one workspace + agent. Best-effort. */
export function writeLaunchProgress(
  workspaceId: number | null | undefined,
  botId: number | null | undefined,
  step: number,
): void {
  if (typeof localStorage === 'undefined') return;
  const scopedWorkspaceId = toPositiveIdOrNull(workspaceId);
  // Without a workspace the record cannot be safely scoped, so it is not
  // written at all - better no shortcut than one that resumes into another
  // account's data.
  if (scopedWorkspaceId === null) return;
  const record: LaunchProgress = {
    v: 1,
    workspaceId: scopedWorkspaceId,
    botId: toPositiveIdOrNull(botId),
    step: clampStep(step),
  };
  try {
    localStorage.setItem(LAUNCH_PROGRESS_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable or full - progress is a convenience, not state */
  }
}

/** Drop saved progress (onboarding finished, or abandoned deliberately). */
export function clearLaunchProgress(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LAUNCH_PROGRESS_KEY);
  } catch {
    /* localStorage unavailable - ignore */
  }
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
  const progress = readLaunchProgress();
  return `/launch/${LAUNCH_STEPS[progress ? progress.step : 0].path}`;
}

/**
 * True when this workspace has resumable progress - i.e. the user started but
 * didn't finish, in THIS workspace.
 *
 * `botId` narrows it further to progress for one specific agent, which is what
 * an agent-scoped surface (an agent's Overview hero) must pass: offering
 * "Resume setup" there for onboarding that belongs to a different agent is how
 * a support session ends up renaming the wrong one.
 */
export function hasLaunchProgress(
  workspaceId: number | null | undefined,
  botId?: number | null,
): boolean {
  const progress = readLaunchProgress();
  if (!progress || progress.step <= 0) return false;
  if (toPositiveIdOrNull(workspaceId) !== progress.workspaceId) return false;
  if (botId !== undefined && toPositiveIdOrNull(botId) !== progress.botId) return false;
  return true;
}
