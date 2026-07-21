/**
 * Type shim for the legacy JS API client (`services/api.js`).
 * The `.js` stays the runtime source; this only supplies types to new TS code.
 * Only the exports the new app consumes are declared — widen as needed.
 */
import type {
  Bot,
  CrawlDiscovery,
  CurrentUser,
  KnowledgeSource,
  SourcePagesResult,
  Workspace,
} from '../types/domain';

export function createBot(data: { name: string; website?: string; system_prompt?: string }): Promise<Bot>;
export function updateBot(botId: number, data: Record<string, unknown>): Promise<Bot>;
export function getBot(botId: number): Promise<Bot>;
export function getBots(): Promise<Bot[]>;

export function discoverCrawlUrls(url: string, botId?: number): Promise<CrawlDiscovery>;
export function getDocuments(botId?: number): Promise<KnowledgeSource[]>;
export function getDocumentPages(source: string, botId?: number): Promise<SourcePagesResult>;

export function getSeedQuestions(botId: number): Promise<string[]>;
export function previewChatStream(
  botId: number,
  question: string,
  sessionId?: string | null,
  handlers?: {
    onChunk?: (text: string) => void;
    onFinal?: (meta: unknown) => void;
    onError?: (err: unknown) => void;
  },
): Promise<void>;

export function getClientSettings(botId?: number): Promise<Record<string, unknown>>;
export function updateClientSettings(
  settings: Record<string, unknown>,
  botId?: number,
): Promise<Record<string, unknown>>;
export function uploadLogo(file: File): Promise<{ url: string }>;
export function uploadDocuments(files: File[], botId?: number): Promise<unknown>;

export function completeOnboarding(): Promise<Record<string, unknown> | null>;
export function recordActivationEvent(
  eventType: string,
  opts?: { botId?: number | null; eventData?: unknown },
): Promise<void>;

export function getCurrentUser(): Promise<CurrentUser>;
export function getMyWorkspaces(): Promise<{ workspaces: Workspace[] }>;
export function getLeadStats(botId?: number): Promise<Record<string, unknown>>;
export function getOfflineMessages(params?: Record<string, unknown>): Promise<unknown>;
