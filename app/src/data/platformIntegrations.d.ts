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

export const platforms: Platform[];
export const categoryLabels: Record<string, string>;
export const categoryOrder: string[];
