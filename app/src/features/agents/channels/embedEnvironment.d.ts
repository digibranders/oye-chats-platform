import type { PlatformEnv } from '../../../data/platformIntegrations';

/** Select the install snippet source from the configured API endpoint. */
export function getEmbedEnvironment(apiBaseUrl: string): PlatformEnv;
