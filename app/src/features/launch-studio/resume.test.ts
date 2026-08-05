import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLaunchProgress,
  hasLaunchProgress,
  readLaunchProgress,
  resumeLaunchPath,
  writeLaunchProgress,
} from './resume';
import { LAUNCH_STEPS, LAUNCH_PROGRESS_KEY } from './steps.config';

/**
 * The reported bug: "Resume setup" on agent 9's Overview resumed onboarding
 * against agent 3 - the shell switcher's `selectedBot`, which Launch Studio's
 * steps write through and which is deliberately not synced to the URL. The
 * saved progress was a bare step index, so it could not say which agent (or
 * which account) it belonged to. These tests pin the scoping that fixes it.
 */

const LAST_INDEX = LAUNCH_STEPS.length - 1;

beforeEach(() => {
  localStorage.clear();
});

describe('writeLaunchProgress / readLaunchProgress', () => {
  it('round-trips a scoped record', () => {
    writeLaunchProgress(7, 42, 3);

    expect(readLaunchProgress()).toEqual({ v: 1, workspaceId: 7, botId: 42, step: 3 });
  });

  it('stores a null botId for progress made before the agent exists', () => {
    writeLaunchProgress(7, null, 1);

    expect(readLaunchProgress()?.botId).toBeNull();
  });

  it('refuses to persist progress it cannot scope to a workspace', () => {
    writeLaunchProgress(null, 42, 3);

    expect(localStorage.getItem(LAUNCH_PROGRESS_KEY)).toBeNull();
  });

  it('clamps a step beyond the real range', () => {
    writeLaunchProgress(7, 42, 999);

    expect(readLaunchProgress()?.step).toBe(LAST_INDEX);
  });

  it('clamps a negative or non-finite step to zero', () => {
    writeLaunchProgress(7, 42, -5);
    expect(readLaunchProgress()?.step).toBe(0);

    writeLaunchProgress(7, 42, Number.NaN);
    expect(readLaunchProgress()?.step).toBe(0);
  });

  it('discards the legacy bare-index format', () => {
    // Pre-scope shape: a plain number, carrying no workspace or agent. Honouring
    // it is exactly the cross-account / wrong-agent resume this scoping prevents.
    localStorage.setItem(LAUNCH_PROGRESS_KEY, '4');

    expect(readLaunchProgress()).toBeNull();
  });

  it('survives corrupt or foreign JSON', () => {
    for (const raw of ['{not json', 'null', '"a string"', '{"v":2,"workspaceId":7}', '{"step":3}']) {
      localStorage.setItem(LAUNCH_PROGRESS_KEY, raw);
      expect(readLaunchProgress()).toBeNull();
    }
  });

  it('clears the record', () => {
    writeLaunchProgress(7, 42, 3);
    clearLaunchProgress();

    expect(readLaunchProgress()).toBeNull();
  });
});

describe('hasLaunchProgress', () => {
  it('is true for unfinished progress in the same workspace', () => {
    writeLaunchProgress(7, 42, 3);

    expect(hasLaunchProgress(7)).toBe(true);
  });

  it('is false in a different workspace', () => {
    // A second account on a shared browser must not inherit the first's progress.
    writeLaunchProgress(7, 42, 3);

    expect(hasLaunchProgress(8)).toBe(false);
  });

  it('is false when there is no progress at all', () => {
    expect(hasLaunchProgress(7)).toBe(false);
  });

  it('is false at step 0 - started but nothing to resume', () => {
    writeLaunchProgress(7, null, 0);

    expect(hasLaunchProgress(7)).toBe(false);
  });

  it('narrows to one agent when a botId is given', () => {
    writeLaunchProgress(7, 42, 3);

    expect(hasLaunchProgress(7, 42)).toBe(true);
    // THE BUG: agent 9's page must not offer to resume agent 42's onboarding,
    // because the steps would write to whichever agent the switcher holds.
    expect(hasLaunchProgress(7, 9)).toBe(false);
  });

  it('does not match an agent-scoped ask when the agent does not exist yet', () => {
    writeLaunchProgress(7, null, 1);

    expect(hasLaunchProgress(7, 42)).toBe(false);
    // Workspace-scoped asks still see it: the Agents page shortcut stays valid.
    expect(hasLaunchProgress(7)).toBe(true);
  });
});

describe('resumeLaunchPath', () => {
  it('returns the saved step', () => {
    writeLaunchProgress(7, 42, 2);

    expect(resumeLaunchPath()).toBe(`/launch/${LAUNCH_STEPS[2].path}`);
  });

  it('falls back to the first step with no saved progress', () => {
    expect(resumeLaunchPath()).toBe(`/launch/${LAUNCH_STEPS[0].path}`);
  });
});
