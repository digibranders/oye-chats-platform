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

export type AttributionMode = 'html' | 'jsx' | 'manual';

export interface GetStepsOptions {
  /** Include the crawlable attribution anchor. Defaults to true. */
  attribution?: boolean;
}

export interface Platform {
  id: string;
  name: string;
  category: string;
  description: string;
  /** How this platform can host a server-rendered attribution anchor. */
  attributionMode: AttributionMode;
  getSteps: (botKey: string, env: PlatformEnv, options?: GetStepsOptions) => PlatformStep[];
}

/** The widget bundle URL for an environment (shared by snippets + AI prompt). */
export function widgetScriptUrl(env: PlatformEnv): string;

export const platforms: Platform[];
export const categoryLabels: Record<string, string>;
export const categoryOrder: string[];
