import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMyOperatorStatus: vi.fn(),
  toggleOperatorStatus: vi.fn(),
}));
vi.mock('../../services/api', () => api);

import { useOperatorStatus } from './useOperatorStatus';

/**
 * Going on duty on arrival, and the two cases where it must not.
 *
 * Opening the inbox is the act of sitting down at it, so the operator should
 * not also have to find a switch. What makes that safe rather than pushy is
 * that it fires once per visit: an operator who switches themselves off is off
 * until they come back, and the window-focus reload that this hook also does
 * must never quietly put them back on duty.
 */
describe('useOperatorStatus, arriving at the inbox', () => {
  beforeEach(() => {
    api.getMyOperatorStatus.mockReset();
    api.toggleOperatorStatus.mockReset();
    api.toggleOperatorStatus.mockResolvedValue({});
  });

  it('goes on duty when the operator arrives off duty', async () => {
    api.getMyOperatorStatus.mockResolvedValue({ operator_id: 3, is_online: false });

    const { result } = renderHook(() => useOperatorStatus(1, { enableOnMount: true }));

    await waitFor(() => expect(result.current.isOnline).toBe(true));
    expect(api.toggleOperatorStatus).toHaveBeenCalledWith({ isOnline: true, botId: 1 });
    expect(api.toggleOperatorStatus).toHaveBeenCalledTimes(1);
  });

  it('leaves an operator who is already on duty alone', async () => {
    api.getMyOperatorStatus.mockResolvedValue({ operator_id: 3, is_online: true });

    const { result } = renderHook(() => useOperatorStatus(1, { enableOnMount: true }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isOnline).toBe(true);
    expect(api.toggleOperatorStatus).not.toHaveBeenCalled();
  });

  it('does not put someone on duty who is not an operator here', async () => {
    // The backend answers with no operator id for a workspace member who was
    // never added to live chat. Flipping them online would fail anyway; asking
    // is the part that must not happen.
    api.getMyOperatorStatus.mockResolvedValue(null);

    const { result } = renderHook(() => useOperatorStatus(1, { enableOnMount: true }));

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(api.toggleOperatorStatus).not.toHaveBeenCalled();
  });

  it('does not re-enable an operator who switched themselves off', async () => {
    // The guard is spent on arrival, so the deliberate "off" below survives —
    // including across the reload this hook runs on every window focus.
    api.getMyOperatorStatus.mockResolvedValue({ operator_id: 3, is_online: false });

    const { result } = renderHook(() => useOperatorStatus(1, { enableOnMount: true }));
    await waitFor(() => expect(result.current.isOnline).toBe(true));

    await result.current.toggle();
    await waitFor(() => expect(result.current.isOnline).toBe(false));

    // Once to go on duty, once for the operator's own switch-off. No third.
    expect(api.toggleOperatorStatus).toHaveBeenCalledTimes(2);
    expect(api.toggleOperatorStatus).toHaveBeenLastCalledWith({ isOnline: false, botId: 1 });
  });

  it('stays passive without the option, which is every other caller', async () => {
    api.getMyOperatorStatus.mockResolvedValue({ operator_id: 3, is_online: false });

    const { result } = renderHook(() => useOperatorStatus(1));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isOnline).toBe(false);
    expect(api.toggleOperatorStatus).not.toHaveBeenCalled();
  });
});
