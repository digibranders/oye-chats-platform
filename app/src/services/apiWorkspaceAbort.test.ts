import type { AxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';

/**
 * A workspace switch aborts every in-flight request for the workspace being
 * left. The one call that must survive it is the membership list the switch
 * itself triggers - see `getMyWorkspaces`.
 */
describe('getMyWorkspaces carries its own abort signal', () => {
  it('survives a workspace switch rotating the shared controller', async () => {
    const module = await import('./api');
    const seen: (AbortSignal | undefined)[] = [];
    const get = vi
      .spyOn(module.httpClient, 'get')
      .mockImplementation(async (_url: string, config?: AxiosRequestConfig) => {
        seen.push(config?.signal as AbortSignal | undefined);
        return { data: { workspaces: [] } };
      });

    try {
      await module.getMyWorkspaces();
      module.rotateWorkspaceAbort();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.aborted).toBe(false);
    } finally {
      get.mockRestore();
    }
  });
});
