import type { KnowledgeSource } from '../../../types/domain';

/** True when a source name is a crawled website (vs an uploaded file). */
export function isUrlSource(name: string): boolean {
  return name.startsWith('http://') || name.startsWith('https://');
}

/** Prepend https:// when the user typed a bare domain. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The registrable host for a source, used to detect "already added" sites. */
export function hostOf(name: string): string {
  return name
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

/** Number of learned units (pages for websites, pages/sections for documents). */
export function unitCountOf(source: KnowledgeSource): number {
  if (isUrlSource(source.name)) return source.page_count ?? 0;
  return source.doc_page_count ?? source.chunk_count ?? 0;
}

/** Human label for a source's size, e.g. "12 pages" / "4 sections". */
export function unitLabelOf(source: KnowledgeSource): string {
  const n = unitCountOf(source);
  if (isUrlSource(source.name)) return `${n} page${n === 1 ? '' : 's'}`;
  const unit = source.doc_page_count != null ? 'page' : 'section';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Sum of website pages across all crawled sources. */
export function totalWebsitePages(sources: readonly KnowledgeSource[]): number {
  return sources.reduce((sum, s) => sum + (isUrlSource(s.name) ? s.page_count ?? 0 : 0), 0);
}

/** Short relative date, e.g. "Today", "3 days ago", or a date fallback. */
export function formatRelativeDate(iso?: string): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Most recent ingestion timestamp across all sources, or undefined. */
export function lastUpdatedIso(sources: readonly KnowledgeSource[]): string | undefined {
  let latest: number | null = null;
  for (const s of sources) {
    if (!s.ingested_at) continue;
    const t = new Date(s.ingested_at).getTime();
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? undefined : new Date(latest).toISOString();
}

// Upload constraints - mirror the legacy KnowledgeBase limits so the UI rejects
// files the backend would reject anyway (api/app/api/ingestion routes).
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'] as const;
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface FileFilterResult {
  accepted: File[];
  rejected: string[];
}

/** Keep only supported, within-size files; report why the rest were dropped. */
export function filterUploadFiles(fileList: FileList | File[]): FileFilterResult {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of Array.from(fileList)) {
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    const supported =
      SUPPORTED_MIME_TYPES.has(file.type) ||
      (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
    if (!supported) {
      rejected.push(`${file.name} - unsupported file type`);
      continue;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      rejected.push(`${file.name} - larger than 10 MB`);
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}
