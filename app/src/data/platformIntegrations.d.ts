/**
 * Type shim for the reused legacy platform-integration data
 * (`data/platformIntegrations.js`) - pure data/logic, reused as-is; the Deploy
 * UI is rebuilt fresh in TS on the new design system.
 */
export type PlatformEnv = 'production' | 'development';

export interface PlatformStep {
  title: string;
  description: string;
  code: string | null;
  language?: string;
}

export interface Platform {
  id: string;
  name: string;
  category: string;
  description: string;
  getSteps: (botKey: string, env: PlatformEnv) => PlatformStep[];
}

/** The widget bundle URL for an environment (shared by snippets + AI prompt). */
export function widgetScriptUrl(env: PlatformEnv): string;

export const platforms: Platform[];
export const categoryLabels: Record<string, string>;
export const categoryOrder: string[];
